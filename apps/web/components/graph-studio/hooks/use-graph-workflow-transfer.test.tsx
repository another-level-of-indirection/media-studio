// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useGraphMediaLibrary } from "./use-graph-media-library";
import { useGraphImageSelectorSources } from "./use-graph-image-selector-sources";
import { useGraphWorkflowTransfer } from "./use-graph-workflow-transfer";
import type { MediaReference } from "@/lib/types";

vi.mock("../utils/graph-workflow-transfer", () => ({
  buildWorkflowBundle: vi.fn(), downloadGraphBlob: vi.fn(), sanitizeWorkflowForExport: vi.fn(),
  parseWorkflowImportFile: async (_file: File, importReference: (file: File) => Promise<MediaReference>) => {
    await importReference(new File(["embedded"], "embedded.png"));
    return { workflow: { name: "Bundle", nodes: [], edges: [] }, warnings: [] };
  },
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("workflow bundle media uses the same import owner and invalidates a fresh Imported page", async () => {
  let imported = false;
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      imported = true;
      return { ok: true, json: async () => ({ item: { reference_id: "embedded", kind: "image", stored_url: "/original.png" } }) };
    }
    return { ok: true, json: async () => ({ items: imported ? [{ reference_id: "embedded", kind: "image", stored_url: "/original.png" }] : [], next_offset: null }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => {
    const library = useGraphMediaLibrary();
    const selector = useGraphImageSelectorSources("image", library.mediaRevision);
    const transfer = useGraphWorkflowTransfer({
      workflowId: null, workflowName: "Bundle", nodes: [], edges: [], definitions: [], references: library.references,
      importImageFile: library.importImageFile, workflowFromCanvas: vi.fn(), hydrateWorkflowPayload: vi.fn(),
      setWorkflowMenuOpen: vi.fn(), appendConsole: vi.fn(),
    });
    return { library, selector, transfer };
  });
  await act(async () => { await result.current.selector.loadSource("imported"); });
  expect(result.current.selector.imported.items).toEqual([]);
  await act(async () => { await result.current.transfer.importWorkflowFile(new File(["mock zip"], "bundle.zip")); });
  expect(result.current.library.mediaRevision).toBe(1);
  await act(async () => { await result.current.selector.loadSource("imported"); });
  expect(result.current.selector.imported.items[0]?.id).toBe("embedded");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
