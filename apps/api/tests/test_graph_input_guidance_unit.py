from __future__ import annotations

import unittest
from unittest.mock import patch

from app.graph.registry import registry
from app.graph.schemas import GraphWorkflow
from app.graph.validator import validate_workflow


class PresetInputGuidanceTests(unittest.TestCase):
    def test_required_preset_inputs_name_the_visible_fields_and_node_without_changing_identifiers(self):
        preset = {"preset_id": "preset-1", "key": "amber", "label": "Amber preset", "status": "active", "model_key": "model-1",
                  "input_schema_json": [{"key": "scene_desc", "label": "Scene description", "required": True}],
                  "input_slots_json": [{"key": "image_1", "label": "Product photo", "required": True, "max_files": 1}]}
        workflow = GraphWorkflow.model_validate({"schema_version": 1, "name": "Review", "nodes": [
            {"id": "preset", "type": "preset.render", "position": {"x": 0, "y": 0}, "fields": {"preset_id": "preset-1"}, "metadata": {"ui": {"customTitle": "Amber product"}}}], "edges": [], "metadata": {}})
        # Only persistence/provider boundaries are replaced; registry, schemas and validation remain real.
        with patch("sqlite3.connect", side_effect=AssertionError("Database forbidden")), patch("socket.socket.connect", side_effect=AssertionError("Network forbidden")), \
             patch("app.store.get_preset", return_value=preset), patch("app.store.list_presets", return_value=[preset]), \
             patch("app.store.list_prompt_recipes", return_value=[]), patch("app.store.list_projects", return_value=[]), patch("app.store.cache_graph_node_definitions"), \
             patch("app.kie_adapter.list_models", return_value=[]), patch("app.kie_adapter.model_diagnostics", return_value={}), \
             patch("app.store.get_enhancement_config", return_value={}):
            registry.invalidate()
            try:
                result = validate_workflow(workflow)
            finally:
                registry.invalidate()
        errors = {error.code: error for error in result.errors}
        self.assertFalse(result.valid)
        self.assertEqual(errors["missing_preset_text"].message, "Enter Scene description for Amber product before running.")
        self.assertEqual(errors["missing_preset_text"].field_id, "text__scene_desc")
        self.assertEqual(errors["missing_preset_image_slot"].message, "Choose media for Product photo in Amber product before running.")
        self.assertEqual(errors["missing_preset_image_slot"].port_id, "slot__image_1")
        self.assertEqual(errors["missing_preset_image_slot"].node_id, "preset")
