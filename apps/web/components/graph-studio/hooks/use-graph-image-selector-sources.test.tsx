// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useGraphImageSelectorSources } from "./use-graph-image-selector-sources";

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useGraphImageSelectorSources", () => {
  it("loads generated, imported, search, pagination, and explicit project scope from source URLs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/control/media/projects")) {
        return jsonResponse({
          ok: true,
          projects: [
            {
              project_id: "project_ab78ce28660d",
              name: "Sadi",
              status: "active",
              hidden_from_global_gallery: true,
            },
          ],
        });
      }
      if (url.includes("/api/control/media-assets")) {
        const isPaged = url.includes("offset=40");
        return jsonResponse({
          ok: true,
          assets: [
            {
              asset_id: isPaged ? "asset-sadi-2" : "asset-sadi-1",
              generation_kind: "image",
              created_at: "2026-06-22T12:00:00Z",
              prompt_summary: "Sadi image",
              hero_thumb_url: isPaged
                ? "/generated-sadi-2-thumb.webp"
                : "/generated-sadi-1-thumb.webp",
              hero_web_url: isPaged
                ? "/generated-sadi-2.webp"
                : "/generated-sadi-1.webp",
            },
          ],
          next_offset: isPaged ? null : 40,
        });
      }
      if (url.includes("/api/control/reference-media")) {
        return jsonResponse({
          ok: true,
          items: [
            {
              reference_id: "reference-sadi-1",
              kind: "image",
              original_filename: "sadi-reference.png",
              stored_url: "/references/sadi-reference.png",
              thumb_url: "/references/sadi-reference-thumb.png",
            },
          ],
          next_offset: null,
        });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useGraphImageSelectorSources());

    await act(async () => {
      await result.current.loadProjects();
    });
    expect(result.current.projectOptions).toEqual([
      {
        projectId: "project_ab78ce28660d",
        label: "Sadi",
        status: "active",
        hiddenFromGlobalGallery: true,
      },
    ]);

    await act(async () => {
      await result.current.loadSource("generated");
    });
    expect(result.current.generated.items.map((item) => item.id)).toEqual([
      "asset-sadi-1",
    ]);

    await act(async () => {
      await result.current.loadSource("generated", { append: true });
    });
    expect(result.current.generated.items.map((item) => item.id)).toEqual([
      "asset-sadi-1",
      "asset-sadi-2",
    ]);

    await act(async () => {
      result.current.setSearchQuery("Sadie");
      result.current.setProjectId("project_ab78ce28660d");
      await result.current.loadSource("imported", {
        query: "Sadie",
        projectId: "project_ab78ce28660d",
      });
    });

    await waitFor(() => {
      expect(result.current.imported.items.map((item) => item.id)).toEqual([
        "reference-sadi-1",
      ]);
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          "/api/control/media-assets?limit=40&offset=0&generation_kind=image&view=picker",
        ),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          "/api/control/media-assets?limit=40&offset=40&generation_kind=image&view=picker",
        ),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          "/api/control/reference-media?limit=40&offset=0&kind=image&q=Sadie&project_id=project_ab78ce28660d",
        ),
      ),
    ).toBe(true);
  });

  it("can load video and audio selector sources without image-only URLs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("generation_kind=video")) {
        return jsonResponse({
          ok: true,
          assets: [
            {
              asset_id: "asset-video-1",
              generation_kind: "video",
              created_at: "2026-06-22T12:00:00Z",
              prompt_summary: "Motion clip",
              hero_original_url: "/generated-video.mp4",
              hero_poster_url: "/generated-video.webp",
              width: 1920,
              height: 1080,
              duration_seconds: 5.25,
              project_id: "project-video",
            },
          ],
          next_offset: null,
        });
      }
      if (url.includes("kind=video")) {
        return jsonResponse({
          ok: true,
          items: [
            {
              reference_id: "reference-video-1",
              kind: "video",
              status: "active",
              original_filename: "source-video.mp4",
              stored_path: "references/source-video.mp4",
              stored_url: "/references/source-video.mp4",
              poster_url: "/references/source-video.webp",
              width: 1280,
              height: 720,
              duration_seconds: 20.083333,
              attached_project_ids: ["project-video"],
              file_size_bytes: 1000,
              sha256: "video-sha",
              usage_count: 0,
            },
          ],
          next_offset: null,
        });
      }
      if (url.includes("generation_kind=audio")) {
        return jsonResponse({
          ok: true,
          assets: [
            {
              asset_id: "asset-audio-1",
              generation_kind: "audio",
              created_at: "2026-06-22T12:00:00Z",
              prompt_summary: "Audio clip",
              hero_original_url: "/generated-audio.wav",
              duration_seconds: 5,
              project_id: "project-audio",
            },
          ],
          next_offset: null,
        });
      }
      if (url.includes("kind=audio")) {
        return jsonResponse({
          ok: true,
          items: [
            {
              reference_id: "reference-audio-1",
              kind: "audio",
              status: "active",
              original_filename: "source-audio.wav",
              stored_path: "references/source-audio.wav",
              stored_url: "/references/source-audio.wav",
              mime_type: "audio/wav",
              attached_project_ids: ["project-audio"],
              file_size_bytes: 1000,
              sha256: "audio-sha",
              usage_count: 0,
              duration_seconds: 5,
              metadata: {
                format_name: "wav",
              },
            },
          ],
          next_offset: null,
        });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const videoHook = renderHook(() => useGraphImageSelectorSources("video"));
    await act(async () => {
      await videoHook.result.current.loadSource("generated", {
        query: "motion",
        projectId: "project-video",
      });
      await videoHook.result.current.loadSource("imported", {
        query: "motion",
        projectId: "project-video",
      });
    });

    expect(videoHook.result.current.generated.items[0]).toMatchObject({
      id: "asset-video-1",
      source: "generated-video",
      mediaType: "video",
      durationSeconds: 5.25,
      projectLabel: "project-video",
      trimReady: true,
    });
    expect(videoHook.result.current.imported.items[0]).toMatchObject({
      id: "reference-video-1",
      source: "reference-video",
      mediaType: "video",
      durationSeconds: 20.083333,
      projectLabel: "project-video",
      trimReady: true,
    });

    const audioHook = renderHook(() => useGraphImageSelectorSources("audio"));
    await act(async () => {
      await audioHook.result.current.loadSource("generated", {
        query: "dialog",
        projectId: "project-audio",
      });
      await audioHook.result.current.loadSource("imported", {
        query: "dialog",
        projectId: "project-audio",
      });
    });

    expect(audioHook.result.current.generated.items[0]).toMatchObject({
      id: "asset-audio-1",
      source: "generated-audio",
      mediaType: "audio",
      durationSeconds: 5,
      formatLabel: "WAV",
      projectLabel: "project-audio",
      trimReady: false,
    });
    expect(audioHook.result.current.imported.items[0]).toMatchObject({
      id: "reference-audio-1",
      source: "reference-audio",
      mediaType: "audio",
      durationSeconds: 5,
      formatLabel: "WAV",
      projectLabel: "project-audio",
      trimReady: false,
    });
    expect(
      [...audioHook.result.current.generated.items, ...audioHook.result.current.imported.items].every(
        (item) => item.mediaType === "audio",
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          "/api/control/media-assets?limit=40&offset=0&generation_kind=video&view=picker&q=motion&project_id=project-video",
        ),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          "/api/control/reference-media?limit=40&offset=0&kind=video&q=motion&project_id=project-video",
        ),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          "/api/control/media-assets?limit=40&offset=0&generation_kind=audio&view=picker&q=dialog&project_id=project-audio",
        ),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes(
          "/api/control/reference-media?limit=40&offset=0&kind=audio&q=dialog&project_id=project-audio",
        ),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("kind=image") ||
        String(url).includes("generation_kind=image"),
      ),
    ).toBe(false);
  });
});

