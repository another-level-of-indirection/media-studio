import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getGeneralSettingsSnapshot, getMediaDashboardSnapshot } from "@/lib/control-api";

afterEach(() => vi.unstubAllGlobals());

describe("General Settings snapshot", () => {
  it("keeps the dashboard's model and queue values using only three reads", async () => {
    const paths: string[] = [];
    const records: Record<string, unknown> = {
      "/media/models": [{ key: "nano-banana-2", label: "Nano Banana 2", task_modes: ["text_to_image"], raw: { defaults: { resolution: "2K" } } }],
      "/media/queue/settings": { queue_enabled: false, max_concurrent_jobs: 15, default_poll_seconds: 6, max_retry_attempts: 3, max_concurrent_jobs_min: 1, max_concurrent_jobs_max: 20, default_poll_seconds_min: 1, default_poll_seconds_max: 60, max_retry_attempts_min: 1, max_retry_attempts_max: 10, updated_at: "2026-10-01" },
      "/media/queue/policies": [{ model_key: "nano-banana-2", enabled: false, max_outputs_per_run: 4, updated_at: "2026-10-01" }],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      paths.push(path);
      return Response.json(records[path] ?? (path.includes("assets") || path.includes("jobs") || path.includes("batches") || path.includes("projects") ? { items: [] } : []));
    }));
    const dashboard = await getMediaDashboardSnapshot();
    paths.length = 0;
    const focused = await getGeneralSettingsSnapshot();
    expect(paths.sort()).toEqual(["/media/models", "/media/queue/policies", "/media/queue/settings"]);
    expect(focused.models).toEqual(dashboard.models);
    expect(focused.queueSettings.data).toEqual(dashboard.queueSettings.data);
    expect(focused.queuePolicies).toEqual(dashboard.queuePolicies);
    expect(focused.queueSettings.data.settings).toMatchObject({ max_concurrent_jobs: 15, queue_enabled: false, max_concurrent_jobs_max: 20 });
    expect(focused.queuePolicies.data.policies[0]).toMatchObject({ enabled: false, max_outputs_per_run: 4 });
  });

  it("retains empty/null fallback values when the required reads fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const snapshot = await getGeneralSettingsSnapshot();
    expect(snapshot.models).toEqual({ ok: false, data: { models: [] } });
    expect(snapshot.queueSettings).toMatchObject({ ok: false, data: { settings: null } });
    expect(snapshot.queuePolicies).toEqual({ ok: false, data: { policies: [] } });
  });
});
