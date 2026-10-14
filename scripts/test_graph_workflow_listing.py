"""Workflow HTTP/store contracts, without startup, providers or database creation."""
from contextlib import contextmanager
import importlib
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1] / "apps/api/app"
PACKAGE = "_workflow_listing_test_app"


def record(index=0):
    return {
        "workflow_id": f"wf-{index}", "name": f"Workflow {index}",
        "description": "Saved description", "status": "active", "schema_version": 1,
        "created_at": "2026-10-13T00:00:00Z", "updated_at": "2026-10-13T01:00:00Z",
    }


@contextmanager
def workflow_api(*, rows=None, total=65):
    modules = {}

    def module(name, **attributes):
        full_name = f"{PACKAGE}.{name}" if name else PACKAGE
        result = ModuleType(full_name)
        result.__dict__.update(attributes)
        modules[full_name] = result
        return result

    connection = Mock()
    connection.execute.side_effect = lambda sql, params=(): SimpleNamespace(
        fetchone=lambda: {"count": total}, fetchall=lambda: rows if rows is not None else [record()],
    )

    @contextmanager
    def get_connection():
        yield connection

    module("", __path__=[str(ROOT)])
    module("db", get_connection=get_connection)
    module("graph", __path__=[str(ROOT / "graph")])
    module("assistant", __path__=[])
    module("assistant.run_confirmation", RunEvidenceError=ValueError,
           associate_confirmed_assistant_run=Mock(), associate_toolbar_preset_run=Mock())
    module("assistant.schemas", AssistantRunConfirmationRequest=BaseModel)
    catalogs = [Mock(return_value={}), Mock(return_value=[]), Mock(return_value=[])]
    module("graph.registry", registry=SimpleNamespace(definitions_by_type=catalogs[0]))
    module("graph.prompt_recipe_catalog", prompt_recipe_catalog=catalogs[1])
    module("graph.preset_catalog", media_preset_catalog=catalogs[2])
    module("graph.pricing", estimate_graph_workflow=Mock())
    module("graph.runtime", provider_spend_metrics=Mock(), runtime=SimpleNamespace())
    module("graph.validator", validate_workflow=Mock())
    with patch.dict(sys.modules, modules):
        graph_store = importlib.import_module(f"{PACKAGE}.store_graph")
        full = {**record(), "workflow_json": {
            "schema_version": 1, "workflow_id": "wf-0", "name": "Workflow 0",
            "description": "Saved description", "nodes": [], "edges": [], "viewport": {}, "metadata": {},
        }}
        facade = module("store", list_graph_workflows=Mock(return_value=[full]),
                        get_graph_workflow=Mock(return_value=full))
        if hasattr(graph_store, "list_graph_workflow_summaries"):
            facade.list_graph_workflow_summaries = graph_store.list_graph_workflow_summaries
        # The facade replaces the side-effectful application store. Real routes,
        # schemas, normalization and graph-store functions remain under test.
        with patch.dict(sys.modules, modules):
            routes = importlib.import_module(f"{PACKAGE}.graph.routes")
            app = FastAPI()
            app.include_router(routes.router)
            with TestClient(app) as client:
                yield client, connection, catalogs, graph_store, full


class WorkflowListingTests(unittest.TestCase):
    def test_summary_page_contains_metadata_without_materializing_graphs(self):
        with workflow_api(rows=[record(0), record(1)]) as (client, connection, catalogs, _, _):
            response = client.get("/media/graph/workflows/summary?limit=2&offset=0")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), {
                "items": [record(0), record(1)], "total": 65, "limit": 2, "offset": 0, "next_offset": 2,
            })
            for catalog in catalogs:
                catalog.assert_not_called()
            queries = [call.args[0] for call in connection.execute.call_args_list]
            self.assertTrue(queries)
            for query in queries:
                self.assertNotIn("workflow_json", query.lower())
                self.assertNotIn("SELECT *", query.upper())

    def test_http_rejects_unbounded_pages_and_negative_offsets(self):
        with workflow_api() as (client, connection, _, _, _):
            for query in ("limit=0", "limit=61", "offset=-1", "limit=oops"):
                self.assertEqual(client.get(f"/media/graph/workflows/summary?{query}").status_code, 422)
            connection.execute.assert_not_called()

    def test_store_uses_bounded_projection_stable_order_and_literal_search(self):
        with workflow_api(rows=[record(64)], total=65) as (client, connection, _, graph_store, _):
            response = client.get("/media/graph/workflows/summary", params={"limit": 60, "offset": 64, "q": "  50%_\\  "})
            self.assertEqual(response.json(), {
                "items": [record(64)], "total": 65, "limit": 60, "offset": 64, "next_offset": None,
            })
            count, page = connection.execute.call_args_list
            self.assertIn("status != 'archived'", count.args[0])
            self.assertIn("LOWER(COALESCE(description, ''))", page.args[0])
            self.assertIn("ORDER BY updated_at DESC, name ASC, workflow_id ASC LIMIT ? OFFSET ?", page.args[0])
            self.assertEqual(count.args[1], ["%50\\%\\_\\\\%", "%50\\%\\_\\\\%"])
            self.assertEqual(page.args[1], ["%50\\%\\_\\\\%", "%50\\%\\_\\\\%", 60, 64])
            bounded = graph_store.list_graph_workflow_summaries(limit=10000, offset=-5)
            self.assertEqual((bounded["limit"], bounded["offset"]), (60, 0))

    def test_empty_page_is_terminal_and_default_limit_is_bounded(self):
        with workflow_api(rows=[], total=0) as (client, _, _, _, _):
            self.assertEqual(client.get("/media/graph/workflows/summary").json(), {
                "items": [], "total": 0, "limit": 60, "offset": 0, "next_offset": None,
            })

    def test_legacy_list_and_detail_keep_full_graph_contract(self):
        with workflow_api() as (client, _, _, _, full):
            self.assertEqual(client.get("/media/graph/workflows").json(), {"items": [full]})
            self.assertEqual(client.get("/media/graph/workflows/wf-0").json(), full)


if __name__ == "__main__":
    unittest.main()
