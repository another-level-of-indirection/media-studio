"""Assistant runtime backed by the user's local Claude Code (``claude -p``).

Each kernel step is one headless, tool-less ``claude -p`` call that answers
with structured output (``--json-schema``). Claude Code is used purely as a
model transport: every built-in tool, MCP server, skill, hook, settings file
and CLAUDE.md is switched off, and it runs in an empty directory, so the
assistant can only reply with the step JSON and cannot touch the machine.

State is client-managed, exactly like the OpenAI-compatible runtimes: this
adapter keeps the transcript and replays it as the prompt each step
(``--no-session-persistence``). That keeps compaction, instruction changes and
failed steps behaving the same as the other runtimes. Known limits:

* Sign-in is Claude Code's own (``claude auth login``); an expired OAuth
  session fails the step with a clear message and shows as "not ready".
* No vision: images cannot be passed through the text prompt.
* Claude Code adds its own small preamble to every request.
* Stop kills the process, so provider-side generation does stop.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .. import enhancement_provider
from ..settings import settings
from . import RuntimeInterrupted, StepRequest
from .openai_compatible import OpenAICompatibleRuntime, _strict_response_format
from .resilience import call_with_retries

_FALLBACK_PATHS = ("~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude")
_SYSTEM_PROMPT = (
    "You are the reasoning engine of an application. Follow the instructions and conversation in the "
    "user message and reply only with the structured JSON the schema asks for. You have no tools."
)
_NOT_SIGNED_IN = "Claude Code is not signed in. Run `claude auth login` in a terminal, then try again."
_TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504, 529}
_AUTH_CACHE_SECONDS = 30.0
_auth_cache: Dict[str, Any] = {"at": 0.0, "value": None}


def claude_binary() -> Optional[str]:
    configured = (settings.claude_code_bin or "").strip()
    if configured:
        return shutil.which(configured) or (configured if Path(configured).expanduser().is_file() else None)
    found = shutil.which("claude")
    if found:
        return found
    for candidate in _FALLBACK_PATHS:
        path = Path(candidate).expanduser()
        if path.is_file():
            return str(path)
    return None


def claude_code_ready() -> bool:
    """True when the CLI exists and is signed in. Cached briefly: /health polls this."""
    now = time.monotonic()
    if _auth_cache["value"] is not None and now - float(_auth_cache["at"]) < _AUTH_CACHE_SECONDS:
        return bool(_auth_cache["value"])
    binary = claude_binary()
    ready = False
    if binary:
        try:
            done = subprocess.run([binary, "auth", "status"], capture_output=True, text=True, timeout=10, check=False)
            ready = bool(json.loads(done.stdout or "{}").get("loggedIn"))
        except (OSError, ValueError, subprocess.SubprocessError):
            ready = False
    _auth_cache.update(at=now, value=ready)
    return ready


def _scratch_dir() -> Path:
    path = settings.data_root / "runtime" / "claude-code-cwd"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                parts.append(str(part.get("text") or ""))
            elif part.get("type") == "image_url":
                parts.append("[image omitted: this runtime has no vision]")
        return "\n".join(parts)
    return "" if content is None else str(content)


def render_prompt(messages: List[Dict[str, Any]]) -> str:
    """Instructions first, then the transcript, then the cue for the next step."""
    instructions = [_text_of(m.get("content")) for m in messages if m.get("role") == "system"]
    turns = [m for m in messages if m.get("role") != "system"]
    lines = ["\n\n".join(part for part in instructions if part), "", "=== CONVERSATION SO FAR ==="]
    for message in turns:
        lines += [f"[{message.get('role') or 'user'}]", _text_of(message.get("content")), ""]
    lines.append("=== END ===\nWrite the next assistant message now, as the JSON the schema requires.")
    return "\n".join(lines)


def _failure(result: Dict[str, Any]) -> enhancement_provider.EnhancementProviderError:
    message = str(result.get("result") or "Claude Code returned an error.").strip()
    status = result.get("api_error_status")
    if "authenticate" in message.lower() or "oauth" in message.lower() or status == 401:
        return enhancement_provider.EnhancementProviderError(_NOT_SIGNED_IN)
    error = enhancement_provider.EnhancementProviderError(f"Claude Code failed: {message[:300]}")
    if isinstance(status, int) and status in _TRANSIENT_STATUS:
        error.status_code = status  # lets call_with_retries retry it
    return error


def _parse_output(stdout: str) -> Dict[str, Any]:
    try:
        payload = json.loads(stdout)
    except ValueError as exc:
        raise enhancement_provider.EnhancementProviderError("Claude Code did not return JSON.") from exc
    if isinstance(payload, list):  # some versions emit the event list
        payload = next((item for item in reversed(payload) if isinstance(item, dict) and item.get("type") == "result"), {})
    if not isinstance(payload, dict):
        raise enhancement_provider.EnhancementProviderError("Claude Code did not return a result.")
    return payload


def _run_cli(
    command: List[str], prompt: str, *, cwd: Path, cancel_event: Any, timeout_seconds: Optional[float]
) -> Dict[str, Any]:
    try:
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=str(cwd), env={**os.environ, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"},
        )
    except OSError as exc:
        raise enhancement_provider.EnhancementProviderError(f"Claude Code could not be started: {exc}") from exc
    deadline = None if timeout_seconds is None else time.monotonic() + timeout_seconds
    pending: Optional[str] = prompt
    while True:
        try:
            stdout, stderr = process.communicate(input=pending, timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            pending = None  # input is already queued; only the first call may carry it
        if cancel_event is not None and cancel_event.is_set():
            process.kill()
            process.communicate()
            raise enhancement_provider.EnhancementProviderError("The assistant turn was interrupted.") from RuntimeInterrupted()
        if deadline is not None and time.monotonic() > deadline:
            process.kill()
            process.communicate()
            raise enhancement_provider.EnhancementProviderError("Claude Code timed out while waiting for a response.")
    payload = _parse_output(stdout) if stdout.strip() else {}
    if not payload:
        raise enhancement_provider.EnhancementProviderError(
            f"Claude Code exited with status {process.returncode}: {(stderr or '').strip()[:300]}"
        )
    if payload.get("is_error"):
        raise _failure(payload)
    return payload


class ClaudeCodeRuntime(OpenAICompatibleRuntime):
    endpoint_required = False

    def __init__(self, kind: str = "claude_code") -> None:
        super().__init__(kind, vision=False, strip_constraints=True)

    def _complete(self, request: StepRequest, outbound: List[Dict[str, Any]], base_url: str) -> Dict[str, Any]:
        binary = claude_binary()
        if not binary:
            raise enhancement_provider.EnhancementProviderError(
                "Claude Code was not found. Install it or set CLAUDE_CODE_BIN."
            )
        command = [
            binary, "-p", "--output-format", "json", "--no-session-persistence",
            "--tools", "", "--restricted", "--strict-mcp-config", "--disable-slash-commands",
            "--system-prompt", _SYSTEM_PROMPT, "--model", request.model_id,
        ]
        schema = _strict_response_format(request.response_schema, strip_constraints=True)
        if schema:
            command += ["--json-schema", json.dumps(schema["json_schema"]["schema"], separators=(",", ":"))]
        prompt = render_prompt(outbound)
        payload = call_with_retries(
            lambda: _run_cli(
                command, prompt, cwd=_scratch_dir(), cancel_event=request.cancel_event,
                timeout_seconds=None if request.unbounded else request.timeout_seconds,
            ),
            cancel_event=request.cancel_event,
        )
        structured = payload.get("structured_output")
        text = json.dumps(structured, separators=(",", ":")) if structured is not None else str(payload.get("result") or "")
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        prompt_tokens = sum(int(usage.get(key) or 0) for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
        completion_tokens = int(usage.get("output_tokens") or 0)
        return {
            "generated_text": text,
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
                "cost": payload.get("total_cost_usd"),
                "cache_read_tokens": int(usage.get("cache_read_input_tokens") or 0),
            },
        }
