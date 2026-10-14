"""Gallery continuation contracts with pure mocks; no app startup or databases."""
import ast
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Literal, Optional
import unittest
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1] / "apps/api/app"


def record(index, created_at="2026-10-01T00:00:00Z"):
    return {"asset_id": f"asset-{index}", "job_id": f"job-{index}", "rowid": index + 1,
            "created_at": created_at, "model_key": "model", "status": "completed"}


@contextmanager
def asset_api(rows):
    connection = Mock()

    def execute(sql, params=()):
        if sql.startswith("SELECT created_at, rowid"):
            anchor = next((row for row in rows if row["asset_id"] == params[0]), None)
            return SimpleNamespace(fetchone=lambda: anchor)
        page = sorted(rows, key=lambda row: row["rowid"])
        page.sort(key=lambda row: row["created_at"], reverse=True)
        if "rowid > ?" in sql:
            timestamp, _, rowid = params[:3]
            page = [row for row in page if row["created_at"] < timestamp or
                    (row["created_at"] == timestamp and row["rowid"] > rowid)]
        elif "created_at < ?" in sql:
            page = [row for row in page if row["created_at"] < params[0]]
        return SimpleNamespace(fetchall=lambda: page[:params[-1]])

    connection.execute.side_effect = execute

    @contextmanager
    def get_connection():
        yield connection

    namespace = {"__name__": "_gallery_cursor_test", "app": FastAPI(), "Query": Query,
                 "BaseModel": BaseModel, "Field": Field, "Any": Any, "Dict": Dict,
                 "List": List, "Literal": Literal, "Optional": Optional,
                 "get_connection": get_connection, "_decode_row": dict,
                 "_bad_request": lambda message: HTTPException(status_code=400, detail=message)}
    # Compile the real store/schema/route functions without side-effectful imports.
    for filename, names in (
        ("store.py", {"list_assets", "_visible_in_global_gallery_clause", "_like_search_pattern"}),
        ("schemas.py", {"AssetRecord", "AssetListResponse"}),
    ):
        tree = ast.parse((ROOT / filename).read_text())
        definitions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
        exec(compile(ast.Module(body=definitions, type_ignores=[]), str(ROOT / filename), "exec"), namespace)
    namespace["store"] = SimpleNamespace(list_assets=namespace["list_assets"])
    route = next(node for node in ast.parse((ROOT / "main.py").read_text()).body
                 if isinstance(node, ast.FunctionDef) and node.name == "list_assets")
    exec(compile(ast.Module(body=[route], type_ignores=[]), str(ROOT / "main.py"), "exec"), namespace)
    with TestClient(namespace["app"]) as client:
        yield client, connection


class GalleryCursorTests(unittest.TestCase):
    def test_smaller_pages_keep_all_assets_when_a_timestamp_group_crosses_boundaries(self):
        rows = [record(i) for i in range(20)] + [record(i, "2026-09-01T00:00:00Z") for i in range(20, 30)]
        with asset_api(rows) as (client, connection):
            ids, cursor = [], None
            while True:
                params = {"limit": 12, "cursor_mode": "asset_id"}
                if cursor:
                    params["cursor"] = cursor
                response = client.get("/media/assets", params=params)
                self.assertEqual(response.status_code, 200, response.text)
                page = response.json()
                ids.extend(item["asset_id"] for item in page["items"])
                cursor = page["next_cursor"]
                if cursor is None:
                    break
            self.assertEqual(ids, [f"asset-{i}" for i in range(30)])
            page_calls = [call for call in connection.execute.call_args_list if "ORDER BY" in call.args[0]]
            self.assertEqual(len(page_calls), 3)
            for call in page_calls:
                self.assertIn("ORDER BY created_at DESC, rowid ASC LIMIT ?", call.args[0])
                self.assertEqual(call.args[1][-1], 13)
            self.assertIn("(created_at < ? OR (created_at = ? AND rowid > ?))", page_calls[1].args[0])
            self.assertEqual(page_calls[1].args[1][:3], [rows[11]["created_at"], rows[11]["created_at"], 12])

    def test_newer_and_same_timestamp_insertions_do_not_skip_existing_assets(self):
        rows = [record(i) for i in range(20)]
        with asset_api(rows) as (client, _):
            first = client.get("/media/assets?limit=12&cursor_mode=asset_id").json()
            rows.extend([record(20, "2026-10-02T00:00:00Z"), record(21)])
            second = client.get("/media/assets", params={"limit": 12, "cursor_mode": "asset_id", "cursor": first["next_cursor"]}).json()
            ids = [item["asset_id"] for item in first["items"] + second["items"]]
            self.assertEqual(ids, [f"asset-{i}" for i in range(20)] + ["asset-21"])
            self.assertEqual(len(ids), len(set(ids)))

    def test_legacy_timestamp_cursor_and_tie_order_remain_unchanged(self):
        rows = [record(i) for i in range(20)] + [record(20, "2026-09-01T00:00:00Z")]
        with asset_api(rows) as (client, connection):
            first = client.get("/media/assets?limit=12").json()
            self.assertEqual(first["next_cursor"], rows[0]["created_at"])
            second = client.get("/media/assets", params={"limit": 12, "cursor": first["next_cursor"]}).json()
            self.assertEqual([item["asset_id"] for item in second["items"]], ["asset-20"])
            self.assertIn("ORDER BY created_at DESC LIMIT ?", connection.execute.call_args.args[0])
            self.assertNotIn("rowid >", connection.execute.call_args.args[0])

    def test_removed_or_unknown_anchor_returns_explicit_restart_error(self):
        rows = [record(i) for i in range(20)]
        with asset_api(rows) as (client, connection):
            first = client.get("/media/assets?limit=12&cursor_mode=asset_id").json()
            rows[:] = [row for row in rows if row["asset_id"] != first["next_cursor"]]
            for cursor in (first["next_cursor"], "unknown"):
                connection.execute.reset_mock()
                response = client.get("/media/assets", params={"cursor_mode": "asset_id", "cursor": cursor})
                self.assertEqual(response.status_code, 400)
                self.assertIn("Reload the gallery", response.json()["detail"])
                self.assertEqual(connection.execute.call_count, 1)

    def test_invalid_mode_is_rejected_before_store_access(self):
        with asset_api([]) as (client, connection):
            self.assertEqual(client.get("/media/assets?cursor_mode=unknown").status_code, 422)
            connection.execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
