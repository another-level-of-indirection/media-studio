// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GraphLibraryDialog } from "@/components/graph-studio/graph-library-dialogs";
import type { GraphNodeDefinition } from "@/components/graph-studio/types";

function makeDefinition(overrides: Partial<GraphNodeDefinition> = {}): GraphNodeDefinition {
  return {
    type: "prompt.recipe",
    title: "Prompt Recipe",
    description: "Run a saved prompt recipe.",
    category: "Prompt",
    ports: { inputs: [], outputs: [] },
    fields: [],
    ...overrides,
  };
}

function renderLibraryDialog(
  overrides: Partial<Parameters<typeof GraphLibraryDialog>[0]> = {},
) {
  const props: Parameters<typeof GraphLibraryDialog>[0] = {
    sidebarDialog: "nodes",
    definitions: [],
    definitionsByCategory: {},
    workspaceKey: "test-workspace",
    workflowBrowser: { workflows: [], query: "", setQuery: vi.fn(), offset: 0, setOffset: vi.fn(), nextOffset: null, total: 0, loading: false, error: null, refresh: vi.fn(async () => undefined) },
    templates: [],
    references: [],
    assets: [],
    workflowId: null,
    runHistory: [],
    selectedHistoryRunId: null,
    selectedRunArtifacts: [],
    onClose: vi.fn(),
    onLoadStarterTemplate: vi.fn(),
    onLoadWorkflow: vi.fn(),
    onInstantiateTemplate: vi.fn(),
    onDeleteWorkflow: vi.fn(),
    onDeleteTemplate: vi.fn(),
    onImportWorkflow: vi.fn(),
    onAddDefinitionNode: vi.fn(),
    onRefreshRunHistory: vi.fn(),
    onInspectRun: vi.fn(),
    onRestoreRun: vi.fn(),
    onPinArtifact: vi.fn(),
    ...overrides,
  };

  return { ...render(<GraphLibraryDialog {...props} />), props };
}

describe("GraphLibraryDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hides hidden internal definitions from the default node library", () => {
    const visibleDefinition = makeDefinition();
    const hiddenDefinition = makeDefinition({
      type: "internal.hidden_debug",
      title: "Internal Hidden Debug",
      source: {
        kind: "system",
        hidden_in_search: true,
      },
    });

    renderLibraryDialog({
      sidebarDialog: "nodes",
      definitions: [visibleDefinition, hiddenDefinition],
      definitionsByCategory: {
        Prompt: [visibleDefinition, hiddenDefinition],
      },
    });

    expect(screen.getByRole("button", { name: /prompt recipe/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /internal hidden debug/i })).toBeNull();
  });

  it("keeps the starter template disabled until all required node definitions are ready", () => {
    const requiredTypes = [
      "prompt.text",
      "media.load_image",
      "model.kie.nano_banana_pro",
      "media.save_image",
    ];
    const definitions = requiredTypes.map((type) =>
      makeDefinition({ type, title: type }),
    );
    const { rerender, props } = renderLibraryDialog({
      sidebarDialog: "workflows",
      definitions: definitions.slice(0, -1),
    });

    const starter = screen.getByTestId("graph-template-nano-image-pipeline");
    expect(starter.hasAttribute("disabled")).toBe(true);

    rerender(<GraphLibraryDialog {...props} definitions={definitions} />);
    expect(starter.hasAttribute("disabled")).toBe(false);
  });

  it("offers server search and bounded paging, with detail and archive handoffs", async () => {
    const workflow = { workflow_id: "outside-first-page", name: "Outside first page" };
    const browser = { workflows: [workflow], query: "", setQuery: vi.fn(), offset: 0, setOffset: vi.fn(), nextOffset: 60, total: 65, loading: false, error: null, refresh: vi.fn(async () => undefined) };
    const detail = { ...workflow, workflow_json: { nodes: [], edges: [] } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(detail)));
    const { props } = renderLibraryDialog({ sidebarDialog: "workflows", workflowBrowser: browser });
    fireEvent.change(screen.getByRole("textbox", { name: "Search workflows" }), { target: { value: "Outside" } });
    expect(browser.setQuery).toHaveBeenCalledWith("Outside");
    fireEvent.click(screen.getByRole("button", { name: "Next workflows page" }));
    expect(browser.setOffset).toHaveBeenCalledWith(60);
    fireEvent.click(screen.getByRole("button", { name: /^Outside first pageoutside-first-page$/ }));
    await waitFor(() => expect(props.onLoadWorkflow).toHaveBeenCalledWith(detail, expect.any(Function)));
    fireEvent.click(screen.getByRole("button", { name: "Delete workflow Outside first page" }));
    expect(props.onDeleteWorkflow).toHaveBeenCalledWith(workflow);
  });
});
