// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { CreativeAssistantPanel } from "./creative-assistant-panel";
import type { AssistantPlanResponse } from "./types";
import {
  assistantIdleProgress, assistantJsonResponse as jsonResponse,
  assistantTestSession as session,
  assistantTestWorkflow as workflow,
} from "./creative-assistant-test-fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage?.clear?.();
});

const plan: AssistantPlanResponse = {
  plan: {
    assistant_plan_id: "plan-1",
    assistant_session_id: "session-1",
    status: "validated",
    capability: "plan_graph",
  },
  graph_plan: {
    capability: "plan_graph",
    summary: "Saved preset graph proposal",
    questions: [],
    operations: [{ op: "add_node" }],
    warnings: [],
    requires_confirmation: true,
    metadata: { kernel_proposal: true },
  },
  workflow: {
    ...workflow,
    nodes: [{ id: "preset", type: "preset.render", position: { x: 0, y: 0 }, fields: { preset_id: "preset-1" } }],
  },
  validation: { valid: true, errors: [], warnings: [] },
  pricing: { pricing_summary: { total: { estimated_credits: 6, estimated_cost_usd: 0.03 } }, nodes: {}, warnings: [] },
};

const savedRecipeMessage = {
  assistant_message_id: "message-recipe-saved",
  assistant_session_id: "session-1",
  role: "system_summary",
  content_text: "Saved the confirmed assistant artifact.",
  content_json: {
    activity_kind: "prompt_recipe_saved",
    saved_artifact: {
      kind: "prompt_recipe",
      id: "recipe-1",
      key: "storyboard_writer",
      label: "Storyboard Writer",
    },
  },
};

const savedRecipeGraphRequestMessage = {
  assistant_message_id: "message-graph-request",
  assistant_session_id: "session-1",
  role: "user",
  content_text: "Create a clean replacement workflow that uses the saved Prompt Recipe named Storyboard Writer with exact id recipe-1 and key storyboard_writer, then sends the rendered prompt into a compatible text-to-image model with preview and save image nodes.",
  content_json: {},
};

const clarificationMessage = {
  assistant_message_id: "message-clarification",
  assistant_session_id: "session-1",
  role: "assistant",
  content_text: "Which sample values should the graph use for Story Beat and Mood?",
  content_json: {
    mode: "assistant_kernel",
    next_action: { kind: "none", requires_confirmation: false },
  },
};

