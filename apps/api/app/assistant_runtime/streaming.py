"""Streaming chat completions for the OpenAI-compatible runtime.

A non-streamed call cannot be aborted: when the user presses Stop the provider
keeps generating, and billing, until it finishes. A streamed call is cancelled
by closing the connection, which stops generation. Streaming also keeps the
connection active through long answers, so gateways do not time them out.

The kernel still waits for the whole JSON step before acting, so this does not
make a step finish sooner.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from .. import enhancement_provider
from ..enhancement_provider import EnhancementProviderError


def _failure(message: str, status_code: int) -> EnhancementProviderError:
    error = EnhancementProviderError(message)
    error.status_code = status_code  # transient by default, so the caller may retry
    return error


def stream_openai_compatible_chat(
    *,
    provider_kind: str,
    base_url: str,
    api_key: Optional[str],
    model_id: str,
    messages: List[Dict[str, Any]],
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    response_format: Optional[Dict[str, Any]] = None,
    error_context: str = "request",
    cancel_event: Optional[Any] = None,
) -> Dict[str, Any]:
    """Same result shape as ``run_openai_compatible_chat``, read from an SSE stream."""
    body: Dict[str, Any] = {
        "model": model_id,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if response_format:
        body["response_format"] = response_format
    pieces: List[str] = []
    usage: Dict[str, Any] = {}
    response_id: Optional[str] = None
    finished = False
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    with enhancement_provider._http_client() as client:
        with client.stream(
            "POST", endpoint, headers=enhancement_provider._openai_compatible_headers(api_key), json=body
        ) as response:
            if response.status_code >= 400:
                error = EnhancementProviderError(f"{provider_kind} {error_context} failed with {response.status_code}.")
                error.status_code = response.status_code
                raise error
            for line in response.iter_lines():
                if cancel_event is not None and cancel_event.is_set():
                    break  # leaving the context closes the connection and stops generation
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    finished = True
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if not isinstance(chunk, dict):
                    continue
                if chunk.get("error"):
                    raise _failure(f"{provider_kind} {error_context} failed mid-stream.", 502)
                response_id = response_id or str(chunk.get("id") or "").strip() or None
                if isinstance(chunk.get("usage"), dict):
                    usage = enhancement_provider._extract_usage_payload(chunk)
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") if isinstance(choice, dict) else None
                    if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                        pieces.append(delta["content"])
                    if isinstance(choice, dict) and choice.get("finish_reason"):
                        finished = True
    if cancel_event is not None and cancel_event.is_set():
        raise EnhancementProviderError("The assistant turn was interrupted.")
    if not finished:
        raise _failure(f"{provider_kind} {error_context} stream ended early.", 502)
    text = "".join(pieces).strip()
    if not text:
        raise EnhancementProviderError(f"{error_context.capitalize()} provider returned an empty response.")
    return {
        "provider_kind": provider_kind,
        "provider_model_id": model_id,
        "provider_base_url": base_url,
        "provider_response_id": response_id,
        "usage": usage,
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "total_tokens": usage.get("total_tokens"),
        "cost": usage.get("cost"),
        "generated_text": text,
        "warnings": [],
    }
