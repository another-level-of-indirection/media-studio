"""Retry for transient provider failures (gateway 5xx, rate limits, dropped connections)."""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, Optional

import httpx

from .. import enhancement_provider

RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504, 529})
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (1.0, 3.0)


def is_transient(error: BaseException) -> bool:
    if isinstance(error, httpx.TransportError):  # timeouts, resets, DNS
        return True
    return getattr(error, "status_code", None) in RETRYABLE_STATUS


def call_with_retries(
    call: Callable[[], Dict[str, Any]],
    *,
    cancel_event: Optional[Any] = None,
    attempts: int = MAX_ATTEMPTS,
    backoff: tuple = BACKOFF_SECONDS,
) -> Dict[str, Any]:
    """Run ``call``, retrying transient failures. Stops early when cancelled.

    Raw transport errors are converted to ``EnhancementProviderError`` so the
    kernel's error handling always sees the same type.
    """
    for attempt in range(1, attempts + 1):
        try:
            return call()
        except (enhancement_provider.EnhancementProviderError, httpx.TransportError) as exc:
            cancelled = cancel_event is not None and cancel_event.is_set()
            if not is_transient(exc) or attempt == attempts or cancelled:
                if isinstance(exc, httpx.TransportError):
                    raise enhancement_provider.EnhancementProviderError(
                        "The provider could not be reached."
                    ) from exc
                raise
            delay = backoff[min(attempt - 1, len(backoff) - 1)]
            if cancel_event is not None:
                if cancel_event.wait(delay):
                    raise
            else:
                time.sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover
