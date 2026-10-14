import { useCallback, useEffect, useRef, useState } from "react";

import type { GraphWorkflowSummaryPage } from "../types";
import { jsonFetch } from "../utils/graph-api";

export function useGraphWorkflowBrowser(open: boolean) {
  const [page, setPage] = useState<GraphWorkflowSummaryPage>({ items: [], total: 0, limit: 60, offset: 0, next_offset: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQueryValue] = useState("");
  const [offset, setOffset] = useState(0);
  const revision = useRef(0);
  const request = useRef<AbortController | null>(null);
  const currentQuery = useRef({ open, query, offset });
  currentQuery.current = { open, query, offset };

  const refresh = useCallback(async () => {
    const { open, query, offset } = currentQuery.current;
    if (!open) return;
    const current = ++revision.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "60", offset: String(offset) });
      if (query.trim()) params.set("q", query.trim());
      const result = await jsonFetch<GraphWorkflowSummaryPage>(`/api/control/media/graph/workflows/summary?${params}`, { signal: controller.signal });
      if (revision.current === current) {
        if (offset > 0 && !result.items.length) setOffset(Math.max(0, Math.floor((result.total - 1) / 60) * 60));
        else setPage(result);
      }
    } catch (err) {
      if (revision.current === current) setError((err as Error).message);
    } finally {
      if (revision.current === current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
    else { setOffset(0); setLoading(false); }
    return () => { revision.current += 1; request.current?.abort(); };
  }, [refresh, open, offset, query]);

  const setQuery = useCallback((value: string) => { setQueryValue(value); setOffset(0); }, []);
  return { workflows: page.items, loading, error, refresh, query, setQuery, offset, setOffset, nextOffset: page.next_offset, total: page.total };
}

export type GraphWorkflowBrowser = ReturnType<typeof useGraphWorkflowBrowser>;
