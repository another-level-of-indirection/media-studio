// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGraphAssistantAvailability } from "./use-graph-assistant-availability";
import { useGraphTabs } from "./use-graph-tabs";
import { __resetGraphStartupReadsForTests } from "../utils/graph-startup-reads";
import { useGraphWorkflowActions } from "./use-graph-workflow-actions";
import { useGraphTemplates } from "./use-graph-templates";
import { useGraphMediaLibrary } from "./use-graph-media-library";
import { useCreativeAssistant } from "./use-creative-assistant";
import { __resetGraphProviderReadinessCacheForTests, useGraphProviderModelCatalog } from "./use-graph-provider-model-catalog";
import { assistantTestWorkflow } from "../creative-assistant-test-fixtures";

const workflowProps: Parameters<typeof useGraphWorkflowActions>[0] = {
  workflowId: null, workflowName: "Test", renameDraft: "Test", nodes: [], edges: [],
  workflowFromCanvas: () => ({ schema_version: 1, workflow_id: null, name: "Test", nodes: [], edges: [] }),
  setWorkflowId: vi.fn(), setWorkflowName: vi.fn(), setWorkflowUpdatedAt: vi.fn(),
  setRun: vi.fn(), setNodes: vi.fn(), setEdges: vi.fn(), setConsoleLines: vi.fn(),
  setWorkflowMenuOpen: vi.fn(), setRenameDialogOpen: vi.fn(), appendConsole: vi.fn(),
};

function useListReads() {
  const workflows = useGraphWorkflowActions(workflowProps);
  const templates = useGraphTemplates({ appendConsole: workflowProps.appendConsole });
  const credits = useGraphMediaLibrary();
  return { workflows, templates, credits };
}

function useBootLists() {
  const { workflows, templates, credits } = useListReads();
  useEffect(() => {
    void workflows.refreshWorkflows({ startup: true });
    void templates.refreshTemplates({ startup: true });
    void credits.refreshCredits({ startup: true });
  }, [workflows.refreshWorkflows, templates.refreshTemplates, credits.refreshCredits]);
  return { workflows, templates, credits };
}

function Replay({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, String(value)); },
  removeItem: (key: string) => { stored.delete(key); },
  clear: () => stored.clear(),
};
beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
});

afterEach(() => {
  cleanup();
  __resetGraphStartupReadsForTests();
  __resetGraphProviderReadinessCacheForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  storage.clear();
});

