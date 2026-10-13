// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useGraphWorkflowBrowser } from "./use-graph-workflow-browser";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = (name: string, offset = 0, total = 65) => ({
  items: [{ workflow_id: name, name }], offset, limit: 60, total, next_offset: offset ? null : 60,
});

it("requests a summary page only when the browser opens", async () => {
  const fetcher = vi.fn(async () => Response.json(page("Saved")));
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(({ open }) => useGraphWorkflowBrowser(open), { initialProps: { open: false } });
  await act(async () => { await result.current.refresh(); });
  expect(fetcher).not.toHaveBeenCalled();
  rerender({ open: true });
  await waitFor(() => expect(result.current.workflows[0]?.name).toBe("Saved"));
  expect(fetcher.mock.calls[0][0]).toBe("/api/control/media/graph/workflows/summary?limit=60&offset=0");
});

it("replaces pages and searches the server from page one", async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url.includes("q=") ? page("Outside page one", 0, 1)
    : url.includes("offset=60") ? page("Last page", 60) : page("First page")));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useGraphWorkflowBrowser(true));
  await waitFor(() => expect(result.current.workflows[0]?.name).toBe("First page"));
  act(() => result.current.setOffset(result.current.nextOffset!));
  await waitFor(() => expect(result.current.workflows.map((item) => item.name)).toEqual(["Last page"]));
  act(() => result.current.setQuery("Outside page one"));
  await waitFor(() => expect(result.current.workflows[0]?.name).toBe("Outside page one"));
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe("/api/control/media/graph/workflows/summary?limit=60&offset=0&q=Outside+page+one");
});

it("cancels obsolete searches and ignores their delayed results after closing", async () => {
  let resolveOld!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce(Response.json(page("Current")));
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(({ open }) => useGraphWorkflowBrowser(open), { initialProps: { open: true } });
  act(() => result.current.setQuery("Current"));
  await waitFor(() => expect(result.current.workflows[0]?.name).toBe("Current"));
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  rerender({ open: false });
  await act(async () => { resolveOld(Response.json(page("Old"))); });
  expect(result.current.workflows[0]?.name).toBe("Current");
});

it("recovers a failed page with explicit retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(Response.json(page("Recovered"))));
  const { result } = renderHook(() => useGraphWorkflowBrowser(true));
  await waitFor(() => expect(result.current.error).toBe("offline"));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.error).toBeNull();
  expect(result.current.workflows[0]?.name).toBe("Recovered");
});

it("an earlier refresh callback observes the current closed browser", async () => {
  const fetcher = vi.fn(async () => Response.json(page("Saved")));
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(({ open }) => useGraphWorkflowBrowser(open), { initialProps: { open: true } });
  await waitFor(() => expect(result.current.workflows[0]?.name).toBe("Saved"));
  const refreshAfterMutation = result.current.refresh;
  rerender({ open: false });
  fetcher.mockClear();
  await act(async () => { await refreshAfterMutation(); });
  expect(fetcher).not.toHaveBeenCalled();
});

it("returns to the last valid page when an archive removes the final row", async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url.includes("offset=60")
    ? { ...page("", 60, 60), items: [] } : page("First page", 0, 60)));
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useGraphWorkflowBrowser(true));
  await waitFor(() => expect(result.current.workflows[0]?.name).toBe("First page"));
  act(() => result.current.setOffset(60));
  await waitFor(() => expect(result.current.offset).toBe(0));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.workflows[0]?.name).toBe("First page");
});

it("opens the first page again after browsing a later page and closing", async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url.includes("offset=60") ? page("Later", 60) : page("First")));
  vi.stubGlobal("fetch", fetcher);
  const { result, rerender } = renderHook(({ open }) => useGraphWorkflowBrowser(open), { initialProps: { open: true } });
  await waitFor(() => expect(result.current.workflows[0]?.name).toBe("First"));
  act(() => result.current.setOffset(60));
  await waitFor(() => expect(result.current.workflows[0]?.name).toBe("Later"));
  rerender({ open: false });
  rerender({ open: true });
  await waitFor(() => expect(result.current.workflows[0]?.name).toBe("First"));
});
