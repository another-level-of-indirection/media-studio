"""Template-list contract tests without app startup, database fixtures or providers."""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import importlib
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel


APP_ROOT = Path(__file__).resolve().parents[1] / "apps/api/app"
TEST_PACKAGE = "_template_listing_test_app"


@contextmanager
def template_api(records, *, definitions=None, recipes=None, presets=None):
    # A private package loads real routes, schemas and normalization. Stub the
    # side-effectful imports before loading routes; never import app.main/store.
    modules = {}

    def module(name, **attributes):
        full_name = f"{TEST_PACKAGE}.{name}" if name else TEST_PACKAGE
        result = ModuleType(full_name)
        result.__dict__.update(attributes)
        modules[full_name] = result
        return result

    module("", __path__=[str(APP_ROOT)])
    module("graph", __path__=[str(APP_ROOT / "graph")])
    module("assistant", __path__=[])
    module("assistant.run_confirmation", RunEvidenceError=ValueError,
           associate_confirmed_assistant_run=Mock(), associate_toolbar_preset_run=Mock())
    module("assistant.schemas", AssistantRunConfirmationRequest=BaseModel)
    module("store", list_graph_templates=Mock(return_value=records))
    catalogs = SimpleNamespace(
        definitions=Mock(return_value=definitions if definitions is not None else {}),
        recipes=Mock(return_value=recipes if recipes is not None else []),
        presets=Mock(return_value=presets if presets is not None else []),
    )
    module("graph.registry", registry=SimpleNamespace(definitions_by_type=catalogs.definitions))
    module("graph.prompt_recipe_catalog", prompt_recipe_catalog=catalogs.recipes)
    module("graph.preset_catalog", media_preset_catalog=catalogs.presets)
    module("graph.pricing", estimate_graph_workflow=Mock())
    module("graph.runtime", provider_spend_metrics=Mock(), runtime=SimpleNamespace())
    module("graph.validator", validate_workflow=Mock())
    with patch.dict(sys.modules, modules):
        schemas = importlib.import_module(f"{TEST_PACKAGE}.graph.schemas")
        routes = importlib.import_module(f"{TEST_PACKAGE}.graph.routes")
        app = FastAPI()
        app.include_router(routes.router)
        with TestClient(app) as client:
            yield client, catalogs, schemas


def template_record(index):
    return {
        "template_id": f"template-{index}",
        "name": f"Template {index}",
        "description": "Existing description",
        "tags": ["graph-studio"],
        "thumbnail_path": "template-thumbnail.png",
        "status": "active",
        "created_at": "2026-10-13T00:00:00Z",
        "updated_at": "2026-10-13T00:00:00Z",
        "workflow_json": {
            "schema_version": 1, "workflow_id": None, "name": "Existing workflow",
            "description": None, "nodes": [], "edges": [], "viewport": {}, "metadata": {},
        },
    }