describe("Graph first-page reuse", () => {
  function setup() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://local");
      const offset = Number(url.searchParams.get("offset"));
      const tag = `${url.searchParams.get("project_id")}-${url.searchParams.get("q")}`;
      return jsonResponse(url.pathname.endsWith("media-assets") ? {
        ok: true, assets: Array.from({ length: 40 }, (_, i) => ({ asset_id: `${tag}-${offset + i}`, generation_kind: "image", hero_thumb_path: "thumb.webp", hero_thumb_url: "/thumb.webp", hero_original_url: "/original.png" })), next_offset: offset + 40,
      } : { ok: true, items: [{ reference_id: tag, kind: "image", thumb_url: "/ref-thumb.webp", stored_url: "/ref-original.png" }], next_offset: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reuses first pages for 30 seconds, resets to page one after paging, and refreshes explicitly", async () => {
    const fetchMock = setup();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { result } = renderHook(() => useGraphImageSelectorSources());
    await act(async () => { await result.current.loadSource("generated"); await result.current.loadSource("imported"); });
    await act(async () => { await result.current.loadSource("generated", { append: true }); });
    await act(async () => { await result.current.loadSource("generated", { append: true }); });
    expect(result.current.generated.items).toHaveLength(80);
    expect(result.current.generated.items[0]?.id).toContain("40");
    await act(async () => { await result.current.loadSource("generated"); await result.current.loadSource("imported"); });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.current.generated.items).toHaveLength(40);
    expect(result.current.generated.nextOffset).toBe(40);
    expect(result.current.generated.items[0]).toMatchObject({ previewUrl: "/api/control/files/thumb.webp", fullUrl: "/original.png" });
    now.mockReturnValue(31_001);
    await act(async () => { await result.current.loadSource("generated"); });
    await act(async () => { await result.current.loadSource("generated", { force: true }); });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    now.mockRestore();
  });

  it("isolates source, query and project and invalidates both pages on mocked new-media revision", async () => {
    const fetchMock = setup();
    const { result, rerender } = renderHook(({ revision }) => useGraphImageSelectorSources("image", revision), { initialProps: { revision: 0 } });
    await act(async () => { await result.current.loadSource("generated"); await result.current.loadSource("imported"); });
    await act(async () => { result.current.setProjectId("private"); await result.current.loadSource("generated", { projectId: "private", query: "old" }); });
    expect(result.current.generated.items[0]?.id).toBe("private-old-0");
    await act(async () => { await result.current.loadSource("generated", { projectId: null, query: "" }); });
    expect(result.current.generated.items[0]?.id).toBe("null-null-0");
    rerender({ revision: 1 });
    await act(async () => { await result.current.loadSource("generated", { projectId: null, query: "" }); await result.current.loadSource("imported", { projectId: null, query: "" }); });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("does not reuse failed refreshes and retries the page", async () => {
    const fetchMock = setup();
    const { result } = renderHook(() => useGraphImageSelectorSources());
    await act(async () => { await result.current.loadSource("generated"); });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await result.current.loadSource("generated", { force: true }); });
    expect(result.current.generated.error).toBe("offline");
    await act(async () => { await result.current.loadSource("generated", { force: true }); });
    expect(result.current.generated.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

it("ignores a delayed page after project or media scope changes and deduplicates overlapping first-page reads", async () => {
  let resolve!: (value: ReturnType<typeof jsonResponse>) => void;
  const fetchMock = vi.fn(() => new Promise<ReturnType<typeof jsonResponse>>((done) => { resolve = done; }));
  vi.stubGlobal("fetch", fetchMock);
  const { result, rerender } = renderHook(({ type }) => useGraphImageSelectorSources(type), { initialProps: { type: "image" as "image" | "video" } });
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.loadSource("generated");
    await result.current.loadSource("generated");
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  act(() => result.current.setProjectId("private"));
  await act(async () => {
    resolve(jsonResponse({ assets: [{ asset_id: "global", hero_thumb_url: "/global.webp", generation_kind: "image" }] }));
    await pending;
  });
  expect(result.current.generated.items).toEqual([]);
  await act(async () => { pending = result.current.loadSource("generated"); });
  rerender({ type: "video" });
  await act(async () => {
    resolve(jsonResponse({ assets: [{ asset_id: "private-image", hero_thumb_url: "/private.webp", generation_kind: "image" }] }));
    await pending;
  });
  expect(result.current.generated.items).toEqual([]);
});
