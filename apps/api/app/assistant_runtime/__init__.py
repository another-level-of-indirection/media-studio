"""Provider-neutral runtime seam for the Media Assistant kernel.

The kernel drives its own tool loop. Per iteration it asks a runtime for one
schema-constrained JSON "step", executes the requested tool in-process, and
feeds the result back. A runtime therefore only has to provide:

* structured (JSON-schema) output for a single step,
* conversation memory between steps (provider-managed or adapter-managed),
* optional context compaction,
* cooperative cancellation,
* optional image input for visual analysis, and
* usage/trace data.

Everything else (tools, approvals, plans, graph edits, provenance) stays in
``app.assistant``. See ``docs/assistant-runtime-contract.md``.

Error contract: ``run_step`` raises ``enhancement_provider.EnhancementProviderError``
(or a subclass) for any provider failure, including cancellation. Use
``was_interrupted`` to distinguish a provider-side interrupt from other errors.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from threading import Event
from typing import Any, Callable, Dict, List, Optional, Protocol, runtime_checkable

from ..enhancement_provider import EnhancementProviderError

# Documented alias: adapters raise this (or a subclass) from ``run_step``.
RuntimeStepError = EnhancementProviderError


class RuntimeInterrupted(Exception):
    """Set as ``__cause__`` of a ``RuntimeStepError`` when Stop interrupted a call."""


@dataclass(frozen=True)
class RuntimeCapabilities:
    """What a runtime can do. The kernel gates features on these flags."""

    structured_output: bool
    """Honors a strict JSON schema, required to drive the tool-capable kernel."""
    vision: bool
    """Accepts image inputs, required for reference and output analysis."""
    provider_managed_state: bool
    """Remembers earlier turns server-side; the kernel sends only deltas."""
    compaction: bool
    """Can shrink its context on request (``StepRequest.compact_before_turn``)."""


@dataclass(frozen=True)
class RuntimeConnection:
    """Endpoint settings for runtimes that call a remote API.

    Process-based runtimes (Codex Local) ignore this and use their own login.
    """

    base_url: Optional[str] = None
    api_key: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None


def connection_from_settings(runtime_settings: Any) -> RuntimeConnection:
    """Build a connection from an ``AssistantProviderRuntime``-like object."""
    return RuntimeConnection(
        base_url=getattr(runtime_settings, "provider_base_url", None),
        api_key=getattr(runtime_settings, "api_key", None),
        temperature=getattr(runtime_settings, "temperature", None),
        max_tokens=getattr(runtime_settings, "max_tokens", None),
    )


@dataclass
class StepRequest:
    """One provider call: a single schema-constrained step or analysis."""

    model_id: str
    messages: List[Dict[str, Any]]
    response_schema: Optional[Dict[str, Any]] = None
    error_context: str = "media assistant kernel"
    timeout_seconds: Optional[float] = None
    unbounded: bool = True
    cancel_event: Optional[Event] = None
    connection: RuntimeConnection = field(default_factory=RuntimeConnection)
    # Stateful session fields. ``session_key is None`` means a stateless,
    # one-shot call (used by visual analysis).
    session_key: Optional[str] = None
    provider_state: Optional[str] = None
    base_instructions: Optional[str] = None
    developer_instructions: Optional[str] = None
    reasoning_effort: Optional[str] = None
    client_message_id: Optional[str] = None
    compact_before_turn: bool = False
    resume_usage: Optional[Dict[str, Any]] = None
    on_compaction: Optional[Callable[[bool], None]] = None


@dataclass
class StepResult:
    """Normalized provider response consumed by the kernel and trace builders."""

    text: str
    """Model output; JSON matching ``response_schema`` when one was given."""
    provider_state: Optional[str] = None
    """Opaque continuity handle persisted as ``session.provider_thread_id``."""
    provider_turn_id: Optional[str] = None
    usage: Dict[str, Any] = field(default_factory=dict)
    latency_ms: Optional[int] = None
    prompt_bytes: Optional[int] = None
    reasoning_effort: Optional[str] = None
    client_message_id: Optional[str] = None
    compaction: Optional[Dict[str, Any]] = None
    lifecycle: List[str] = field(default_factory=list)
    process_lifecycle: Optional[str] = None
    reuse_mode: Optional[str] = None

    def trace_fields(self) -> Dict[str, Any]:
        """Fields shared with ``AssistantKernelProviderTrace``."""
        return {
            "provider_turn_id": self.provider_turn_id,
            "process_lifecycle": self.process_lifecycle,
            "reuse_mode": self.reuse_mode,
            "usage": dict(self.usage),
            "latency_ms": self.latency_ms,
            "prompt_bytes": self.prompt_bytes,
            "reasoning_effort": self.reasoning_effort,
            "client_user_message_id": self.client_message_id,
            "compaction": self.compaction,
        }


@runtime_checkable
class AssistantRuntime(Protocol):
    kind: str
    capabilities: RuntimeCapabilities

    def run_step(self, request: StepRequest) -> StepResult:
        """Run one step. Raise ``RuntimeStepError`` on any provider failure."""

    def was_interrupted(self, error: BaseException) -> bool:
        """True when ``error`` came from a provider-side interrupt (Stop)."""

    def close_session(self, session_key: str) -> None:
        """Release any live process or cache held for ``session_key``."""

    def archive_session(self, session_key: str, provider_state: str) -> bool:
        """Archive the provider-side conversation. False when unavailable."""


_RUNTIMES: Dict[str, AssistantRuntime] = {}


def register_runtime(runtime: AssistantRuntime) -> None:
    _RUNTIMES[runtime.kind] = runtime


def get_registered_kinds() -> frozenset:
    return frozenset(_RUNTIMES)


def unregister_runtime(kind: str) -> None:
    _RUNTIMES.pop(kind, None)


def _ensure_builtin_runtimes() -> None:
    if "codex_local" not in _RUNTIMES:
        from . import codex  # noqa: F401  (registers itself on import)
    from .openai_compatible import register_experimental_runtimes

    register_experimental_runtimes()


def get_assistant_runtime(kind: Optional[str]) -> Optional[AssistantRuntime]:
    _ensure_builtin_runtimes()
    return _RUNTIMES.get(str(kind or "").strip())


def runtime_supports_kernel(kind: Optional[str]) -> bool:
    runtime = get_assistant_runtime(kind)
    return bool(runtime and runtime.capabilities.structured_output)


def runtime_supports_vision(kind: Optional[str]) -> bool:
    runtime = get_assistant_runtime(kind)
    return bool(runtime and runtime.capabilities.vision and runtime.capabilities.structured_output)
