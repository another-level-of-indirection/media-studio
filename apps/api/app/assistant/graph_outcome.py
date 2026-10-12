"""User-facing Graph outcomes from recorded operations, never planning prose."""
from __future__ import annotations
from typing import Any


def graph_proposal_copy(operations: list[dict[str, Any]]) -> tuple[str, str]:
    effects: dict[str, str] = {}
    for item in operations:
        op = item.get("op")
        if op == "rename_workflow":
            name = str(item.get("title") or "").strip()
            effects["rename"] = f"rename the workflow to ‘{name}’"
        elif op in {"add_node", "add_note"}:
            effects["add"] = "add nodes"
        elif op in {"set_node_field", "set_node_title", "set_execution_mode", "replace_model"}:
            effects["edit"] = "update node settings or titles"
        elif op == "arrange_workflow":
            effects["layout"] = "arrange the workflow"
        elif op in {"connect_nodes", "update_edge", "remove_edge"}:
            effects["connections"] = "update connections"
        elif op in {"group_nodes", "remove_nodes_from_group"}:
            effects["groups"] = "update node groups"
        else:
            effects["other"] = "update the workflow"
    titles = [str(item.get("title") or "").strip() for item in operations if item.get("op") in {"add_node", "add_note"} and item.get("title")]
    if titles:
        effects["add"] = "add nodes: " + ", ".join(titles)
    if not effects:
        return "", "No canvas changes are prepared. Review any questions or requirements below."
    if set(effects) == {"rename"}:
        name = str(operations[-1].get("title") or "").strip()
        copy = f"Ready to rename this workflow to ‘{name}’. The name has not changed yet. Your images, nodes and connections will stay the same."
        return "Rename workflow", copy
    family = set(effects)
    if "add" in family and all(item.get("op") in {"add_node", "add_note", "connect_nodes", "group_nodes"} for item in operations):
        label = "Add to canvas"
    elif family == {"edit"}:
        label = "Apply node changes"
    elif family == {"layout"}:
        label = "Tidy workflow"
    else:
        label = "Apply changes"
    description = "; ".join(effects.values())
    return label, f"Prepared changes for review: {description}. These changes have not been applied."


def graph_confirmation_label(metadata: dict[str, Any], operations: list[dict[str, Any]]) -> str:
    if metadata.get("independent_stage"):
        return "Open new workflow"
    label, _ = graph_proposal_copy(operations)
    if label == "Add to canvas":
        if metadata.get("replace_existing_test_lane"):
            return "Replace test lane"
        if metadata.get("template_refinement"):
            return "Apply refinement"
    return label or "Apply changes"
