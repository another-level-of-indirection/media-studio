// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

import type { GraphRun } from "../types";
import { useGraphWorkflowRunPreview } from "./use-graph-workflow-run-preview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const savedRun = { run_id: "run-a", workflow_id: "saved-a", status: "completed", nodes: [], workflow_json: { schema_version: 1, name: "Saved A", nodes: [], edges: [] } } as unknown as GraphRun;

function previewHarness() {
  const version = { current: 1 };
  return renderHook(() => {
    const [run, setRun] = useState<GraphRun | null>(null);
    const [preview, setPreview] = useState("dirty-preview");
    const [consoleLines, setConsoleLines] = useState(["Keep dirty console"]);
    const restore = useGraphWorkflowRunPreview({
      nodes: [], setRun, setConsoleLines, workspaceRestoreVersionRef: version,
      applyRunNodesToCanvas: (value) => setPreview(value.run_id),
      applyRunEventsToCanvas: () => setPreview("saved-event-preview"),
      appendConsole: (line) => setConsoleLines((lines) => [...lines, line]),
      refreshAssetsByIds: async () => undefined,
    });
    return { ...restore, run, preview, consoleLines, returnToDirtyTab: () => {
      version.current += 1; setRun(null); setPreview("dirty-preview"); setConsoleLines(["Keep dirty console"]);
    } };
  });
}

it.each(["summary", "detail", "events"])("returning to a dirty tab ignores delayed preview %s", async (phase) => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn((url: string) => {
    const kind = url.includes("/summary") ? "summary" : url.endsWith("/events") ? "events" : "detail";
    if (kind === phase) return new Promise<Response>((done) => { resolve = done; });
    return Promise.resolve(Response.json(kind === "summary" ? { items: [{ workflow_id: "saved-a", run_id: "run-a" }] } : kind === "detail" ? savedRun : { items: [] }));
  });
  vi.stubGlobal("fetch", fetcher);
  const { result } = previewHarness();
  let pending!: Promise<void>;
  act(() => { pending = result.current.hydrateLatestRunForWorkflow("saved-a"); });
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  act(() => result.current.returnToDirtyTab());
  await act(async () => {
    resolve(Response.json(phase === "summary" ? { items: [{ workflow_id: "saved-a", run_id: "run-a" }] }
      : phase === "detail" ? savedRun : { items: [{ event_id: "event-a", run_id: "run-a", event_type: "node.completed", payload_json: { node_id: "shared" } }] }));
    await pending;
  });
  expect(result.current.run).toBeNull();
  expect(result.current.preview).toBe("dirty-preview");
  expect(result.current.consoleLines).toEqual(["Keep dirty console"]);
});

it("restores the run preview while the selected workspace is still current", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("/summary")
    ? { items: [{ workflow_id: "saved-a", run_id: "run-a" }] } : url.endsWith("/events") ? { items: [] } : savedRun)));
  const { result } = previewHarness();
  await act(async () => { await result.current.hydrateLatestRunForWorkflow("saved-a"); });
  expect(result.current.run).toEqual(savedRun);
  expect(result.current.preview).toBe("run-a");
});
