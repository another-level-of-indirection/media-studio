// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioNode } from "../types";
import { useGraphMediaLibrary } from "./use-graph-media-library";

const { jsonFetch } = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("../utils/graph-api", () => ({ creditBalanceFromPayload: vi.fn(() => null), jsonFetch }));
const node = (fields: Record<string, unknown>, outputSnapshot = {}) => ({
  id: "load", data: { fields, outputSnapshot },
}) as StudioNode;

afterEach(() => { cleanup(); jsonFetch.mockReset(); vi.unstubAllGlobals(); });

describe("Graph restoration media ownership", () => {
  it("reads only selected IDs and output refs, including old records beyond page one", async () => {
    jsonFetch.mockImplementation(async (url: string) => url.includes("media-assets/")
      ? { asset: { asset_id: url.split("/").pop(), payload: { outputs: [{ width: 2048 }] } } }
      : { item: { reference_id: url.split("/").pop(), kind: "image", stored_url: "/original.png" } });
    const nodes = [node({ asset_id: "old" }, { images: [{ asset_id: "output" }] }), node({ reference_id: "old-ref" })];
    const { result, rerender } = renderHook(({ nodes }) => useGraphMediaLibrary(nodes), { initialProps: { nodes } });
    await waitFor(() => expect(result.current.assets).toHaveLength(2));
    expect(result.current.references[0]?.reference_id).toBe("old-ref");
    expect(jsonFetch.mock.calls.map(([url]) => url).sort()).toEqual([
      "/api/control/media-assets/old", "/api/control/media-assets/output", "/api/control/reference-media/old-ref",
    ]);
    rerender({ nodes: [...nodes, node({ asset_id: "old" })] });
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    expect(result.current.assets[0]?.payload?.outputs).toEqual([{ width: 2048 }]);
  });

  it("deduplicates concurrent details and retains selected old metadata under the 80 record bound", async () => {
    let resolve!: (value: unknown) => void;
    jsonFetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { result } = renderHook(() => useGraphMediaLibrary([node({ asset_id: "old" })]));
    const second = result.current.refreshAssetsByIds(["old", "old"]);
    await act(async () => { resolve({ asset: { asset_id: "old", created_at: "2000" } }); await second; });
    expect(jsonFetch).toHaveBeenCalledTimes(1);
    jsonFetch.mockImplementation(async (url: string) => ({ asset: { asset_id: url.split("/").pop(), created_at: "2026" } }));
    await act(async () => { await result.current.refreshAssetsByIds(Array.from({ length: 90 }, (_, i) => `new-${i}`)); });
    expect(result.current.assets).toHaveLength(80);
    expect(result.current.assets[0]?.asset_id).toBe("old");
  });

  it("invalidates picker metadata after a mocked import without reading gallery pages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ item: { reference_id: "new", kind: "image" } }) })));
    const { result } = renderHook(() => useGraphMediaLibrary());
    await act(async () => { await result.current.importImageFile(new File(["mock"], "mock.png")); });
    expect(result.current.mediaRevision).toBe(1);
    expect(result.current.references[0]?.reference_id).toBe("new");
    expect(jsonFetch).not.toHaveBeenCalled();
  });
});
