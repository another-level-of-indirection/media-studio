// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStudioGalleryFeed } from "@/hooks/studio/use-studio-gallery-feed";
import type { MediaAsset } from "@/lib/types";

const globalAsset: MediaAsset = {
  asset_id: "global-asset",
  created_at: "2026-06-12T00:00:00Z",
  generation_kind: "image",
  model_key: "gpt-image-2",
};

const projectAsset: MediaAsset = {
  asset_id: "project-asset",
  project_id: "project-1",
  created_at: "2026-06-12T01:00:00Z",
  generation_kind: "image",
  model_key: "gpt-image-2",
};

const emptyBatches = [];
const emptyJobs = [];
const initialAssets = [globalAsset];
const handleMessage = vi.fn();
let intersect: IntersectionObserverCallback;
const paginatedFeedOptions = {
  batches: emptyBatches,
  jobs: emptyJobs,
  assets: initialAssets,
  initialAssetLimit: 18,
  initialAssetsHasMore: true,
  initialAssetsNextOffset: 18,
  latestAsset: null,
  onMessage: handleMessage,
};

function pendingPage() {
  let resolve!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
  const response = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((done) => { resolve = done; });
  return {
    response,
    finish: () => resolve({
      ok: true,
      json: async () => ({ ok: true, assets: [projectAsset], offset: 18, has_more: false, next_offset: null }),
    }),
    fail: () => resolve({ ok: false, json: async () => ({ ok: false, error: "Try again" }) }),
  };
}

type FeedHarnessProps = {
  activeProjectId?: string | null;
  assets?: MediaAsset[];
  hasMore?: boolean;
};

function FeedHarness({ activeProjectId = null, assets = initialAssets, hasMore = false }: FeedHarnessProps) {
  const gallery = useStudioGalleryFeed({
    batches: emptyBatches,
    jobs: emptyJobs,
    assets,
    activeProjectId,
    initialAssetLimit: 18,
    initialAssetsHasMore: hasMore,
    initialAssetsNextOffset: hasMore ? 18 : null,
    latestAsset: null,
    onMessage: handleMessage,
  });

  return (
    <div>
      <div data-testid="asset-ids">{gallery.state.localAssets.map((asset) => asset.asset_id).join(",")}</div>
      <div ref={gallery.refs.galleryLoadMoreRef} />
      <button onClick={() => { void gallery.actions.loadMoreActiveGalleryAssets(); }}>Load more</button>
    </div>
  );
}

