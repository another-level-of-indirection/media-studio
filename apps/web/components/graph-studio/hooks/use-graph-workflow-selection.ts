import { useCallback, useEffect, useRef, useState } from "react";

import type { GraphWorkflowRecord } from "../types";
import { jsonFetch } from "../utils/graph-api";

export type GraphWorkflowSelectionHandler = (record: GraphWorkflowRecord, isCurrent?: () => boolean) => void | Promise<void>;

export function useGraphWorkflowSelection(open: boolean, workspaceKey: string, onLoad: GraphWorkflowSelectionHandler) {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ open, workspaceKey, onLoad });
  latest.current = { open, workspaceKey, onLoad };
  const revision = useRef(0);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    setLoadingId(null);
    setError(null);
    return () => { revision.current += 1; request.current?.abort(); };
  }, [open, workspaceKey]);

  const select = useCallback(async (workflowId: string) => {
    const current = ++revision.current;
    const sourceKey = latest.current.workspaceKey;
    const isCurrent = () => revision.current === current && latest.current.open && latest.current.workspaceKey === sourceKey;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoadingId(workflowId);
    setError(null);
    try {
      const record = await jsonFetch<GraphWorkflowRecord>(`/api/control/media/graph/workflows/${encodeURIComponent(workflowId)}`, { signal: controller.signal });
      if (record.workflow_id !== workflowId || !record.workflow_json) throw new Error("The selected workflow detail is unavailable.");
      if (isCurrent()) await latest.current.onLoad(record, isCurrent);
    } catch (err) {
      if (isCurrent()) setError((err as Error).message);
    } finally {
      if (revision.current === current) setLoadingId(null);
    }
  }, []);

  return { select, loadingId, error };
}
