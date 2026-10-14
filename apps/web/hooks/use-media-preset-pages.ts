"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MediaPreset, MediaPresetSummaryItem } from "@/lib/types";

type PresetViews = { full: MediaPreset; summary: MediaPresetSummaryItem };
export type MediaPresetPage<T> = {
  presets: T[];
  total: number;
  offset: number;
  next_offset: number | null;
};

export function useMediaPresetPages<V extends keyof PresetViews>({
  query,
  category = "all",
  view,
  seed = null,
  refreshKey,
}: {
  query: string;
  category?: string;
  view: V;
  seed?: MediaPresetPage<PresetViews[V]> | null;
  refreshKey: object;
}) {
  type Page = MediaPresetPage<PresetViews[V]>;
  const normalizedQuery = query.trim();
  const scope = useMemo(() => ({ query: normalizedQuery, category, view, seed, refreshKey }), [normalizedQuery, category, view, seed, refreshKey]);
  // A refreshed server seed starts a new request owner. Settled pages are never cached.
  const requests = useMemo(() => new Map<string, Promise<Page>>(), [seed, refreshKey]);
  const seedPage = scope.query === "" && category === "all" ? seed : null;
  const [state, setState] = useState({ scope, page: seedPage, error: null as string | null, loading: !seedPage, loadingMore: false });
  const [retryVersion, setRetryVersion] = useState(0);
  const activeScope = useRef(scope);
  const appendRequest = useRef<{ scope: typeof scope; offset: number } | null>(null);
  const current = state.scope === scope ? state : { scope, page: seedPage, error: null, loading: !seedPage, loadingMore: false };

  const fetchPage = useCallback((offset: number) => {
    const params = new URLSearchParams({ limit: "60", offset: String(offset), status: "active" });
    if (view === "summary") params.set("view", view);
    if (scope.query) params.set("q", scope.query);
    if (category !== "all") params.set("category", category);
    const url = `/api/control/media-presets?${params.toString()}`;
    const existing = requests.get(url);
    if (existing) return existing;
    const request = (async (): Promise<Page> => {
      const response = await fetch(url);
      const payload = (await response.json()) as Partial<Page> & { ok?: boolean; error?: string };
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? "Unable to load presets.");
      const presets = Array.isArray(payload.presets) ? payload.presets : [];
      return { presets, total: Number(payload.total ?? presets.length), offset: Number(payload.offset ?? offset), next_offset: payload.next_offset ?? null };
    })().finally(() => requests.delete(url));
    requests.set(url, request);
    return request;
  }, [category, requests, scope.query, view]);

  useEffect(() => {
    let cancelled = false;
    activeScope.current = scope;
    setState({ scope, page: seedPage, error: null, loading: !seedPage, loadingMore: false });
    if (!seedPage) {
      void fetchPage(0).then(
        (page) => { if (!cancelled) setState({ scope, page, error: null, loading: false, loadingMore: false }); },
        (error: unknown) => {
          if (!cancelled) setState({ scope, page: null, error: error instanceof Error ? error.message : "Unable to load presets.", loading: false, loadingMore: false });
        },
      );
    }
    return () => { cancelled = true; };
  }, [fetchPage, retryVersion, scope, seedPage]);

  const loadMore = useCallback(async () => {
    const offset = current.page?.next_offset;
    if (offset == null || current.loading || activeScope.current !== scope) return;
    if (appendRequest.current?.scope === scope && appendRequest.current.offset === offset) return;
    const request = { scope, offset };
    appendRequest.current = request;
    setState((value) => ({ ...value, error: null, loadingMore: true }));
    try {
      const page = await fetchPage(offset);
      if (activeScope.current !== scope) return;
      setState((value) => {
        if (value.scope !== scope || value.page?.next_offset !== offset) return value;
        const ids = new Set(value.page.presets.map((preset) => preset.preset_id));
        const presets = [...value.page.presets];
        for (const preset of page.presets) {
          if (!ids.has(preset.preset_id)) { ids.add(preset.preset_id); presets.push(preset); }
        }
        return { ...value, page: { ...page, presets, offset: 0 }, loadingMore: false };
      });
    } catch (error) {
      if (appendRequest.current === request) appendRequest.current = null;
      if (activeScope.current === scope) setState((value) => ({ ...value, error: error instanceof Error ? error.message : "Unable to load more presets.", loadingMore: false }));
    }
  }, [current.loading, current.page?.next_offset, fetchPage, scope]);

  const retry = useCallback(() => {
    if (current.page) void loadMore();
    else setRetryVersion((version) => version + 1);
  }, [current.page, loadMore]);

  return { ...current, loadMore, retry };
}