describe("useStudioGalleryFeed", () => {
  beforeEach(() => {
    handleMessage.mockClear();
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn((callback: IntersectionObserverCallback) => {
        intersect = callback;
        return { observe: vi.fn(), disconnect: vi.fn() };
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          assets: [projectAsset],
          has_more: false,
          next_offset: null,
        }),
      })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses the page effects path for one scoped first-page fetch on project changes", async () => {
    const { rerender } = render(<FeedHarness />);

    expect(screen.getByTestId("asset-ids").textContent).toBe("global-asset");
    expect(fetch).not.toHaveBeenCalled();

    rerender(<FeedHarness activeProjectId="project-1" />);

    await waitFor(() => expect(screen.getByTestId("asset-ids").textContent).toBe("project-asset"));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/control/media-assets?limit=18&offset=0&view=summary&project_id=project-1",
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      },
    );
  });

  it("appends one ordered next page when manual loading overlaps before a render", async () => {
    let resolveResponse!: (response: unknown) => void;
    const response = new Promise((resolve) => { resolveResponse = resolve; });
    const fetchPage = vi.fn(() => response);
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed({
      batches: emptyBatches,
      jobs: emptyJobs,
      assets: initialAssets,
      initialAssetLimit: 18,
      initialAssetsHasMore: true,
      initialAssetsNextOffset: 18,
      latestAsset: null,
      onMessage: handleMessage,
    }));

    await act(async () => {
      void result.current.actions.loadMoreActiveGalleryAssets();
      void result.current.actions.loadMoreActiveGalleryAssets();
      resolveResponse({
        ok: true,
        json: async () => ({ ok: true, assets: [projectAsset], offset: 18, has_more: false, next_offset: null }),
      });
      await response;
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["global-asset", "project-asset"]);
    expect(result.current.state.loadingMoreAssets).toBe(false);
  });

  it("shares a pending prefetch with manual loading and leaves the next page usable", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(document.body, "scrollHeight", { configurable: true, value: 5000 });
    const pending = pendingPage();
    const fetchPage = vi.fn(() => pending.response);
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions));
    act(() => { window.dispatchEvent(new Event("wheel")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    expect(fetchPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      void result.current.actions.loadMoreActiveGalleryAssets();
      pending.finish();
      await pending.response;
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["global-asset", "project-asset"]);
    expect(result.current.state.loadingMoreAssets).toBe(false);
  });

  it("uses a completed prefetch when the user later loads that page", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(document.body, "scrollHeight", { configurable: true, value: 5000 });
    const pending = pendingPage();
    const fetchPage = vi.fn(() => pending.response);
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions));
    act(() => { window.dispatchEvent(new Event("wheel")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    await act(async () => { pending.finish(); await pending.response; });
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["global-asset"]);

    await act(async () => { await result.current.actions.loadMoreActiveGalleryAssets(); });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["global-asset", "project-asset"]);
  });

  it("keeps the server-seeded first page through Strict Mode effect replay", async () => {
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions), {
      reactStrictMode: true,
    });
    await act(async () => { await Promise.resolve(); });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["global-asset"]);
    expect(result.current.state.assetFeedNextOffset).toBe(18);
  });

  it("does not append a pending old page after the kind filter changes", async () => {
    const pending = pendingPage();
    const imageAsset = { ...globalAsset, asset_id: "image-query-asset" };
    const fetchPage = vi.fn((url: string) => url.includes("offset=18") ? pending.response : Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, assets: [imageAsset], offset: 0, has_more: false, next_offset: null }),
    }));
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions));
    act(() => { void result.current.actions.loadMoreActiveGalleryAssets(); });
    await act(async () => { result.current.actions.setGalleryKindFilter("image"); });
    await act(async () => { pending.finish(); await pending.response; });

    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["image-query-asset"]);
    expect(result.current.state.loadingMoreAssets).toBe(false);
  });

  it("does not reload a consumed page through a callback captured before the next render", async () => {
    const pending = pendingPage();
    const fetchPage = vi.fn(() => pending.response);
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions));
    const loadMore = result.current.actions.loadMoreActiveGalleryAssets;

    await act(async () => {
      const loading = loadMore();
      pending.finish();
      await loading;
      await loadMore();
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["global-asset", "project-asset"]);
  });

  it("shares one page across prefetch, observer and button triggers", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(document.body, "scrollHeight", { configurable: true, value: 5000 });
    const pending = pendingPage();
    const fetchPage = vi.fn(() => pending.response);
    vi.stubGlobal("fetch", fetchPage);
    render(<FeedHarness hasMore />);
    act(() => { window.dispatchEvent(new Event("wheel")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    await act(async () => {
      intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      pending.finish();
      await pending.response;
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("asset-ids").textContent).toBe("global-asset,project-asset");
  });

  it("retries a failed shared prefetch and append without losing the existing cards", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(document.body, "scrollHeight", { configurable: true, value: 5000 });
    const failed = pendingPage();
    const retry = pendingPage();
    const fetchPage = vi.fn().mockReturnValueOnce(failed.response).mockReturnValueOnce(retry.response);
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions));
    act(() => { window.dispatchEvent(new Event("wheel")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    await act(async () => {
      const loading = result.current.actions.loadMoreActiveGalleryAssets();
      failed.fail();
      await loading;
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledWith({ tone: "danger", text: "Try again" });
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["global-asset"]);
    expect(result.current.state.loadingMoreAssets).toBe(false);
    await act(async () => {
      const loading = result.current.actions.loadMoreActiveGalleryAssets();
      retry.finish();
      await loading;
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["global-asset", "project-asset"]);
  });

  it("ignores an old append when the user switches filters away and back", async () => {
    const pending = pendingPage();
    const refreshed = { ...globalAsset, asset_id: "new-all-page" };
    const fetchPage = vi.fn((url: string) => url.includes("offset=18") ? pending.response : Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, assets: [refreshed], offset: 0, has_more: false, next_offset: null }),
    }));
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions));
    act(() => { void result.current.actions.loadMoreActiveGalleryAssets(); });
    await act(async () => { result.current.actions.setGalleryKindFilter("video"); });
    await act(async () => { result.current.actions.setGalleryKindFilter("all"); });
    await act(async () => { pending.finish(); await pending.response; });

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["new-all-page"]);
  });

  it.each(["model", "favorites", "project"] as const)("keeps a pending append out of the new %s scope", async (scope) => {
    const pending = pendingPage();
    const scoped = { ...projectAsset, asset_id: "scoped-first-page", favorited: true };
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("offset=18") ? pending.response : Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, assets: [scoped], offset: 0, has_more: false, next_offset: null }),
    })));
    const { result, rerender } = renderHook(({ projectId }) => useStudioGalleryFeed({
      ...paginatedFeedOptions, activeProjectId: projectId,
    }), { initialProps: { projectId: null as string | null } });
    act(() => { void result.current.actions.loadMoreActiveGalleryAssets(); });
    await act(async () => {
      if (scope === "model") result.current.actions.setGalleryModelFilter("gpt-image-2");
      if (scope === "favorites") result.current.actions.toggleFavoritesFilter();
      if (scope === "project") rerender({ projectId: "project-1" });
    });
    await act(async () => { pending.finish(); await pending.response; });

    const displayed = scope === "favorites" ? result.current.state.favoriteAssets : result.current.state.localAssets;
    expect(displayed?.map((asset) => asset.asset_id)).toEqual(["scoped-first-page"]);
    expect(result.current.state.localAssets.some((asset) => asset.asset_id === "project-asset")).toBe(false);
    expect(result.current.state.loadingMoreAssets).toBe(false);
  });

  it("waits for a new query's first page before using its next-page cursor", async () => {
    const pending = pendingPage();
    const fetchPage = vi.fn(() => pending.response);
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions));
    act(() => { result.current.actions.setGalleryKindFilter("image"); });
    act(() => { void result.current.actions.loadMoreActiveGalleryAssets(); });
    const requestCount = fetchPage.mock.calls.length;
    await act(async () => { pending.finish(); await pending.response; });
    expect(requestCount).toBe(1);
  });

  it("shares pending Favorites prefetch and append reads, then refreshes All media on return", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(document.body, "scrollHeight", { configurable: true, value: 5000 });
    const pending = pendingPage();
    const firstFavorite = { ...globalAsset, asset_id: "favorite-first", favorited: true };
    const fetchPage = vi.fn((url: string) => url.includes("offset=18") ? pending.response : Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, assets: [firstFavorite], offset: 0, has_more: true, next_offset: 18 }),
    }));
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions));
    await act(async () => { result.current.actions.toggleFavoritesFilter(); });
    act(() => { window.dispatchEvent(new Event("wheel")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    await act(async () => {
      const loading = result.current.actions.loadMoreActiveGalleryAssets();
      void result.current.actions.loadMoreActiveGalleryAssets();
      pending.finish();
      await loading;
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1][0]).toBe("/api/control/media-assets?limit=12&offset=18&view=summary&favorited=true");
    expect(result.current.state.favoriteAssets?.map((asset) => asset.asset_id)).toEqual(["favorite-first", "project-asset"]);
    expect(result.current.state.loadingMoreFavoriteAssets).toBe(false);

    await act(async () => { result.current.actions.toggleFavoritesFilter(); });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[2][0]).toBe("/api/control/media-assets?limit=18&offset=0&view=summary");
  });

  it("ignores a stale deliberate refresh while allowing fresh refresh reads", async () => {
    const pending = pendingPage();
    const scoped = { ...projectAsset, asset_id: "new-query-page" };
    const fetchPage = vi.fn().mockReturnValueOnce(pending.response).mockImplementation(async () => ({
      ok: true,
      json: async () => ({ ok: true, assets: [scoped], offset: 0, has_more: false, next_offset: null }),
    }));
    vi.stubGlobal("fetch", fetchPage);
    const { result } = renderHook(() => useStudioGalleryFeed(paginatedFeedOptions));
    let refreshing!: Promise<boolean>;
    act(() => { refreshing = result.current.actions.refreshActiveGalleryAssets(); });
    await act(async () => { result.current.actions.setGalleryKindFilter("image"); });
    await act(async () => { pending.finish(); expect(await refreshing).toBe(false); });
    expect(result.current.state.localAssets.map((asset) => asset.asset_id)).toEqual(["new-query-page"]);
    await act(async () => {
      expect(await result.current.actions.refreshActiveGalleryAssets()).toBe(true);
      expect(await result.current.actions.refreshActiveGalleryAssets()).toBe(true);
    });
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });
});
