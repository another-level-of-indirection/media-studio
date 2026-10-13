"""Preset HTTP/projection contracts without app startup or database construction."""
import ast
from contextlib import contextmanager
import importlib
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, List, Optional
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI, Query
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field, model_validator

ROOT = Path(__file__).resolve().parents[1] / "apps/api/app"
PACKAGE = "_studio_preset_test_app"


def summary(index=0):
    return {"preset_id": f"preset-{index}", "key": f"older-{index}", "label": f"Older {index}",
            "status": "active", "model_key": "gpt-image-2-image-to-image",
            "applies_to_models_json": '["gpt-image-2-image-to-image"]',
            "input_schema_count": 2, "input_slots_count": 1, "image_input_policy": "required"}


@contextmanager
def preset_api(rows):
    package = ModuleType(PACKAGE)
    package.__path__ = [str(ROOT)]
    connection = Mock()
    connection.execute.side_effect = lambda sql, params=(): SimpleNamespace(
        fetchall=lambda: rows, fetchone=lambda: {"total": 752})

    @contextmanager
    def get_connection():
        yield connection

    db = ModuleType(f"{PACKAGE}.db")
    db.get_connection = get_connection
    with patch.dict(sys.modules, {PACKAGE: package, db.__name__: db}):
        listing = importlib.import_module(f"{PACKAGE}.store_preset_listing")
        app = FastAPI()
        namespace = {"__name__": "_preset_routes", "app": app, "store": listing,
                     "Query": Query, "BaseModel": BaseModel, "Field": Field,
                     "model_validator": model_validator, "Any": Any, "Dict": Dict,
                     "List": List, "Optional": Optional}
        # Compile only real preset schemas/routes, never app.main imports/startup.
        schema_tree = ast.parse((ROOT / "schemas.py").read_text())
        classes = [node for node in schema_tree.body if isinstance(node, ast.ClassDef)
                   and node.name in {"PresetRecord", "PresetListResponse", "PresetSummaryRecord", "PresetSummaryListResponse"}]
        exec(compile(ast.Module(body=classes, type_ignores=[]), str(ROOT / "schemas.py"), "exec"), namespace)
        route_tree = ast.parse((ROOT / "main.py").read_text())
        routes = [node for node in route_tree.body if isinstance(node, ast.FunctionDef)
                  and node.name in {"list_presets", "search_presets", "list_preset_summaries", "search_preset_summaries"}]
        exec(compile(ast.Module(body=routes, type_ignores=[]), str(ROOT / "main.py"), "exec"), namespace)
        with TestClient(app) as client:
            yield client, connection


class PresetListingTests(unittest.TestCase):
    def test_initial_summary_keeps_the_whole_catalog_without_detail_blobs(self):
        with preset_api([summary(i) for i in range(75)]) as (client, connection):
            response = client.get("/media/presets/summary")
            self.assertEqual(response.status_code, 200, response.text)
            items = response.json()
            self.assertEqual(len(items), 75)
            self.assertEqual(items[-1]["preset_id"], "preset-74")
            self.assertEqual(items[0]["applies_to_models"], ["gpt-image-2-image-to-image"])
            self.assertEqual(items[0]["input_schema_count"], 2)
            self.assertEqual(items[0]["input_slots_count"], 1)
            self.assertEqual(items[0]["image_input_policy"], "required")
            for field in ("prompt_template", "input_schema_json", "input_slots_json", "default_options_json", "notes"):
                self.assertNotIn(field, items[0])
            sql = connection.execute.call_args.args[0]
            self.assertNotIn("SELECT *", sql)
            self.assertNotIn("prompt_template", sql)
            self.assertIn("status != 'archived'", sql)
            self.assertIn("priority DESC, updated_at DESC, key ASC", sql)

    def test_summary_search_preserves_filters_paging_and_full_default_contract(self):
        with preset_api([summary(74)]) as (client, connection):
            response = client.get("/media/presets/search/summary?limit=60&offset=60&q=Older&category=portrait")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual({key: response.json()[key] for key in ("total", "limit", "offset", "next_offset")},
                             {"total": 752, "limit": 60, "offset": 60, "next_offset": 61})
            sql, parameters = connection.execute.call_args.args
            self.assertNotIn("SELECT *", sql)
            self.assertIn("portrait", parameters)
            self.assertEqual(parameters[-2:], [60, 60])
            self.assertIn("%older%", parameters)
            connection.execute.reset_mock()
            response = client.get("/media/presets")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn("input_schema_json", response.json()[0])
            self.assertIn("SELECT *", connection.execute.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
