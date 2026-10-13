// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useGraphWorkflowActions } from "./use-graph-workflow-actions";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const props: Parameters<typeof useGraphWorkflowActions>[0] = {
  workflowId: null, workflowName: "Test", renameDraft: "Test", nodes: [], edges: [],
  workflowFromCanvas: () => ({ schema_version: 1, workflow_id: null, name: "Test", nodes: [], edges: [] }),
  setWorkflowId: vi.fn(), setWorkflowName: vi.fn(), setWorkflowUpdatedAt: vi.fn(),
  setRun: vi.fn(), setNodes: vi.fn(), setEdges: vi.fn(), setConsoleLines: vi.fn(),
  setWorkflowMenuOpen: vi.fn(), setRenameDialogOpen: vi.fn(), appendConsole: vi.fn(),
};

it("saves while the catalog is closed without downloading a workflow list", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method
    ? { workflow_id: "saved", name: "Saved" } : { items: [] }));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useGraphWorkflowActions(props));
  await act(async () => { await result.current.saveWorkflow(); });
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST"]);
});

it("refreshes the visible summary page after save or archive, and avoids reads after closing", async () => {
  let saved = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method) {
      saved = init.method !== "DELETE";
      return Response.json({ workflow_id: "saved", name: "Saved" });
    }
    return Response.json({ items: [{ workflow_id: "saved", name: saved ? "Saved" : "Before" }], limit: 60, offset: 0, total: 1, next_offset: null });
  });
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(({ open }) => useGraphWorkflowActions({ ...props, browserOpen: open }), { initialProps: { open: true } });
  await waitFor(() => expect(result.current.workflowBrowser.workflows[0]?.name).toBe("Before"));
  await act(async () => { await result.current.saveWorkflow(); });
  await waitFor(() => expect(result.current.workflowBrowser.workflows[0]?.name).toBe("Saved"));
  await act(async () => { await result.current.deleteWorkflowRecord({ workflow_id: "saved", name: "Saved" }); });
  expect(result.current.workflowBrowser.workflows[0]?.name).toBe("Before");
  rerender({ open: false });
  fetcher.mockClear();
  await act(async () => { await result.current.saveWorkflowAs(); });
  expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST"]);
});