describe("Graph startup reads", () => {
  it("refreshes workflow and template lists after saves despite settled startup reuse", async () => {
    const savedUrls = new Set<string>();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        savedUrls.add(url);
        return Response.json(url.endsWith("/templates")
          ? { template_id: "new-template", name: "Saved Template" } : { workflow_id: "new-workflow" });
      }
      return Response.json({ items: [{ name: savedUrls.has(url) ? "Saved" : "Before save" }] });
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(useListReads);
    await act(async () => {
      await result.current.workflows.refreshWorkflows({ startup: true });
      await result.current.templates.refreshTemplates({ startup: true });
    });
    await act(async () => {
      await result.current.workflows.saveWorkflow();
      await result.current.templates.saveWorkflowAsTemplate(workflowProps.workflowFromCanvas(null, "Test", [], []));
    });
    await waitFor(() => expect(result.current.workflows.workflows[0]?.name).toBe("Saved"));
    expect(result.current.templates.templates[0]?.name).toBe("Saved");
    expect(fetcher.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(4);
  });

  it("restores tabs and availability after a pending effect is cleaned up and replayed", async () => {
    vi.stubEnv("NEXT_PUBLIC_MEDIA_STUDIO_ASSISTANT_DEBUG", "1");
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((yes) => { resolve = yes; }));
    vi.stubGlobal("fetch", fetcher);
    const useHealth = () => ({ tabs: useGraphTabs(), assistant: useGraphAssistantAvailability() });
    const first = renderHook(useHealth, { wrapper: Replay });
    first.unmount();
    const replay = renderHook(useHealth, { wrapper: Replay });
    await act(async () => { resolve(Response.json({ install_id: "replay-install", media_assistant_enabled: true, codex_local_ready: true })); });
    await waitFor(() => expect(replay.result.current.assistant.status).toBe("ready"));
    expect(replay.result.current.tabs.storageScope).toBe("replay-install");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("recovers credit availability on retry after a failed startup read", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(Response.json({ remaining_credits: 32 }));
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(useGraphMediaLibrary);
    await act(async () => { await result.current.refreshCredits({ startup: true }); });
    expect(result.current.creditsUnavailable).toBe(true);
    await act(async () => { await result.current.refreshCredits(); });
    expect(result.current.availableCredits).toBe(32);
    expect(result.current.creditsUnavailable).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reuses settled health for restored prompt nodes and the assistant, while explicit readiness refresh stays fresh", async () => {
    vi.stubEnv("NEXT_PUBLIC_MEDIA_STUDIO_ASSISTANT_DEBUG", "1");
    const fetcher = vi.fn(async () => Response.json({
      media_assistant_enabled: true, codex_local_ready: true,
      codex_local_command_available: true, codex_local_login_configured: true,
    }));
    vi.stubGlobal("fetch", fetcher);
    const availability = renderHook(useGraphAssistantAvailability);
    await waitFor(() => expect(availability.result.current.status).toBe("ready"));
    const assistant = renderHook(() => useCreativeAssistant({
      workspaceKey: "boot", workflowId: null, workflowName: "Test", workflow: assistantTestWorkflow,
      enabled: true, importImageFile: vi.fn(), onApplyWorkflow: vi.fn(),
    }));
    const catalog = renderHook(() => useGraphProviderModelCatalog({
      nodes: [{ id: "llm", data: { definition: { type: "prompt.llm" }, fields: { provider: "studio_default" } } } as never],
      appendConsole: vi.fn(),
    }));
    await waitFor(() => expect(assistant.result.current.providerReadiness.ready).toBe(true));
    await waitFor(() => expect(catalog.result.current.readiness.codex_local?.ready).toBe(true));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await assistant.result.current.refreshProviderReadiness(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["workflows", "templates", "credits"] as const)("keeps a newer %s refresh when the startup response finishes late", async (kind) => {
    let resolveBoot!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveBoot = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(Response.json(
      kind === "credits" ? { available_credits: 25 } : { items: [{ name: "Current" }] },
    )));
    const { result } = renderHook(useListReads);
    const refresh = () => kind === "credits" ? result.current.credits.refreshCredits
      : kind === "templates" ? result.current.templates.refreshTemplates : result.current.workflows.refreshWorkflows;
    let boot!: Promise<void>;
    act(() => { boot = refresh()({ startup: true }); });
    await act(async () => { await refresh()(); });
    await act(async () => {
      resolveBoot(Response.json(kind === "credits" ? { available_credits: 100 } : { items: [{ name: "Old" }] }));
      await boot;
    });
    if (kind === "credits") expect(result.current.credits.availableCredits).toBe(25);
    else if (kind === "templates") expect(result.current.templates.templates[0]?.name).toBe("Current");
    else expect(result.current.workflows.workflows[0]?.name).toBe("Current");
  });

  it("shares boot lists and credits across concurrent consumers, then refreshes credits after a run", async () => {
    let balance = 80;
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/credits")
      ? { available_credits: balance } : { items: [{ name: url.endsWith("/templates") ? "Portrait template" : "Saved portrait" }] }));
    vi.stubGlobal("fetch", fetcher);
    const first = renderHook(useBootLists, { wrapper: Replay });
    const second = renderHook(useBootLists, { wrapper: Replay });
    await waitFor(() => expect(first.result.current.credits.availableCredits).toBe(80));
    await waitFor(() => expect(second.result.current.workflows.workflows[0]?.name).toBe("Saved portrait"));
    expect(first.result.current.templates.templates[0]?.name).toBe("Portrait template");
    expect(fetcher).toHaveBeenCalledTimes(3);
    balance = 65;
    await act(async () => { await first.result.current.credits.refreshCredits(); });
    expect(first.result.current.credits.availableCredits).toBe(65);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("restores the installation scope and assistant readiness with one health read through effect replay", async () => {
    vi.stubEnv("NEXT_PUBLIC_MEDIA_STUDIO_ASSISTANT_DEBUG", "1");
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      install_id: "graph-read-test", media_assistant_enabled: true,
      codex_local_ready: true, codex_local_command_available: true, codex_local_login_configured: true,
    })));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => ({ tabs: useGraphTabs(), assistant: useGraphAssistantAvailability() }), { wrapper: Replay });
    await waitFor(() => expect(result.current.assistant.status).toBe("ready"));
    expect(result.current.tabs.storageScope).toBe("graph-read-test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
