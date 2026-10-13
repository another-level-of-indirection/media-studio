import { useCallback, type MutableRefObject } from "react";

import type { GraphRun, GraphRunEvent, GraphRunHistoryItem, GraphWorkflowPayload, StudioNode } from "../types";
import { jsonFetch } from "../utils/graph-api";
import { assetIdsFromGraphRun } from "../utils/graph-media-preview";
import { formatGraphRunEventsForConsole } from "../utils/graph-run-events";
import { graphWorkflowSnapshotsMatch } from "../utils/graph-tabs";

export function useGraphWorkflowRunPreview({
  appendConsole, applyRunEventsToCanvas, applyRunNodesToCanvas, nodes,
  refreshAssetsByIds, refreshImageAssets, refreshReferenceMedia, setRun, setConsoleLines,
  workspaceRestoreVersionRef,
}: {
  appendConsole: (line: string) => void;
  applyRunEventsToCanvas: (events: GraphRunEvent[], run: GraphRun | null) => void;
  applyRunNodesToCanvas: (run: GraphRun) => void;
  nodes: StudioNode[];
  refreshAssetsByIds: (ids: string[]) => Promise<unknown>;
  refreshImageAssets: () => Promise<unknown>;
  refreshReferenceMedia: () => Promise<unknown>;
  setRun: (run: GraphRun) => void;
  setConsoleLines: (lines: string[]) => void;
  workspaceRestoreVersionRef: MutableRefObject<number>;
}) {
  const hydrateLastRun = useCallback(
    async (runId: string, preloadedRun?: GraphRun, sourceVersion = workspaceRestoreVersionRef.current) => {
      try {
        const current =
          preloadedRun ??
          (await jsonFetch<GraphRun>(`/api/control/media/graph/runs/${runId}`));
        if (sourceVersion !== workspaceRestoreVersionRef.current) return;
        setRun(current);
        applyRunNodesToCanvas(current);
        await refreshImageAssets().catch(() => undefined);
        if (sourceVersion !== workspaceRestoreVersionRef.current) return;
        await refreshAssetsByIds(assetIdsFromGraphRun(current)).catch(
          () => undefined,
        );
        if (sourceVersion !== workspaceRestoreVersionRef.current) return;
        await refreshReferenceMedia().catch(() => undefined);
        if (sourceVersion !== workspaceRestoreVersionRef.current) return;
        const events = await jsonFetch<{ items: GraphRunEvent[] }>(
          `/api/control/media/graph/runs/${runId}/events`,
        );
        if (sourceVersion !== workspaceRestoreVersionRef.current) return;
        if (events.items.length) {
          applyRunEventsToCanvas(events.items, current);
          setConsoleLines(formatGraphRunEventsForConsole(events.items, nodes));
        }
      } catch (error) {
        if (sourceVersion !== workspaceRestoreVersionRef.current) return;
        appendConsole(
          `Last run could not be restored: ${(error as Error).message}`,
        );
      }
    },
    [
      appendConsole,
      applyRunEventsToCanvas,
      applyRunNodesToCanvas,
      nodes,
      refreshAssetsByIds,
      refreshImageAssets,
      refreshReferenceMedia,
      setConsoleLines,
      setRun,
      workspaceRestoreVersionRef,
    ],
  );

  const hydrateLatestRunForWorkflow = useCallback(
    async (
      targetWorkflowId: string,
      currentWorkflow?: GraphWorkflowPayload | null,
      sourceVersion = workspaceRestoreVersionRef.current,
    ) => {
      const payload = await jsonFetch<{ items?: GraphRunHistoryItem[] }>(
        "/api/control/media/graph/runs/summary?limit=15",
      );
      if (sourceVersion !== workspaceRestoreVersionRef.current) return;
      const latestRunSummary = payload.items?.find(
        (item) => item.workflow_id === targetWorkflowId,
      );
      if (latestRunSummary?.run_id) {
        const latestRun = await jsonFetch<GraphRun>(
          `/api/control/media/graph/runs/${latestRunSummary.run_id}`,
        );
        if (sourceVersion !== workspaceRestoreVersionRef.current) return;
        if (
          currentWorkflow &&
          latestRun.workflow_json &&
          !graphWorkflowSnapshotsMatch(currentWorkflow, latestRun.workflow_json)
        ) {
          appendConsole(
            `Skipped last-run restore for ${currentWorkflow.name} because the latest run came from a different workflow state.`,
          );
          return;
        }
        await hydrateLastRun(latestRunSummary.run_id, latestRun, sourceVersion);
      }
    },
    [appendConsole, hydrateLastRun, workspaceRestoreVersionRef],
  );

  return { hydrateLastRun, hydrateLatestRunForWorkflow };
}