it("passes exact preset identity and usable field values into saved-preset graph planning", async () => {
  const occupiedWorkflow = {
    ...workflow,
    nodes: [
      {
        id: "existing-model",
        type: "model.kie.gpt_image_2_image_to_image",
        position: { x: 0, y: 0 },
        fields: { aspect_ratio: "3:4", resolution: "2K" },
      },
    ],
  };
  const savedPresetMessage = {
    assistant_message_id: "message-preset-saved",
    assistant_session_id: "session-1",
    role: "system_summary",
    content_text: "Saved the confirmed assistant artifact.",
    content_json: {
      activity_kind: "media_preset_saved",
      saved_artifact: {
        kind: "media_preset",
        id: "preset-1",
        key: "navy_field_guide",
        label: "Navy Field Guide",
      },
    },
  };
  const priorKernelMessage = {
    assistant_message_id: "message-prior-kernel",
    assistant_session_id: "session-1",
    role: "assistant",
    content_text: "The previous request ended without a graph proposal.",
    content_json: {
      mode: "assistant_kernel",
      next_action: { kind: "none", requires_confirmation: false },
    },
  };
  const confirmedPlanMessage = {
    assistant_message_id: "message-confirmed-plan",
    assistant_session_id: "session-1",
    role: "assistant",
    content_text: "The saved-preset graph is ready for review.",
    content_json: {
      mode: "assistant_kernel",
      next_action: {
        kind: "confirm_graph",
        label: "Add to canvas",
        proposal_id: "plan-1",
        confirmation_token: "confirm-plan-1",
        requires_confirmation: true,
        payload: {
          proposal_id: "plan-1",
          confirmation_token: "confirm-plan-1",
        },
      },
    },
  };
  const onApplyWorkflow = vi.fn();
  let planning = false;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith("/progress")) return jsonResponse(assistantIdleProgress);
    if (url.includes("/media/assistant/sessions?")) {
      return jsonResponse({ items: [{ ...session, messages: [savedPresetMessage, priorKernelMessage] }] });
    }
    if (url.endsWith("/media/assistant/sessions/session-1/plans")) {
      planning = true; return jsonResponse(plan); }
    if (url.endsWith("/media/assistant/sessions/session-1")) {
      if (!planning) return jsonResponse({ ...session, messages: [savedPresetMessage, priorKernelMessage] });
      return jsonResponse({
        ...session,
        messages: [savedPresetMessage, priorKernelMessage, confirmedPlanMessage],
        latest_plan: plan,
      });
    }
    if (url.endsWith("/media/assistant/plans/plan-1/apply")) {
      return jsonResponse({ ...plan, plan: { ...plan.plan, status: "applied" } });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);

  const rendered = render(
    <CreativeAssistantPanel
      open
      workspaceKey="tab-saved-preset"
      workflowId="workflow-1"
      workflowName="Assistant Graph"
      workflow={occupiedWorkflow}
      references={[]}
      importImageFile={vi.fn()}
      onApplyWorkflow={onApplyWorkflow}
      onClose={vi.fn()}
    />,
  );

  await act(async () => Promise.resolve());
  fireEvent.click(await screen.findByRole("button", { name: "Test Navy Field Guide in a clean graph" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/plans"))).toBe(true));
  const planCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/plans"));
  const request = JSON.parse(String(planCall?.[1]?.body));
  expect(request.message).toContain("preset-1");
  expect(request.message).toContain("navy_field_guide");
  expect(request.message).toContain("sample values");
  expect(request.workflow.nodes).toHaveLength(0);
  await act(async () => Promise.resolve());
  fireEvent.click(await screen.findByRole("button", { name: "Add to canvas" }));
  await waitFor(() => expect(onApplyWorkflow).toHaveBeenCalled());
  const applyCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/media/assistant/plans/plan-1/apply"));
  expect(JSON.parse(String(applyCall?.[1]?.body)).workflow.nodes).toHaveLength(0);

  await act(async () => Promise.resolve());
  fireEvent.click(screen.getByRole("button", { name: "Test Navy Field Guide in a clean graph" }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/plans"))).toHaveLength(2));
  const changedWorkflow = {
    ...occupiedWorkflow,
    nodes: [
      ...occupiedWorkflow.nodes,
      { id: "manual-note", type: "utility.note", position: { x: 500, y: 0 }, fields: { text: "Keep me" } },
    ],
  };
  rendered.rerender(
    <CreativeAssistantPanel
      open
      workspaceKey="tab-saved-preset"
      workflowId="workflow-1"
      workflowName="Assistant Graph"
      workflow={changedWorkflow}
      references={[]}
      importImageFile={vi.fn()}
      onApplyWorkflow={onApplyWorkflow}
      onClose={vi.fn()}
    />,
  );
  await act(async () => Promise.resolve());
  fireEvent.click(await screen.findByRole("button", { name: "Add to canvas" }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/apply"))).toHaveLength(2));
  const secondApplyCall = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/apply"))[1];
  expect(JSON.parse(String(secondApplyCall?.[1]?.body)).workflow.nodes).toHaveLength(2);
});

it("shows the persisted clarification when saved-artifact graph planning needs input", async () => {
  let requestedMessage = "";
  let planning = false;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/progress")) return jsonResponse(assistantIdleProgress);
    if (url.includes("/media/assistant/sessions?")) {
      return jsonResponse({ items: [{ ...session, messages: [savedRecipeMessage] }] });
    }
    if (url.endsWith("/media/assistant/sessions/session-1/plans")) {
      planning = true;
      requestedMessage = JSON.parse(String(init?.body)).message;
      return Promise.resolve(new Response(JSON.stringify({
        detail: "The assistant did not produce a confirmable graph proposal.",
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }));
    }
    if (url.endsWith("/media/assistant/sessions/session-1")) {
      if (!planning) return jsonResponse({ ...session, messages: [savedRecipeMessage] });
      return jsonResponse({ ...session, messages: [savedRecipeMessage, { ...savedRecipeGraphRequestMessage, content_text: requestedMessage }, clarificationMessage] });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(
    <CreativeAssistantPanel
      open
      workspaceKey="tab-saved-recipe-clarification"
      workflowId="workflow-1"
      workflowName="Assistant Graph"
      workflow={workflow}
      references={[]}
      importImageFile={vi.fn()}
      onApplyWorkflow={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  await act(async () => Promise.resolve());
  fireEvent.click(await screen.findByRole("button", { name: "Create a clean graph with Storyboard Writer" }));

  await waitFor(() => expect(container.querySelectorAll(".graph-assistant-message-assistant")).toHaveLength(1));
  expect(container.querySelector(".graph-assistant-message-plan")).toBeNull();
  expect(container.querySelector(".graph-assistant-error")).toBeNull();
});

it("preserves an upstream planning error instead of masking it with an unrelated reply", async () => {
  const unrelatedMessage = {
    ...clarificationMessage,
    assistant_message_id: "message-unrelated",
    content_text: "A separate assistant reply arrived.",
  };
  let planning = false;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith("/progress")) return jsonResponse(assistantIdleProgress);
    if (url.includes("/media/assistant/sessions?")) {
      return jsonResponse({ items: [{ ...session, messages: [savedRecipeMessage] }] });
    }
    if (url.endsWith("/media/assistant/sessions/session-1/plans")) {
      planning = true;
      return Promise.resolve(new Response(JSON.stringify({ detail: "Upstream assistant unavailable." }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }));
    }
    if (url.endsWith("/media/assistant/sessions/session-1")) {
      if (!planning) return jsonResponse({ ...session, messages: [savedRecipeMessage] });
      return jsonResponse({ ...session, messages: [savedRecipeMessage, unrelatedMessage] });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(
    <CreativeAssistantPanel
      open
      workspaceKey="tab-saved-recipe-upstream-error"
      workflowId="workflow-1"
      workflowName="Assistant Graph"
      workflow={workflow}
      references={[]}
      importImageFile={vi.fn()}
      onApplyWorkflow={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  await act(async () => Promise.resolve());
  fireEvent.click(await screen.findByRole("button", { name: "Create a clean graph with Storyboard Writer" }));

  expect(await screen.findByText("Upstream assistant unavailable.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Graph review" })).toBeNull();
  expect(container.querySelectorAll(".graph-assistant-message-plan")).toHaveLength(0);
});

it("stops a delayed clarification refresh without replacing the cancelled session", async () => {
  let resolveRefresh: ((response: Response) => void) | undefined;
  let refreshSignal: AbortSignal | undefined;
  const delayedRefresh = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  let planning = false;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/progress")) return jsonResponse(assistantIdleProgress);
    if (url.includes("/media/assistant/sessions?")) {
      return jsonResponse({ items: [{ ...session, messages: [savedRecipeMessage] }] });
    }
    if (url.endsWith("/media/assistant/sessions/session-1/plans")) {
      planning = true;
      return Promise.resolve(new Response(JSON.stringify({
        detail: "The assistant did not produce a confirmable graph proposal.",
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }));
    }
    if (url.endsWith("/media/assistant/sessions/session-1/cancel")) {
      return jsonResponse({ ...session, messages: [savedRecipeMessage] });
    }
    if (url.endsWith("/media/assistant/sessions/session-1")) {
      if (!planning) return jsonResponse({ ...session, messages: [savedRecipeMessage] });
      refreshSignal = init?.signal ?? undefined;
      return delayedRefresh;
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);

  const { container } = render(
    <CreativeAssistantPanel
      open
      workspaceKey="tab-saved-recipe-cancel-refresh"
      workflowId="workflow-1"
      workflowName="Assistant Graph"
      workflow={workflow}
      references={[]}
      importImageFile={vi.fn()}
      onApplyWorkflow={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  await act(async () => Promise.resolve());
  fireEvent.click(await screen.findByRole("button", { name: "Create a clean graph with Storyboard Writer" }));
  await waitFor(() => expect(refreshSignal).toBeDefined());
  await act(async () => Promise.resolve());
  fireEvent.click(await screen.findByRole("button", { name: /stop assistant request/i }));
  await waitFor(() => expect(refreshSignal?.aborted).toBe(true));

  await act(async () => {
    resolveRefresh?.(jsonResponse({
      ...session,
      messages: [savedRecipeMessage, savedRecipeGraphRequestMessage, clarificationMessage],
    }));
    await Promise.resolve();
  });

  await waitFor(() => expect(container.querySelectorAll(".graph-assistant-message-assistant")).toHaveLength(0));
});

it.each(['response', 'followup', 'unconfirmed'])('recovers saved-artifact graph planning after %s loss without erasing an unrelated draft or repeating the request', async (failure) => {
    let requested = false, failedRead = false, online = failure !== 'unconfirmed', requestText = '';
    const originalWorkflow = { ...workflow, nodes: [{ id: 'existing', type: 'utility.note', position: { x: 0, y: 0 }, fields: { text: 'Keep this existing graph.' } }] };
    const recoveredPlan = { ...plan, graph_plan: { ...plan.graph_plan, operations: [{ op: 'add_node', node_ref: 'prompt', node_type: 'prompt.text', title: 'Amber prompt', fields: { text: 'Keep amber light' }, position: { x: 0, y: 0 } }], metadata: { kernel_proposal: true, independent_stage: true, source_workflow_id: 'workflow-1' } }, workflow: { ...workflow, workflow_id: null, nodes: [{ id: 'prompt', type: 'prompt.text', position: { x: 0, y: 0 }, fields: { text: 'Keep amber light' } }] } };
    const initial = { ...session, messages: [savedRecipeMessage] };
    const refreshed = () => ({ ...session, messages: [savedRecipeMessage, { ...savedRecipeGraphRequestMessage, content_text: requestText }, { assistant_message_id: 'recovered', assistant_session_id: 'session-1', role: 'assistant', content_text: 'Prepared a graph for review.', content_json: { mode: 'assistant_kernel', next_action: { kind: 'confirm_graph', label: 'Add to canvas', proposal_id: 'plan-1', confirmation_token: 'confirm-plan-1', requires_confirmation: true, payload: { proposal_id: 'plan-1', confirmation_token: 'confirm-plan-1' } } } }], latest_plan: recoveredPlan });
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/progress'))
            return jsonResponse(assistantIdleProgress);
        if (url.endsWith('/plans')) {
            requested = true;
            requestText = JSON.parse(String(init?.body)).message;
            return failure === 'followup' ? jsonResponse(recoveredPlan) : Promise.reject(new TypeError('Failed to fetch'));
        }
        if (url.endsWith('/session-1')) {
            if (!requested)
                return jsonResponse(initial);
            if (!online || (failure === 'followup' && !failedRead)) {
                failedRead = true;
                return Promise.reject(new TypeError('Failed to fetch'));
            }
            return jsonResponse(refreshed());
        }
        if (url.endsWith('/apply'))
            return jsonResponse({ ...recoveredPlan, plan: { ...recoveredPlan.plan, status: 'applied' } });
        return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetcher);
    const onApply = vi.fn();
    render(<CreativeAssistantPanel open workspaceKey="plan-recovery" initialAssistantSessionId="session-1" workflowId="workflow-1" workflowName="Assistant Graph" workflow={originalWorkflow} references={[]} importImageFile={vi.fn()} onApplyWorkflow={onApply} onClose={vi.fn()}/>);
    const create = await screen.findByRole('button', { name: 'Replace current graph with Storyboard Writer' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Assistant message' }), { target: { value: 'My unrelated unsent creative note.' } });
    fireEvent.click(create);
    if (failure === 'unconfirmed') {
        expect(await screen.findByText('Couldn’t confirm whether the graph proposal was prepared. Reload the saved conversation before trying again.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Replace current graph with Storyboard Writer' })).toHaveProperty('disabled', true);
        online = true;
        fireEvent.click(screen.getByRole('button', { name: 'Reload saved conversation' }));
    }
    const apply = await screen.findByRole('button', { name: 'Open new workflow' });
    await waitFor(() => expect(apply).toHaveProperty('disabled', false));
    expect(screen.getByRole('textbox', { name: 'Assistant message' })).toHaveProperty('value', 'My unrelated unsent creative note.');
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/plans'))).toHaveLength(1);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(apply);
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    const request = fetcher.mock.calls.find(([url]) => url.endsWith('/apply'));
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ proposal_id: 'plan-1', confirmation_token: 'confirm-plan-1', workflow: { nodes: [] } });
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/runs'))).toBe(false);
});
