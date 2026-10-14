import type { MediaBatch, MediaJob } from "@/lib/types";
import { isRecord, toFiniteNumber, truncate } from "@/lib/utils";

export type JobsCardJob = Pick<MediaJob, "job_id" | "batch_index" | "error" | "updated_at">;

export type JobsBatchCardView = Pick<
  MediaBatch,
  "batch_id" | "model_key" | "status" | "created_at" | "requested_outputs" | "queued_count" | "running_count" | "failed_count"
> & {
  prompt_summary: string;
  pricing_summary: {
    totalUsd: number | null;
    totalCredits: number | null;
    perOutputUsd: number | null;
    perOutputCredits: number | null;
    outputCount: number | null;
  } | null;
  jobs: JobsCardJob[];
};

function batchPricingSummary(batch: MediaBatch) {
  const requestSummary = isRecord(batch.request_summary) ? batch.request_summary : null;
  const requestPricing = isRecord(requestSummary?.pricing_summary) ? requestSummary.pricing_summary : null;
  if (requestPricing) {
    return requestPricing;
  }

  for (const job of batch.jobs ?? []) {
    const preflight = isRecord(job.preflight) ? job.preflight : null;
    const pricing = isRecord(preflight?.pricing_summary) ? preflight.pricing_summary : null;
    if (pricing) {
      return pricing;
    }
  }

  return null;
}

// Only the Jobs card's display data crosses this server-to-client boundary.
export function toJobsBatchCardView(batch: MediaBatch): JobsBatchCardView {
  const prompt = batch.request_summary?.prompt_summary;
  const pricing = batchPricingSummary(batch);
  const total = isRecord(pricing?.total) ? pricing.total : null;
  const perOutput = isRecord(pricing?.per_output) ? pricing.per_output : null;

  return {
    batch_id: batch.batch_id,
    model_key: batch.model_key,
    status: batch.status,
    created_at: batch.created_at,
    requested_outputs: batch.requested_outputs,
    queued_count: batch.queued_count,
    running_count: batch.running_count,
    failed_count: batch.failed_count,
    prompt_summary: truncate(typeof prompt === "string" && prompt.trim() ? prompt.trim() : "No prompt recorded for this batch.", 180),
    pricing_summary: pricing ? {
      totalUsd: toFiniteNumber(total?.estimated_cost_usd),
      totalCredits: toFiniteNumber(total?.estimated_credits),
      perOutputUsd: toFiniteNumber(perOutput?.estimated_cost_usd),
      perOutputCredits: toFiniteNumber(perOutput?.estimated_credits),
      outputCount: toFiniteNumber(pricing.output_count),
    } : null,
    jobs: (batch.jobs ?? []).map((job) => ({
      job_id: job.job_id,
      batch_index: job.batch_index,
      error: job.error,
      updated_at: job.updated_at,
    })),
  };
}
