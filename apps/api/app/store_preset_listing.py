"""Full and compact preset catalog reads share ordering, search and paging."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from .db import get_connection
from .store_preset_search import normalize_search_text, preset_search_sql
from .store_support import decode_row


PRESET_SUMMARY_COLUMNS = """
    preset_id, key, label, description, category, status, model_key, source_kind,
    base_builtin_key, applies_to_models_json, applies_to_task_modes_json,
    applies_to_input_patterns_json, requires_image, requires_video, requires_audio,
    thumbnail_path, thumbnail_url, version, priority, created_at, updated_at,
    json_array_length(COALESCE(input_schema_json, '[]')) AS input_schema_count,
    json_array_length(COALESCE(input_slots_json, '[]')) AS input_slots_count,
    CASE WHEN EXISTS (
        SELECT 1 FROM json_each(COALESCE(input_slots_json, '[]'))
        WHERE CASE WHEN type = 'object' THEN json_extract(value, '$.required') ELSE 0 END
    ) THEN 'required' WHEN json_array_length(COALESCE(input_slots_json, '[]')) > 0
      THEN 'optional' ELSE 'none' END AS image_input_policy
"""


def list_presets(*, summary: bool = False) -> List[Dict[str, Any]]:
    columns = PRESET_SUMMARY_COLUMNS if summary else "*"
    with get_connection() as connection:
        rows = connection.execute(
            f"SELECT {columns} FROM media_presets WHERE status != 'archived' ORDER BY priority DESC, updated_at DESC, key ASC"
        ).fetchall()
    return [decode_row(row) for row in rows]


def list_presets_page(
    *,
    limit: int = 60,
    offset: int = 0,
    q: Optional[str] = None,
    category: Optional[str] = None,
    status: str = "active",
    summary: bool = False,
) -> Dict[str, Any]:
    safe_limit = max(1, min(int(limit or 60), 100))
    safe_offset = max(0, int(offset or 0))
    clauses: List[str] = []
    params: List[Any] = []
    normalized_status = (status or "active").strip().lower()
    if normalized_status == "all":
        clauses.append("1 = 1")
    elif normalized_status == "archived":
        clauses.append("status = ?")
        params.append("archived")
    else:
        clauses.append("status != ?")
        params.append("archived")
    search_clause, search_params, search_order, order_params = preset_search_sql(q)
    if search_clause:
        clauses.append(search_clause)
        params.extend(search_params)
    normalized_category = (category or "").strip().lower()
    if normalized_category and normalized_category != "all":
        clauses.append("lower(COALESCE(category, 'general')) = ?")
        params.append(normalized_category)
    where_sql = " AND ".join(clauses)
    columns = PRESET_SUMMARY_COLUMNS if summary else "*"
    with get_connection() as connection:
        connection.create_function("preset_search_normalize", 1, normalize_search_text, deterministic=True)
        total_row = connection.execute(f"SELECT COUNT(*) AS total FROM media_presets WHERE {where_sql}", params).fetchone()
        rows = connection.execute(
            f"""
            SELECT {columns}
            FROM media_presets
            WHERE {where_sql}
            ORDER BY {search_order}priority DESC, updated_at DESC, key ASC
            LIMIT ? OFFSET ?
            """,
            [*params, *order_params, safe_limit, safe_offset],
        ).fetchall()
    total = int(total_row["total"] if total_row else 0)
    items = [decode_row(row) for row in rows]
    next_offset = safe_offset + len(items) if safe_offset + len(items) < total else None
    return {"items": items, "total": total, "limit": safe_limit, "offset": safe_offset, "next_offset": next_offset}