class TemplateListingTests(unittest.TestCase):
    def test_catalog_work_is_once_per_request_for_any_template_count(self):
        for count in (0, 1, 8):
            with self.subTest(count=count):
                records = [template_record(index) for index in range(count)]
                with template_api(records) as (client, catalogs, schemas):
                    # A nonempty registry is the established installation case.
                    catalogs.definitions.return_value = {
                        "display.any": schemas.GraphNodeDefinition(
                            type="display.any", title="Display", category="output"
                        )
                    }
                    response = client.get("/media/graph/templates")
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json(), {"items": records})
                    catalogs.definitions.assert_called_once_with()
                    catalogs.recipes.assert_called_once_with(status="all")
                    catalogs.presets.assert_called_once_with(status="all")

    def test_empty_definition_catalog_is_still_shared_for_the_request(self):
        records = [template_record(0), template_record(1)]
        with template_api(records) as (client, catalogs, _):
            response = client.get("/media/graph/templates")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), {"items": records})
            catalogs.definitions.assert_called_once_with()
            catalogs.recipes.assert_called_once_with(status="all")
            catalogs.presets.assert_called_once_with(status="all")

    def test_response_preserves_records_defaults_and_legacy_ports(self):
        record = template_record(0)
        record["workflow_json"].update({
            "viewport": {"x": 25, "y": 50, "zoom": 0.75},
            "metadata": {"label": "Keep workflow metadata"},
            "nodes": [
                {"id": "recipe", "type": "prompt.recipe", "fields": {"recipe_id": "recipe-1"}},
                {"id": "preset", "type": "preset.render", "fields": {"preset_id": "preset-1"}},
                {"id": "explicit-recipe", "type": "prompt.recipe",
                 "fields": {"recipe_id": "recipe-1", "recipe_category": "explicit", "temperature": 0}},
                {"id": "explicit-preset", "type": "preset.render",
                 "fields": {"preset_id": "preset-1", "preset_model_key": "chosen-model", "quality": "high"}},
                {"id": "save", "type": "media.save_image", "fields": {}, "metadata": {"label": "Save"}},
                {"id": "model", "type": "model.kie.seedance_2_0", "fields": {"duration": 5}},
            ],
            "edges": [{"id": "legacy", "source": "save", "source_port": "asset",
                       "target": "model", "target_port": "image_refs", "metadata": {"label": "Keep edge"}}],
        })
        stored = deepcopy(record)
        expected = deepcopy(record)
        expected["workflow_json"]["nodes"] = [
            {"id": "recipe", "type": "prompt.recipe", "position": {"x": 0, "y": 0}, "metadata": {},
             "fields": {"recipe_id": "recipe-1", "recipe_category": "creative", "temperature": 0.3}},
            {"id": "preset", "type": "preset.render", "position": {"x": 0, "y": 0}, "metadata": {},
             "fields": {"preset_id": "preset-1", "preset_model_key": "default-model", "quality": "normal"}},
            {"id": "explicit-recipe", "type": "prompt.recipe", "position": {"x": 0, "y": 0}, "metadata": {},
             "fields": {"recipe_id": "recipe-1", "recipe_category": "explicit", "temperature": 0}},
            {"id": "explicit-preset", "type": "preset.render", "position": {"x": 0, "y": 0}, "metadata": {},
             "fields": {"preset_id": "preset-1", "preset_model_key": "chosen-model", "quality": "high"}},
            {"id": "save", "type": "media.save_image", "position": {"x": 0, "y": 0},
             "metadata": {"label": "Save"}, "fields": {}},
            {"id": "model", "type": "model.kie.seedance_2_0", "position": {"x": 0, "y": 0},
             "metadata": {}, "fields": {"duration": 5}},
        ]
        expected["workflow_json"]["edges"][0].update(source_port="image", target_port="reference_images")
        with template_api(
            [record], recipes=[{"recipe_id": "recipe-1", "category": "creative"}],
            presets=[{"preset_id": "preset-1", "default_model_key": "default-model"}],
        ) as (client, catalogs, schemas):
            catalogs.definitions.return_value = {
                "prompt.recipe": schemas.GraphNodeDefinition(
                    type="prompt.recipe", title="Recipe", category="prompt",
                    fields=[schemas.GraphNodeField(id="temperature", label="Temperature", type="number", default=0.3)],
                ),
                "preset.render": schemas.GraphNodeDefinition(
                    type="preset.render", title="Preset", category="media",
                    fields=[schemas.GraphNodeField(id="quality", label="Quality", type="text", default="normal")],
                ),
            }
            response = client.get("/media/graph/templates")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), {"items": [expected]})
            self.assertEqual(record, stored, "Listing must not mutate stored workflow JSON")

    def test_next_request_observes_fresh_catalog_values(self):
        record = template_record(0)
        record["workflow_json"]["nodes"] = [
            {"id": "recipe", "type": "prompt.recipe", "fields": {"recipe_id": "recipe-1"}},
            {"id": "preset", "type": "preset.render", "fields": {"preset_id": "preset-1"}},
        ]
        with template_api([record]) as (client, catalogs, schemas):
            for category, model, quality in (("creative", "model-a", "normal"), ("utility", "model-b", "high")):
                catalogs.recipes.return_value = [{"recipe_id": "recipe-1", "category": category}]
                catalogs.presets.return_value = [{"preset_id": "preset-1", "default_model_key": model}]
                catalogs.definitions.return_value = {
                    "preset.render": schemas.GraphNodeDefinition(
                        type="preset.render", title="Preset", category="media",
                        fields=[schemas.GraphNodeField(id="quality", label="Quality", type="text", default=quality)],
                    ),
                }
                response = client.get("/media/graph/templates")
                self.assertEqual(response.status_code, 200, response.text)
                nodes = response.json()["items"][0]["workflow_json"]["nodes"]
                self.assertEqual(nodes[0]["fields"], {"recipe_id": "recipe-1", "recipe_category": category})
                self.assertEqual(nodes[1]["fields"], {
                    "preset_id": "preset-1", "preset_model_key": model, "quality": quality,
                })
            for catalog in (catalogs.definitions, catalogs.recipes, catalogs.presets):
                self.assertEqual(catalog.call_count, 2)


if __name__ == "__main__":
    unittest.main()
