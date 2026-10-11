"""Conservative replies for successful typed terminal artifacts without prose."""
from __future__ import annotations
from typing import Any
from .graph_outcome import graph_proposal_copy, graph_confirmation_label

def terminal_artifact_reply(kind: str | None, result: dict[str, Any]) -> str:
    if kind == "graph_proposal":
        operations = result.get("operations") or []
        label, copy = graph_proposal_copy(operations)
        metadata = result.get("action_metadata") or {}
        if label:
            label = graph_confirmation_label(metadata, operations)
        if metadata.get("independent_stage"):
            name = str((result.get("workflow") or {}).get("name") or "")
            label = "Open new workflow"
            copy = f"Prepared a separate workflow ‘{name}’. {copy}"
        validation = result.get("validation") or {}
        requirements = []
        seen = set()
        nodes = {node.get("id"): node for node in (result.get("workflow") or {}).get("nodes", [])}
        for error in validation.get("errors") or []:
            node_id = error.get("node_id")
            if error.get("code") == "missing_media_reference":
                if node_id and node_id in seen:
                    continue
                seen.add(node_id)
                node = nodes.get(node_id) or {}
                ui, fields = (node.get("metadata") or {}).get("ui") or {}, node.get("fields") or {}
                name = next((ui.get(key) for key in ("customTitle", "custom_title", "title", "label") if ui.get(key)), None) or next((fields.get(key) for key in ("title", "label", "name") if fields.get(key)), None)
                name = name.strip() if isinstance(name, str) and name.strip() else str(node.get("type") or "the required input").replace(".", " ")
                requirements.append(f"Choose media for {name} before running this graph.")
            else:
                requirements.append(str(error.get("message") or "Review the validation issue."))
        copy += (" " + " ".join(requirements)) if requirements else ""
        if result.get("confirmable") is False or (result.get("confirmable") is not True and validation.get("valid") is False and any(error.get("code") != "missing_media_reference" for error in validation.get("errors") or [])):
            return copy + " Review the requirements before applying."
        return copy + (f" Choose {label} to confirm. This does not start a run." if label else "")
    if kind in {"preset_draft", "recipe_draft"}:
        draft = result.get("draft") or {}
        name = str(draft.get("label") or draft.get("title") or "").strip()
        artifact = "Media Preset" if kind == "preset_draft" else "Prompt Recipe"
        return f"{artifact}{' ‘' + name + '’' if name else ''} draft prepared for review. This draft has not been saved."
    if kind == "recipe_continuation":
        return "A Prompt Recipe is needed before this graph can be prepared. Review the continuation choice."
    return ""
