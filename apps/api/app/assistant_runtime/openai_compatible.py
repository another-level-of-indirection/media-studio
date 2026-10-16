"""Experimental client-managed-state runtime for OpenAI-compatible endpoints.

Prototype of a second ``AssistantRuntime``. Unlike Codex Local, an
OpenAI-compatible chat endpoint keeps no conversation between calls, so this
adapter owns the transcript: it persists the message log, replays it on every
step, and trims it when asked to compact. The kernel is unchanged; it keeps
sending deltas and persisting ``provider_state`` (here a transcript id).

Disabled unless ``MEDIA_ASSISTANT_EXPERIMENTAL_RUNTIMES`` lists the provider
kind (for example ``local_openai`` or ``openrouter``). ``merge_gateway`` is
enabled by ``MEDIA_ASSISTANT_PROVIDER=merge_gateway`` and configured from the
``MERGE_*`` environment (see ``env_providers``). Known limits:

* Compaction drops the oldest messages instead of summarizing them.
* Strict JSON-schema output depends on the endpoint/model; invalid JSON is
  reported as a step error rather than repaired.
* Vision is off by default because many local models are text-only; it is on
  for ``merge_gateway`` (Claude).
* Cancellation abandons the in-flight HTTP request (it cannot be aborted).
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .. import codex_local_provider, enhancement_provider
from ..settings import settings
from ..store_support import new_id
from .env_providers import ANTHROPIC_SCHEMA_KINDS, PROMPT_CACHE_KINDS, VISION_PROVIDER_KINDS, selected_env_provider
from .resilience import call_with_retries
from . import (
    RuntimeCapabilities,
    RuntimeInterrupted,
    StepRequest,
    StepResult,
    get_registered_kinds,
    register_runtime,
)

SUPPORTED_KINDS = ("local_openai", "openrouter", "merge_gateway")
_STATE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)


def transcripts_dir() -> Path:
    return settings.data_root / "runtime" / "assistant-transcripts"


def _run_cancellable(
    call: Callable[[], Dict[str, Any]],
    *,
    cancel_event: Any,
    timeout_seconds: Optional[float],
) -> Dict[str, Any]:
    box: Dict[str, Any] = {}
    done = threading.Event()

    def target() -> None:
        try:
            box["value"] = call()
        except BaseException as exc:  # noqa: BLE001 - re-raised on the caller thread
            box["error"] = exc
        finally:
            done.set()

    threading.Thread(target=target, name="assistant-openai-step", daemon=True).start()
    deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
    while not done.wait(0.1):
        if cancel_event is not None and cancel_event.is_set():
            raise enhancement_provider.EnhancementProviderError(
                "The assistant turn was interrupted."
            ) from RuntimeInterrupted()
        if deadline is not None and time.monotonic() > deadline:
            raise enhancement_provider.EnhancementProviderError(
                "The provider timed out while waiting for a response."
            )
    if "error" in box:
        raise box["error"]
    return box["value"]


def _wire_message(message: Dict[str, Any]) -> Dict[str, Any]:
    """The kernel's ``tool`` messages are plain results, not OpenAI tool calls.

    A ``tool`` message with no preceding ``tool_calls`` is invalid on the wire
    (Merge Gateway answers 500), so send it as a user message. The content is
    already labelled as an untrusted tool result by the kernel.
    """
    return {**message, "role": "user"} if message.get("role") == "tool" else message


def _inline_refs(node: Any, defs: Dict[str, Any], stack: Tuple[str, ...] = ()) -> Any:
    """Replace ``$ref`` with the referenced definition.

    Some gateways (Merge Gateway to Claude) silently ignore a schema that uses
    ``$defs``/``$ref`` and answer in a free-form shape. A cyclic reference is
    left unconstrained rather than expanded forever.
    """
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            name = ref.rsplit("/", 1)[-1]
            if name in stack or name not in defs:
                return {}
            return _inline_refs(defs[name], defs, (*stack, name))
        return {key: _inline_refs(value, defs, stack) for key, value in node.items() if key != "$defs"}
    if isinstance(node, list):
        return [_inline_refs(item, defs, stack) for item in node]
    return node


_CONSTRAINT_KEYS = (
    "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum",
    "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
)


def _strip_constraints(node: Any) -> Any:
    """Drop size/range keywords that Anthropic's structured output rejects.

    The kernel re-validates every step with Pydantic, so the limits still hold;
    they are kept as a hint in the field description.
    """
    if isinstance(node, dict):
        hints = [f"{key}={node[key]}" for key in _CONSTRAINT_KEYS if key in node]
        cleaned = {key: _strip_constraints(value) for key, value in node.items() if key not in _CONSTRAINT_KEYS}
        if hints and isinstance(cleaned.get("type"), str):
            note = f"Limits: {', '.join(hints)}."
            cleaned["description"] = f"{cleaned['description']} {note}" if cleaned.get("description") else note
        return cleaned
    if isinstance(node, list):
        return [_strip_constraints(item) for item in node]
    return node


def _strict_response_format(
    response_format: Optional[Dict[str, Any]], *, strip_constraints: bool = False
) -> Optional[Dict[str, Any]]:
    """Normalize a Pydantic JSON schema for strict structured-output endpoints.

    Reuses the Codex normalizer (all properties required, no additional
    properties) because strict mode on OpenAI-style APIs has the same rules.
    """
    if not response_format or response_format.get("type") != "json_schema":
        return response_format
    payload = response_format.get("json_schema")
    schema = payload.get("schema") if isinstance(payload, dict) else None
    if not isinstance(schema, dict):
        return response_format
    normalized = codex_local_provider._normalize_strict_json_schema(schema)
    if strip_constraints:
        normalized = _strip_constraints(normalized)
    return {
        **response_format,
        "json_schema": {
            **payload,
            "schema": _inline_refs(normalized, normalized.get("$defs") or {}),
        },
    }


def _json_text(text: str) -> str:
    cleaned = text.strip()
    fenced = _FENCE.match(cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
    json.loads(cleaned)  # raises ValueError when not JSON
    return cleaned


class OpenAICompatibleRuntime:
    """Client-managed-state runtime over ``/chat/completions``."""

    # Kernel steps (plans, drafts) routinely exceed the 900-token chat default.
    STEP_MIN_MAX_TOKENS = 4000
    # Rough replay budget before ``compact_before_turn`` trims old turns.
    COMPACTION_CHAR_BUDGET = 240_000
    # Compaction trims down to this share of the budget. Trimming only to the
    # budget would re-trim every turn, and each trim changes the replayed
    # prefix and so invalidates the provider's prompt cache.
    COMPACTION_TARGET_RATIO = 0.6

    def __init__(
        self,
        kind: str,
        *,
        vision: bool = False,
        strip_constraints: bool = False,
        prompt_cache: bool = False,
    ) -> None:
        self.kind = kind
        self.strip_constraints = strip_constraints
        self.prompt_cache = prompt_cache
        self.capabilities = RuntimeCapabilities(
            structured_output=True,
            vision=vision,
            provider_managed_state=False,
            compaction=True,
        )

    # -- transcript persistence -------------------------------------------------
    def _path(self, state_id: str) -> Optional[Path]:
        return transcripts_dir() / f"{state_id}.json" if _STATE_ID.match(state_id or "") else None

    def _load(self, state_id: Optional[str]) -> Optional[Dict[str, Any]]:
        path = self._path(str(state_id or ""))
        if path is None or not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return payload if isinstance(payload, dict) and isinstance(payload.get("messages"), list) else None

    def _save(self, state_id: str, payload: Dict[str, Any]) -> None:
        path = self._path(state_id)
        if path is None:
            raise enhancement_provider.EnhancementProviderError("Invalid assistant transcript id.")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)

    def _open_transcript(self, request: StepRequest) -> Tuple[str, Dict[str, Any], List[str], str]:
        instructions = {
            "base": request.base_instructions or "",
            "developer": request.developer_instructions or "",
        }
        existing = self._load(request.provider_state)
        usable = (
            existing is not None
            and existing.get("session_key") == request.session_key
            and existing.get("instructions") == instructions
        )
        if usable:
            return str(request.provider_state), existing, ["thread_resumed"], "client_replay"
        lifecycle = ["thread_started"]
        reuse_mode = "new_thread"
        if request.provider_state:
            lifecycle = ["thread_resume_failed", "thread_replaced"]
            reuse_mode = "replacement_thread"
        transcript = {
            "session_key": request.session_key,
            "instructions": instructions,
            "messages": [],
        }
        return new_id("transcript"), transcript, lifecycle, reuse_mode

    def _instruction_messages(self, instructions: Dict[str, str]) -> List[Dict[str, Any]]:
        parts = [part for part in (instructions.get("base"), instructions.get("developer")) if part]
        if not parts:
            return []
        text = "\n\n".join(parts)
        if not self.prompt_cache:
            return [{"role": "system", "content": text}]
        # The instructions are ~40k tokens and identical across sessions. Marking
        # them lets every new session read them from cache instead of paying full price.
        block = {"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}
        return [{"role": "system", "content": [block]}]

    def _compact(self, messages: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
        """Drop the oldest whole turns (a turn starts at a ``user`` message).

        Cutting on turn boundaries keeps tool results with the step that asked
        for them and keeps the transcript starting on a user message. The latest
        turn is never cut, so one oversized turn can stay over budget.
        """

        def size(items: List[Dict[str, Any]]) -> int:
            return len(json.dumps(items, separators=(",", ":")))

        if size(messages) <= self.COMPACTION_CHAR_BUDGET:
            return messages, None
        target = int(self.COMPACTION_CHAR_BUDGET * self.COMPACTION_TARGET_RATIO)
        starts = [index for index, message in enumerate(messages) if message.get("role") == "user"]
        trimmed = list(messages)
        for next_start in starts[1:]:
            if size(trimmed) <= target:
                break
            trimmed = messages[next_start:]
        if len(trimmed) == len(messages):
            return messages, None
        return trimmed, {
            "outcome": "completed",
            "strategy": "drop_oldest_turns",
            "dropped_messages": len(messages) - len(trimmed),
        }

    # -- AssistantRuntime -------------------------------------------------------
    def run_step(self, request: StepRequest) -> StepResult:
        started = time.perf_counter()
        base_url = (request.connection.base_url or "").strip()
        if not base_url:
            raise enhancement_provider.EnhancementProviderError(
                f"{self.kind} has no endpoint configured for the Media Assistant."
            )
        stateful = request.session_key is not None
        lifecycle: List[str] = []
        reuse_mode: Optional[str] = None
        state_id: Optional[str] = None
        transcript: Dict[str, Any] = {"instructions": {}, "messages": []}
        if stateful:
            state_id, transcript, lifecycle, reuse_mode = self._open_transcript(request)
        history = list(transcript["messages"])
        compaction = None
        if stateful and request.compact_before_turn:
            if request.on_compaction:
                request.on_compaction(True)
            try:
                history, compaction = self._compact(history)
            finally:
                if request.on_compaction:
                    request.on_compaction(False)
        outbound = [
            *(self._instruction_messages(transcript["instructions"]) if stateful else []),
            *(_wire_message(message) for message in (*history, *request.messages)),
        ]
        max_tokens = max(int(request.connection.max_tokens or 0), self.STEP_MIN_MAX_TOKENS)
        result = _run_cancellable(
            lambda: call_with_retries(lambda: enhancement_provider.run_openai_compatible_chat(
                provider_kind=self.kind,
                base_url=base_url,
                api_key=request.connection.api_key,
                model_id=request.model_id,
                messages=outbound,
                temperature=request.connection.temperature,
                max_tokens=max_tokens,
                response_format=_strict_response_format(request.response_schema, strip_constraints=self.strip_constraints),
                error_context=request.error_context,
            ), cancel_event=request.cancel_event),
            cancel_event=request.cancel_event,
            timeout_seconds=None if request.unbounded else request.timeout_seconds,
        )
        text = str(result.get("generated_text") or "").strip()
        if request.response_schema:
            try:
                text = _json_text(text)
            except ValueError as exc:
                raise enhancement_provider.EnhancementProviderError(
                    f"{self.kind} did not return valid JSON for the assistant step."
                ) from exc
        if stateful and state_id:
            transcript["messages"] = [
                *history,
                *request.messages,
                {"role": "assistant", "content": text},
            ]
            self._save(state_id, transcript)
        return StepResult(
            text=text,
            provider_state=state_id,
            usage=dict(result.get("usage") or {}),
            latency_ms=int((time.perf_counter() - started) * 1000),
            prompt_bytes=len(json.dumps(outbound, separators=(",", ":")).encode("utf-8")),
            client_message_id=request.client_message_id,
            compaction=compaction,
            lifecycle=lifecycle,
            process_lifecycle="no_process",
            reuse_mode=reuse_mode,
        )

    def was_interrupted(self, error: BaseException) -> bool:
        return isinstance(getattr(error, "__cause__", None), RuntimeInterrupted)

    def close_session(self, session_key: str) -> None:
        # No live process to release; transcripts are durable until archived.
        return None

    def archive_session(self, session_key: str, provider_state: str) -> bool:
        path = self._path(provider_state)
        transcript = self._load(provider_state)
        if path is None or transcript is None or transcript.get("session_key") != session_key:
            return False
        try:
            path.unlink()
        except OSError:
            return False
        return True


def register_experimental_runtimes(kinds: Optional[Tuple[str, ...]] = None) -> None:
    """Register flagged runtimes. Idempotent; unknown kinds are ignored."""
    enabled = settings.media_assistant_experimental_runtimes if kinds is None else kinds
    if kinds is None and selected_env_provider():
        enabled = (*enabled, selected_env_provider())
    registered = get_registered_kinds()
    for kind in enabled:
        if kind in SUPPORTED_KINDS and kind not in registered:
            register_runtime(OpenAICompatibleRuntime(kind, vision=kind in VISION_PROVIDER_KINDS, strip_constraints=kind in ANTHROPIC_SCHEMA_KINDS, prompt_cache=kind in PROMPT_CACHE_KINDS))
