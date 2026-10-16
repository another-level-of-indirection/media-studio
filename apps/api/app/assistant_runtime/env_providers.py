"""Environment-configured assistant providers: Merge Gateway and MTPLX.

These providers are not stored in AI Settings. They are selected with
``MEDIA_ASSISTANT_PROVIDER`` and configured with ``MERGE_API_KEY``,
``MERGE_MODEL`` and ``MERGE_BASE_URL`` (Merge) or ``MTPLX_BASE_URL``,
``MTPLX_MODEL`` and ``MTPLX_THINKING`` (a local MTPLX server, no key), or
``CLAUDE_CODE_BIN`` and ``CLAUDE_CODE_MODEL`` (the local Claude Code CLI, which owns its sign-in). The environment wins over any stored
Media Assistant model, because a stored Codex model id is meaningless to them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

from ..settings import settings

ENV_PROVIDER_KINDS = ("merge_gateway", "mtplx", "claude_code")
VISION_PROVIDER_KINDS = ("merge_gateway", "mtplx")  # both accept OpenAI-style image_url parts.
PROMPT_CACHE_KINDS = ("merge_gateway",)  # Anthropic caches only prefixes ending at a cache_control marker.
ANTHROPIC_SCHEMA_KINDS = ("merge_gateway",)  # Anthropic structured output rejects size/range keywords.


@dataclass(frozen=True)
class EnvProviderConfig:
    base_url: str
    api_key: Optional[str]
    model: Optional[str]
    key_required: bool = True
    extra_body: Optional[Dict[str, Any]] = None  # merged into every request body
    http_timeout: Optional[float] = None  # seconds; None keeps the default

    def as_runtime(self) -> Dict[str, Any]:
        return {"base_url": self.base_url, "api_key": self.api_key, "credential_source": "environment"}


def selected_env_provider() -> Optional[str]:
    kind = (settings.media_assistant_provider or "").strip()
    return kind if kind in ENV_PROVIDER_KINDS else None


def normalize_merge_base_url(value: Optional[str]) -> str:
    """Use the ``/v1/openai`` surface.

    Merge's plain ``/v1`` chat route returns strict-JSON answers as a tool call
    with empty content, which the kernel cannot read. ``/v1/openai`` returns
    them as message content.
    """
    base = (value or "").strip().rstrip("/") or "https://api-gateway.merge.dev/v1/openai"
    return f"{base}/openai" if base.endswith("/v1") else base


def env_provider_config(kind: Optional[str]) -> Optional[EnvProviderConfig]:
    if kind == "mtplx":
        # Local server: no key, and a 27B model can take minutes to prefill a long prompt.
        return EnvProviderConfig(
            base_url=(settings.mtplx_base_url or "").strip().rstrip("/"),
            api_key=None,
            model=(settings.mtplx_model or "").strip() or "mtplx",
            key_required=False,
            extra_body={"chat_template_kwargs": {"enable_thinking": bool(settings.mtplx_thinking)}},
            http_timeout=900.0,
        )
    if kind == "claude_code":
        # The local CLI owns its own sign-in; there is no endpoint or key here.
        return EnvProviderConfig(
            base_url="", api_key=None, model=(settings.claude_code_model or "").strip() or "sonnet",
            key_required=False, http_timeout=900.0,
        )
    if kind != "merge_gateway":
        return None
    return EnvProviderConfig(
        base_url=normalize_merge_base_url(settings.merge_base_url),
        api_key=(settings.merge_api_key or "").strip() or None,
        model=(settings.merge_model or "").strip() or None,
    )


def resolve_provider_kind(*candidates: Any) -> str:
    """The env override, else the first stored/session kind that is allowed."""
    override = selected_env_provider()
    if override:
        return override
    from ..service_provider_config import PROMPT_RECIPE_DRAFTING_PROVIDERS

    for candidate in candidates:
        kind = str(candidate or "").strip()
        if kind in PROMPT_RECIPE_DRAFTING_PROVIDERS:
            return kind
        if kind:
            break
    return "codex_local"


def assistant_runtime_readiness(codex_ready: bool) -> Dict[str, Any]:
    """Which runtime the assistant will use and whether it can run now."""
    from ..assistant.provider_support import (
        AssistantProviderChatError,
        configured_assistant_provider,
        resolve_assistant_provider_runtime,
    )

    kind, _ = configured_assistant_provider({})
    if kind == "codex_local":
        return {"kind": kind, "ready": bool(codex_ready)}
    if kind == "claude_code":
        from .claude_code import claude_code_ready

        return {"kind": kind, "ready": claude_code_ready()}
    try:
        resolve_assistant_provider_runtime({})
    except AssistantProviderChatError:
        return {"kind": kind, "ready": False}
    from . import get_assistant_runtime

    return {"kind": kind, "ready": get_assistant_runtime(kind) is not None}
