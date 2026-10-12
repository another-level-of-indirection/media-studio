import type { AssistantPlanResponse } from "../types";

// Authored prose is supporting context. Recorded operations own the outcome and action.
export function graphChangeCopy(plan: AssistantPlanResponse, applied = false) {
  const effects = new Map<string, string>();
  for (const item of plan.graph_plan.operations) {
    switch (item.op) {
      case "rename_workflow": effects.set("rename", `Rename the workflow to ‘${applied ? plan.workflow.name : String(item.title ?? "")}’`); break;
      case "add_node": case "add_note": effects.set("add", "Add nodes"); break;
      case "set_node_field": case "set_node_title": case "set_execution_mode": case "replace_model": effects.set("edit", "Update node settings or titles"); break;
      case "arrange_workflow": effects.set("layout", "Arrange the workflow"); break;
      case "connect_nodes": case "update_edge": case "remove_edge": effects.set("connections", "Update connections"); break;
      case "group_nodes": case "remove_nodes_from_group": effects.set("groups", "Update node groups"); break;
      default: effects.set("other", "Update the workflow");
    }
  }
  const addedTitles = plan.graph_plan.operations.filter(item => ["add_node", "add_note"].includes(String(item.op))).map(item => String(item.title ?? "").trim()).filter(Boolean);
  if (addedTitles.length) effects.set("add", `Add nodes: ${addedTitles.join(", ")}`);
  const renameOnly = effects.size === 1 && effects.has("rename");
  const layoutOnly = effects.size === 1 && effects.has("layout");
  const editOnly = effects.size === 1 && effects.has("edit");
  const additions = effects.has("add") && plan.graph_plan.operations.every(item => ["add_node", "add_note", "connect_nodes", "group_nodes"].includes(String(item.op)));
  const metadata = plan.graph_plan.metadata ?? {};
  const action = metadata.independent_stage ? "Open new workflow"
    : renameOnly ? "Rename workflow" : layoutOnly ? "Tidy workflow" : editOnly ? "Apply node changes"
    : additions ? metadata.replace_existing_test_lane ? "Replace test lane" : metadata.template_refinement ? "Apply refinement" : "Add to canvas"
    : "Apply changes";
  let title = renameOnly ? applied ? "Workflow renamed" : "Workflow rename prepared"
    : layoutOnly ? applied ? "Workflow layout updated" : "Workflow layout ready"
    : editOnly ? applied ? "Node updated" : "Node changes prepared"
    : additions ? applied ? "Graph added" : "Graph additions prepared"
    : applied ? "Workflow changes applied" : "Workflow changes prepared";
  const name = applied ? plan.workflow.name : String(plan.graph_plan.operations.at(-1)?.title ?? "");
  let copy = renameOnly
    ? applied ? `Workflow renamed to ‘${name}’. Applying this change did not start a run.`
      : `Ready to rename this workflow to ‘${name}’. The name has not changed yet. Your images, nodes and connections will stay the same.`
    : applied ? `${editOnly ? "The requested node changes are updated on the canvas." : "The confirmed graph changes are on the canvas."} Applying them did not start a run. Changes: ${[...effects.values()].join("; ")}.`
      : `Prepared for review: ${[...effects.values()].join("; ")}. These changes have not been applied.`;
  if (metadata.independent_stage) {
    title = applied ? "New workflow opened" : "New workflow prepared";
    copy = applied ? "The new workflow is open in its own tab with this conversation. Applying it did not start a run."
      : `Prepared a separate workflow ‘${plan.workflow.name}’. ${copy}`;
  }
  if (!effects.size) {
    title = "No canvas changes";
    copy = "No canvas changes are prepared. Review any questions or requirements below.";
  }
  if (!applied && ["failed", "rejected"].includes(plan.plan.status)) {
    title = plan.plan.status === "failed" ? "Changes could not be applied" : "Changes rejected";
    copy = "These changes were not completed. Ask for a fresh review before trying again.";
  } else if (!applied && !plan.validation.valid) {
    title = "Workflow changes need review";
  }
  return { renameOnly, title, action, copy };
}
