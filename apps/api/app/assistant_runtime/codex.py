"""Codex Local implementation of the Media Assistant runtime seam.

This is a thin adapter over ``enhancement_provider.run_codex_local_chat`` and
the Codex App Server session helpers. All Codex-specific behavior (threads,
compaction, process reuse, credential isolation) stays in
``codex_local_provider``. Provider calls are resolved through the
``enhancement_provider`` module at call time so existing monkeypatching keeps
working.
"""

from __future__ import annotations

from typing import Any, Dict

from .. import enhancement_provider
from . import (
    RuntimeCapabilities,
    StepRequest,
    StepResult,
    register_runtime,
)


def _clean(value: Any) -> str:
    return str(value or "").strip()


def step_result_from_codex(result: Dict[str, Any]) -> StepResult:
    """Normalize ``run_codex_local_chat`` output. Tolerates missing keys."""
    compaction = result.get("compaction")
    return StepResult(
        text=str(result.get("generated_text") or ""),
        provider_state=_clean(result.get("provider_thread_id")) or None,
        provider_turn_id=_clean(result.get("provider_turn_id")) or None,
        usage=dict(result.get("usage") or {}),
        latency_ms=result.get("latency_ms"),
        prompt_bytes=result.get("prompt_bytes"),
        reasoning_effort=_clean(result.get("reasoning_effort")) or None,
        client_message_id=_clean(result.get("client_user_message_id")) or None,
        compaction=dict(compaction) if isinstance(compaction, dict) else None,
        lifecycle=[str(event) for event in result.get("thread_lifecycle") or [] if str(event)],
        process_lifecycle=result.get("process_lifecycle"),
        reuse_mode=result.get("reuse_mode"),
    )


class CodexLocalRuntime:
    kind = "codex_local"
    capabilities = RuntimeCapabilities(
        structured_output=True,
        vision=True,
        provider_managed_state=True,
        compaction=True,
    )

    def run_step(self, request: StepRequest) -> StepResult:
        kwargs: Dict[str, Any] = {
            "model_id": request.model_id,
            "messages": request.messages,
            "response_format": request.response_schema,
            "error_context": request.error_context,
            "timeout_seconds": request.timeout_seconds,
            "unbounded_turn": request.unbounded,
            "cancel_event": request.cancel_event,
        }
        if request.session_key is not None:
            # Stateful kernel step: thread continuity, compaction and resume.
            kwargs.update(
                codex_session_key=request.session_key,
                provider_thread_id=request.provider_state,
                thread_base_instructions=request.base_instructions,
                thread_developer_instructions=request.developer_instructions,
                reasoning_effort=request.reasoning_effort,
                client_user_message_id=request.client_message_id,
                compact_before_turn=request.compact_before_turn,
                on_compaction=request.on_compaction,
                resume_usage=request.resume_usage,
            )
        return step_result_from_codex(enhancement_provider.run_codex_local_chat(**kwargs))

    def was_interrupted(self, error: BaseException) -> bool:
        return isinstance(
            getattr(error, "__cause__", None),
            enhancement_provider.codex_local_provider.CodexLocalProviderCancelled,
        )

    def close_session(self, session_key: str) -> None:
        enhancement_provider.codex_local_provider.close_codex_local_skill_session(session_key)

    def archive_session(self, session_key: str, provider_state: str) -> bool:
        return bool(
            enhancement_provider.codex_local_provider.archive_codex_local_thread(
                session_key=session_key,
                thread_id=provider_state,
            )
        )


CODEX_LOCAL_RUNTIME = CodexLocalRuntime()
register_runtime(CODEX_LOCAL_RUNTIME)
