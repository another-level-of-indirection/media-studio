import { useCallback, useRef } from "react";

import type { MediaReference } from "@/lib/types";
import type { GraphNodeDefinition, GraphWorkflowPayload, StudioEdge, StudioNode } from "../types";
import { jsonFetch } from "../utils/graph-api";
import { buildWorkflowBundle, downloadGraphBlob, parseWorkflowImportFile, sanitizeWorkflowForExport } from "../utils/graph-workflow-transfer";

export function useGraphWorkflowTransfer({
  workflowId,
  workflowName,
  nodes,
  edges,
  definitions,
  references,
  importImageFile,
  workflowFromCanvas,
  hydrateWorkflowPayload,
  setWorkflowMenuOpen,
  appendConsole,
}: {
  workflowId: string | null;
  workflowName: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
  definitions: GraphNodeDefinition[];
  references: MediaReference[];
  importImageFile: (file: File) => Promise<MediaReference>;
  workflowFromCanvas: (workflowId: string | null, workflowName: string, nodes: StudioNode[], edges: StudioEdge[]) => GraphWorkflowPayload;
  hydrateWorkflowPayload: (workflow: GraphWorkflowPayload, options?: { workflowId?: string | null; workflowName?: string }) => void;
  setWorkflowMenuOpen: (open: boolean) => void;
  appendConsole: (line: string) => void;
}) {
  const importWorkflowInputRef = useRef<HTMLInputElement | null>(null);

  const exportWorkflow = useCallback(() => {
    const payload = sanitizeWorkflowForExport(workflowFromCanvas(workflowId, workflowName, nodes, edges), definitions);
    const safeName = (workflowName || "workflow").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
    downloadGraphBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `${safeName}.media-studio-graph.json`);
    setWorkflowMenuOpen(false);
    appendConsole(payload.warnings.length ? `Exported workflow with ${payload.warnings.length} warning(s).` : "Exported workflow.");
  }, [appendConsole, definitions, edges, nodes, setWorkflowMenuOpen, workflowFromCanvas, workflowId, workflowName]);

  const exportWorkflowBundle = useCallback(async () => {
    try {
      const payload = sanitizeWorkflowForExport(workflowFromCanvas(workflowId, workflowName, nodes, edges), definitions);
      const safeName = (workflowName || "workflow").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
      const blob = await buildWorkflowBundle(payload, references);
      downloadGraphBlob(blob, `${safeName}.media-studio-graph.zip`);
      setWorkflowMenuOpen(false);
      appendConsole(payload.warnings.length ? `Exported workflow bundle with ${payload.warnings.length} warning(s).` : "Exported workflow bundle.");
    } catch (error) {
      appendConsole(`Workflow bundle export failed: ${(error as Error).message}`);
    }
  }, [appendConsole, definitions, edges, nodes, references, setWorkflowMenuOpen, workflowFromCanvas, workflowId, workflowName]);

  const importWorkflowFile = useCallback(
    async (file: File) => {
      try {
        const result = await parseWorkflowImportFile(file, importImageFile);
        hydrateWorkflowPayload(result.workflow, { workflowId: null, workflowName: result.workflow.name });
        setWorkflowMenuOpen(false);
        appendConsole(result.warnings.length ? `Imported workflow with ${result.warnings.length} warning(s).` : "Imported workflow.");
      } catch (error) {
        appendConsole(`Workflow import failed: ${(error as Error).message}`);
      }
    },
    [appendConsole, hydrateWorkflowPayload, importImageFile, setWorkflowMenuOpen],
  );

  return {
    importWorkflowInputRef,
    exportWorkflow,
    exportWorkflowBundle,
    importWorkflowFile,
  };
}
