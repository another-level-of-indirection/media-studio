// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useGraphWorkflowSelection } from "./use-graph-workflow-selection";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("hands off full detail only after the selected workflow has loaded", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal("fetch", fetcher);
  const onLoad = vi.fn();
  const { result } = renderHook(() => useGraphWorkflowSelection(true, "dirty-tab", onLoad));
  let pending!: Promise<void>;
  act(() => { pending = result.current.select("wf-2"); });
  expect(onLoad).not.toHaveBeenCalled();
  const detail = { workflow_id: "wf-2", name: "Saved", workflow_json: { nodes: [], edges: [] } };
  await act(async () => { resolve(Response.json(detail)); await pending; });
  expect(fetcher.mock.calls[0][0]).toBe("/api/control/media/graph/workflows/wf-2");
  expect(onLoad).toHaveBeenCalledWith(detail, expect.any(Function));
});

it("rejects a detail response for a different workflow", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workflow_id: "wrong", name: "Wrong", workflow_json: { nodes: [], edges: [] } })));
  const onLoad = vi.fn();
  const { result } = renderHook(() => useGraphWorkflowSelection(true, "dirty-tab", onLoad));
  await act(async () => { await result.current.select("wf-2"); });
  expect(onLoad).not.toHaveBeenCalled();
  expect(result.current.error).toBe("The selected workflow detail is unavailable.");
});

it.each(["close", "workspace"])("discards pending detail after %s and resets loading on reopen", async (change) => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  const onLoad = vi.fn();
  const { result, rerender } = renderHook(({ open, key }) => useGraphWorkflowSelection(open, key, onLoad), { initialProps: { open: true, key: "dirty-tab" } });
  let pending!: Promise<void>;
  act(() => { pending = result.current.select("wf-2"); });
  rerender({ open: change !== "close", key: change === "workspace" ? "edited-or-switched-tab" : "dirty-tab" });
  await act(async () => { resolve(Response.json({ workflow_id: "wf-2", name: "Saved", workflow_json: { nodes: [], edges: [] } })); await pending; });
  expect(onLoad).not.toHaveBeenCalled();
  rerender({ open: true, key: "dirty-tab" });
  expect(result.current.loadingId).toBeNull();
});

it("a newer selection supersedes detail still in flight and its hydration guard", async () => {
  let resolveOld!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolveOld = done; }))
    .mockResolvedValueOnce(Response.json({ workflow_id: "new", name: "New", workflow_json: { nodes: [], edges: [] } })));
  const onLoad = vi.fn();
  const { result } = renderHook(() => useGraphWorkflowSelection(true, "dirty-tab", onLoad));
  let old!: Promise<void>;
  act(() => { old = result.current.select("old"); });
  await act(async () => { await result.current.select("new"); });
  await act(async () => { resolveOld(Response.json({ workflow_id: "old", name: "Old", workflow_json: { nodes: [], edges: [] } })); await old; });
  expect(onLoad.mock.calls.map(([record]) => record.workflow_id)).toEqual(["new"]);
  const stillCurrent = onLoad.mock.calls[0][1];
  act(() => { void result.current.select("new"); });
  expect(stillCurrent()).toBe(false);
});
