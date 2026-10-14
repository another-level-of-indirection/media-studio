import { describe, expect, it } from "vitest";

import { toJobsBatchCardView } from "@/app/jobs/jobs-batch-card-view";
import type { MediaBatch, MediaJob } from "@/lib/types";

const job = (overrides: Partial<MediaJob> = {}): MediaJob => ({
  job_id: "job-1", status: "failed", created_at: "created", updated_at: "updated", ...overrides,
});
const batch = (overrides: Partial<MediaBatch> = {}): MediaBatch => ({
  batch_id: "batch-1", model_key: "model", status: "partial_failure", requested_outputs: 3,
  queued_count: 1, running_count: 1, completed_count: 0, failed_count: 1, cancelled_count: 0,
  created_at: "created", updated_at: "updated", ...overrides,
});

describe("Jobs card boundary", () => {
  it("retains visible identity, counts and error dates without provider payloads or mutation", () => {
    const input = batch({
      request_summary: { prompt_summary: "  a prompt  ", internal: "large request" },
      jobs: [job({ batch_index: 2, error: "failure", prepared: { payload: "large" } }), job({ job_id: "job-2", batch_index: 0 })],
    });
    const original = JSON.stringify(input);
    const view = toJobsBatchCardView(input);
    expect(view).toEqual({
      batch_id: "batch-1", model_key: "model", status: "partial_failure", requested_outputs: 3,
      queued_count: 1, running_count: 1, failed_count: 1, created_at: "created",
      prompt_summary: "a prompt", pricing_summary: null,
      jobs: [{ job_id: "job-1", batch_index: 2, error: "failure", updated_at: "updated" },
        { job_id: "job-2", batch_index: 0, error: undefined, updated_at: "updated" }],
    });
    expect(JSON.stringify(input)).toBe(original);
  });

  it("uses batch pricing before job pricing and retains finite zero estimates/counts", () => {
    const view = toJobsBatchCardView(batch({
      request_summary: { pricing_summary: { total: { estimated_cost_usd: 0, estimated_credits: 0 }, per_output: { estimated_cost_usd: 0.005, estimated_credits: 1.25 }, output_count: 0, details: "large" } },
      jobs: [job({ preflight: { pricing_summary: { output_count: 99 } } })],
    }));
    expect(view.pricing_summary).toEqual({ totalUsd: 0, totalCredits: 0, perOutputUsd: 0.005, perOutputCredits: 1.25, outputCount: 0 });
  });

  it("falls back to the first record-shaped job pricing in input order, before output sorting", () => {
    const view = toJobsBatchCardView(batch({
      request_summary: { pricing_summary: [] },
      jobs: [job({ preflight: { pricing_summary: "invalid" } }),
        job({ batch_index: 3, preflight: { pricing_summary: { total: { estimated_credits: 8 }, output_count: 2 } } }),
        job({ batch_index: 1, preflight: { pricing_summary: { output_count: 99 } } })],
    }));
    expect(view.pricing_summary).toEqual({ totalUsd: null, totalCredits: 8, perOutputUsd: null, perOutputCredits: null, outputCount: 2 });
  });

  it("keeps an empty batch pricing record authoritative and normalizes invalid numbers to n/a", () => {
    expect(toJobsBatchCardView(batch({ request_summary: { pricing_summary: {} }, jobs: [job({ preflight: { pricing_summary: { output_count: 99 } } })] })).pricing_summary?.outputCount).toBeNull();
    expect(toJobsBatchCardView(batch({ request_summary: { pricing_summary: { total: { estimated_cost_usd: "1", estimated_credits: Infinity }, per_output: [], output_count: NaN } } })).pricing_summary).toEqual({ totalUsd: null, totalCredits: null, perOutputUsd: null, perOutputCredits: null, outputCount: null });
  });

  it("preserves prompt fallback and the existing 180-character display limit", () => {
    for (const prompt_summary of [undefined, "  ", 4]) {
      expect(toJobsBatchCardView(batch({ request_summary: { prompt_summary } })).prompt_summary).toBe("No prompt recorded for this batch.");
    }
    const prompt = "x".repeat(300);
    expect(toJobsBatchCardView(batch({ request_summary: { prompt_summary: prompt } })).prompt_summary).toBe("x".repeat(179) + "…");
    expect(toJobsBatchCardView(batch()).jobs).toEqual([]);
  });
});
