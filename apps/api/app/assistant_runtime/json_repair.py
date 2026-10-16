"""Deterministic repair of almost-JSON tool arguments.

Smaller models often write a tool call's ``arguments`` string as a Python dict
(single quotes, ``True``/``None``), with unquoted keys, trailing commas, a code
fence, or raw newlines inside strings. The step schema cannot constrain that
string, and asking the model to fix it tends to repeat the same mistake, so the
common cases are repaired locally. Only a result that decodes to an object is
accepted, and nothing here changes what the arguments mean.
"""

from __future__ import annotations

import ast
import json
import re
from typing import Any, Dict, Optional

_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)
_TRAILING_COMMA = re.compile(r",\s*([}\]])")
_BARE_KEY = re.compile(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)")


def _as_object(value: Any) -> Optional[Dict[str, Any]]:
    return value if isinstance(value, dict) else None


def repair_json_object(text: Any) -> Optional[Dict[str, Any]]:
    """Return the object ``text`` was meant to be, or ``None`` when unsure."""
    if not isinstance(text, str):
        return None
    cleaned = text.strip()
    fenced = _FENCE.match(cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
    if not cleaned.startswith("{"):
        return None
    attempts = [cleaned, _TRAILING_COMMA.sub(r"\1", cleaned)]
    for candidate in attempts:
        try:
            decoded = _as_object(json.loads(candidate, strict=False))  # strict=False allows raw newlines
        except ValueError:
            decoded = None
        if decoded is not None:
            return decoded
        try:
            decoded = _as_object(ast.literal_eval(candidate))  # single quotes, True/False/None
        except (ValueError, SyntaxError, MemoryError, RecursionError):
            decoded = None
        if decoded is not None:
            return decoded
    quoted = _BARE_KEY.sub(r'\1"\2"\3', attempts[1])
    try:
        return _as_object(json.loads(quoted, strict=False))
    except ValueError:
        return None
