"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AssistantNextAction, AssistantPlanResponse, AssistantSession, GraphWorkflowPayload } from "../types";
import { graphChangeCopy } from "../utils/graph-change-copy";
import { graphWorkflowSnapshotSignature } from "../utils/graph-tabs";
import { JsonFetchError, jsonFetch } from "../utils/graph-api";

type ApplyRecovery = {
  proposal: AssistantPlanResponse;
  baseWorkflow: GraphWorkflowPayload;
  sourceWorkflow: GraphWorkflowPayload;
  approved: AssistantPlanResponse | null;
};

type Options = {
  workflow: GraphWorkflowPayload;
  workspaceKey: string;
  initialAssistantSessionId?: string | null;
  busy: boolean;
  activeApplyOperationRef: MutableRefObject<symbol | null>;
  onApplyWorkflow: (workflow: GraphWorkflowPayload, options?: {
    highlightNodeIds?: string[]; baseWorkflow?: GraphWorkflowPayload; layoutOnly?: boolean;
    openInNewTab?: boolean; assistantSessionId?: string;
  }) => Promise<void> | void;
  onEvent?: (message: string, tone?: "success" | "warning" | "error" | "muted") => void;
  setPlan: (plan: AssistantPlanResponse) => void;
  setStatus: (status: "applying" | "idle") => void;
  setDeliveredPlanId: (id: string | null) => void;
  setFailedApplyPlanId: (id: string | null) => void;
  reportOperationFailure: (error: unknown, message: string) => void;
  clearError: () => void;
};

// Approval commits on the server; delivery commits on the canvas. Recovery never repeats approval.
export function useAssistantGraphApply(options: Options) {
  const [applyRecovery, setApplyRecovery] = useState<ApplyRecovery | null>(null);
  const current = useRef(options);
  current.current = options;
  const scope = `${options.workspaceKey}\u0000${options.initialAssistantSessionId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => { setApplyRecovery(null); }, [scope]);

  const perform = useCallback(async (recovery: ApplyRecovery, confirmation?: AssistantNextAction | null, recover = false) => {
    const owner = current.current;
    if (owner.busy || owner.activeApplyOperationRef.current) return null;
    const expectedScope = scopeRef.current;
    const operation = Symbol("apply-graph");
    owner.activeApplyOperationRef.current = operation;
    const ownsOperation = () => owner.activeApplyOperationRef.current === operation && scopeRef.current === expectedScope;
    owner.setStatus("applying");
    owner.clearError();
    let approved = recovery.approved;
    try {
      if (recover && !approved) {
        const saved = await jsonFetch<AssistantSession>(`/api/control/media/assistant/sessions/${recovery.proposal.plan.assistant_session_id}`);
        if (!ownsOperation()) return null;
        const exact = saved.latest_plan;
        if (exact?.plan.assistant_plan_id !== recovery.proposal.plan.assistant_plan_id || exact.plan.status !== "applied") {
          owner.reportOperationFailure(new Error("The saved conversation does not confirm this exact approval yet."), "Couldn’t confirm this graph approval yet. Check the saved approval again before applying anything.");
          return null;
        }
        approved = exact;
        setApplyRecovery({ ...recovery, approved });
        owner.setPlan(approved);
        return approved; // Checking approval is read-only; placement needs the next explicit click.
      }
      if (!approved) {
        const result = await jsonFetch<Omit<AssistantPlanResponse, "graph_plan">>(`/api/control/media/assistant/plans/${recovery.proposal.plan.assistant_plan_id}/apply`, {
          method: "POST",
          body: JSON.stringify({ workflow: recovery.baseWorkflow, ...(confirmation?.kind === "confirm_graph"
            ? { proposal_id: confirmation.proposal_id, confirmation_token: confirmation.confirmation_token } : {}) }),
        });
        const confirmed = { ...recovery.proposal, ...result };
        if (confirmed.plan?.assistant_plan_id !== recovery.proposal.plan.assistant_plan_id || confirmed.plan.status !== "applied" || !confirmed.workflow || !Array.isArray(confirmed.workflow.nodes)) {
          throw new Error("The response did not confirm this exact graph approval.");
        }
        approved = confirmed;
      }
      if (!ownsOperation()) return null;
      if (graphWorkflowSnapshotSignature(current.current.workflow) !== graphWorkflowSnapshotSignature(recovery.sourceWorkflow)) {
        // A changed source canvas must be reviewed; never overwrite edits while recovering delivery.
        owner.setFailedApplyPlanId(recovery.proposal.plan.assistant_plan_id);
        setApplyRecovery(null);
        owner.reportOperationFailure(new Error("The canvas changed before delivery."), "The canvas changed before these approved changes could be placed. Ask for a fresh review before applying again.");
        return null;
      }
      const previousIds = new Set(recovery.baseWorkflow.nodes.map(node => node.id));
      const updatedIds = new Set(recovery.proposal.graph_plan.operations.filter(op => op["op"] === "set_node_field" || op["op"] === "set_node_title")
        .map(op => String(op["node_id"] || op["node_ref"] || "")));
      const highlightNodeIds = approved.workflow.nodes.filter(node => !previousIds.has(node.id) || updatedIds.has(node.id)).map(node => node.id);
      await owner.onApplyWorkflow(approved.workflow, {
        highlightNodeIds, baseWorkflow: recovery.sourceWorkflow,
        layoutOnly: recovery.proposal.graph_plan.operations.length === 1 && recovery.proposal.graph_plan.operations[0]["op"] === "arrange_workflow",
        openInNewTab: recovery.proposal.graph_plan.metadata?.independent_stage === true,
        assistantSessionId: recovery.proposal.plan.assistant_session_id,
      });
      if (!ownsOperation()) return null;
      owner.setPlan(approved);
      owner.setDeliveredPlanId(approved.plan.assistant_plan_id);
      owner.setFailedApplyPlanId(null);
      setApplyRecovery(null);
      owner.onEvent?.(graphChangeCopy(approved, true).copy, "success");
      return approved;
    } catch (error) {
      if (!ownsOperation()) return null;
      owner.setFailedApplyPlanId(recovery.proposal.plan.assistant_plan_id);
      // A server rejection is authoritative only before approval, never for a delivery callback.
      const rejected = !approved && error instanceof JsonFetchError && error.status !== null && error.status >= 400 && error.status < 500;
      setApplyRecovery(rejected ? null : { ...recovery, approved });
      if (approved) owner.setPlan(approved);
      owner.reportOperationFailure(error, approved
        ? "Your graph changes were approved, but couldn’t be placed on the canvas. Retry placing the approved graph; this does not approve it again or start a run."
        : "Couldn’t confirm whether your graph changes were approved. Check the saved approval before applying again.");
      return null;
    } finally {
      if (ownsOperation()) { owner.activeApplyOperationRef.current = null; owner.setStatus("idle"); }
    }
  }, []);

  const applyPlanResponse = useCallback((proposal: AssistantPlanResponse, baseWorkflow: GraphWorkflowPayload, confirmation?: AssistantNextAction | null) => {
    if (applyRecovery) return Promise.resolve(null);
    return perform({ proposal, baseWorkflow, sourceWorkflow: current.current.workflow, approved: null }, confirmation);
  }, [applyRecovery, perform]);
  const recoverGraphApply = useCallback(() => applyRecovery ? perform(applyRecovery, null, true) : Promise.resolve(null), [applyRecovery, perform]);
  return { applyPlanResponse, applyRecovery, recoverGraphApply };
}
