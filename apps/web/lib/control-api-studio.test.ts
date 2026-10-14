import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getMediaDashboardSnapshot, getStudioSnapshot } from "@/lib/control-api";
import { decodeStudioGalleryCursor } from "@/lib/studio-gallery-cursor";

afterEach(() => vi.unstubAllGlobals());

function api() {
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname + parsed.search);
    const data = parsed.pathname.includes("presets") ? [{
      preset_id: "older", key: "older", label: "Older preset", status: "active",
      input_schema_count: 2, input_slots_count: 1,
      ...(parsed.pathname.endsWith("summary") ? {} : { prompt_template: "Heavy prompt", input_schema_json: [{ key: "name" }] }),
    }] : ["/media/models", "/prompt-recipes", "/media/system-prompts", "/media/enhancement-configs", "/media/queue/policies"].includes(parsed.pathname) ? []
      : parsed.pathname === "/media/credits" ? { available_credits: 17 }
      : parsed.pathname === "/media/assets" ? { items: [{ asset_id: "asset-1", project_id: "project A" }], next_cursor: "next" }
      : { items: [] };
    return Response.json(data);
  }));
  return paths;
}

describe("Studio initial snapshot", () => {
  it("returns required project-scoped data with summaries and no unrelated reads", async () => {
    const paths = api();
    const snapshot = await getStudioSnapshot({ projectId: "project A" });
    expect(paths.sort()).toEqual([
      "/health", "/media/credits", "/media/pricing", "/media/models", "/media/presets/summary",
      "/media/system-prompts", "/media/enhancement-configs", "/media/queue/settings", "/media/queue/policies",
      "/media/projects?status=all", "/media/batches?limit=8&offset=0&project_id=project%20A",
      "/media/jobs?limit=8&project_id=project%20A", "/media/assets?limit=18&compact=true&cursor_mode=asset_id&project_id=project%20A",
      "/media/assets/latest?project_id=project%20A",
    ].sort());
    expect(snapshot.credits.data.balance.available_credits).toBe(17);
    expect(snapshot.presets.data.presets[0]).toMatchObject({ preset_id: "older", input_schema_count: 2, input_slots_count: 1 });
    expect(snapshot.presets.data.presets[0]).not.toHaveProperty("prompt_template");
    expect(snapshot.presets.data.presets[0]).not.toHaveProperty("input_schema_json");
    expect(snapshot.assets.data).toMatchObject({ limit: 18, offset: 0, has_more: true, next_offset: 1 });
    expect(snapshot.assets.data.assets[0].project_id).toBe("project A");
    expect(decodeStudioGalleryCursor(
      snapshot.assets.data.next_cursor!,
      new URLSearchParams({ compact: "true", cursor_mode: "asset_id", project_id: "project A" }),
      "summary",
    )).toEqual({ cursor: "next", offset: 1 });
  });

  it("preserves the shared dashboard loader and full preset contract", async () => {
    const paths = api();
    const snapshot = await getMediaDashboardSnapshot();
    expect(paths).toHaveLength(19);
    expect(paths).toContain("/media/presets");
    expect(paths).toContain("/prompt-recipes?status=all");
    expect(paths).toContain("/media/external-llm-usage/summary");
    expect(snapshot.presets.data.presets[0].prompt_template).toBe("Heavy prompt");
  });
});
