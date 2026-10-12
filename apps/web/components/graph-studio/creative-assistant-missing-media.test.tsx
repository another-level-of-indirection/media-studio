// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CreativeAssistantPanel } from "./creative-assistant-panel";
import { assistantIdleProgress, assistantSessionResponse, assistantJsonResponse as json, assistantTestSession as session, assistantTestWorkflow as workflow } from "./creative-assistant-test-fixtures";
import type { AssistantPlanResponse } from "./types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function missingMediaPlan(): AssistantPlanResponse {
  return {
    plan: { assistant_plan_id: "missing-images", assistant_session_id: "session-1", status: "validated", capability: "plan_graph" },
    graph_plan: { capability: "plan_graph", summary: "Prepared an advertising image graph.", questions: [], operations: [{ op: "add_node", node_type: "media.load_image" }], warnings: [], requires_confirmation: true, metadata: {} },
    workflow: { ...workflow, nodes: [
      { id: "person", type: "media.load_image", position: { x: 0, y: 0 }, fields: {}, metadata: { ui: { customTitle: "Person photo" } } },
      { id: "product", type: "media.load_image", position: { x: 0, y: 200 }, fields: {}, metadata: { ui: { customTitle: "Product photo" } } },
    ] },
    validation: { valid: false, errors: [
      { code: "missing_media_reference", message: "Load media needs an asset or reference media for this required input.", node_id: "person" },
      { code: "missing_media_reference", message: "Load media needs an asset or reference media for this required input.", node_id: "product" },
    ], warnings: [] },
    pricing: { pricing_summary: { total: {} }, nodes: {}, warnings: [] },
  };
}

async function review(plan: AssistantPlanResponse) {
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/progress") ? json(assistantIdleProgress) :
    (url.includes("/sessions?") || url.endsWith("/session-1")) ? assistantSessionResponse(url, { ...session, messages: [], latest_plan: plan }) : json({ ready: true })));
  render(<CreativeAssistantPanel open workspaceKey="missing-media" workflowId="workflow-1" workflowName="Graph" workflow={workflow}
    references={[]} importImageFile={vi.fn()} onApplyWorkflow={vi.fn()} onClose={vi.fn()} />);
  return within(await screen.findByRole("region", { name: "Graph review" }));
}

it("shows both required missing images together in Graph review", async () => {
  const view = await review(missingMediaPlan());
  expect(view.getByText("2 required media inputs need files before this graph can run.")).toBeTruthy();
  expect(view.getByText("Choose media for Person photo before running this graph.")).toBeTruthy();
  expect(view.getByText("Choose media for Product photo before running this graph.")).toBeTruthy();
});

it("counts a required input once when validation reports it for repeated connections", async () => {
  const plan = missingMediaPlan();
  plan.validation.errors.push({ ...plan.validation.errors[0] });
  const view = await review(plan);
  expect(view.getByText("2 required media inputs need files before this graph can run.")).toBeTruthy();
  const errors = within(view.getByRole("list", { name: "Graph review errors" }));
  expect(errors.getAllByRole("listitem")).toHaveLength(2);
  expect(errors.getAllByText("Choose media for Person photo before running this graph.")).toHaveLength(1);
});

it("keeps separate missing inputs distinct when their labels match", async () => {
  const plan = missingMediaPlan();
  plan.workflow.nodes[1].metadata = plan.workflow.nodes[0].metadata;
  const view = await review(plan);
  expect(view.getByText("2 required media inputs need files before this graph can run.")).toBeTruthy();
  expect(within(view.getByRole("list", { name: "Graph review errors" })).getAllByRole("listitem")).toHaveLength(2);
});

it.each([
  [false, "1 required media input needs a file before this graph can run."],
  [true, null],
])("reflects remaining validation after media is supplied (all supplied=%s)", async (allSupplied, summary) => {
  const plan = missingMediaPlan();
  plan.workflow.nodes[0].fields = { asset_id: "existing-person" };
  plan.validation.errors = allSupplied ? [] : [plan.validation.errors[1]];
  plan.validation.valid = allSupplied;
  if (allSupplied) plan.workflow.nodes[1].fields = { asset_id: "existing-product" };
  const view = await review(plan);
  expect(view.queryByText("Choose media for Person photo before running this graph.")).toBeNull();
  if (summary) {
    expect(view.getByText(summary)).toBeTruthy();
    expect(view.getByText("Choose media for Product photo before running this graph.")).toBeTruthy();
  } else {
    expect(view.queryByRole("list", { name: "Graph review errors" })).toBeNull();
    expect(view.getByText("Graph additions prepared")).toBeTruthy();
  }
});

it("keeps other validation blockers visible without counting optional empty inputs", async () => {
  const plan = missingMediaPlan();
  plan.validation.errors = [plan.validation.errors[0], { code: "missing_prompt", message: "Add an advertising prompt.", node_id: "prompt" }];
  plan.validation.warnings = [{ code: "optional_media_empty", message: "Empty load image is an optional input.", node_id: "product" }];
  const view = await review(plan);
  expect(view.getByText("1 required media input needs a file before this graph can run.")).toBeTruthy();
  const errors = within(view.getByRole("list", { name: "Graph review errors" }));
  expect(errors.getByText("Add an advertising prompt.")).toBeTruthy();
  expect(errors.queryByText(/Product photo/)).toBeNull();
  expect(view.getByText("Product photo is empty. It will be skipped unless you add media.")).toBeTruthy();
});
