import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetGraphStartupReadsForTests, readGraphStartup } from "./graph-startup-reads";

afterEach(() => {
  __resetGraphStartupReadsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Graph startup read lifetime", () => {
  it("reuses settled boot data briefly, expires it without polling, and fetches current data next time", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ available_credits: 90 }))
      .mockResolvedValueOnce(Response.json({ available_credits: 40 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await readGraphStartup("/api/control/media/credits")).toEqual({ available_credits: 90 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await readGraphStartup("/api/control/media/credits")).toEqual({ available_credits: 90 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readGraphStartup("/api/control/media/credits")).toEqual({ available_credits: 40 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("allows a rejected shared read to be retried", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(Response.json({ install_id: "recovered" }));
    vi.stubGlobal("fetch", fetcher);
    const first = readGraphStartup("/api/control/health");
    const concurrent = readGraphStartup("/api/control/health");
    await expect(first).rejects.toThrow("offline");
    await expect(concurrent).rejects.toThrow("offline");
    expect(await readGraphStartup("/api/control/health")).toEqual({ install_id: "recovered" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"])("does not let an older %s replace a fresh health read", async (settlement) => {
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const old = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    const fetcher = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(Response.json({ install_id: "current" }));
    vi.stubGlobal("fetch", fetcher);
    const earlier = readGraphStartup("/api/control/health").catch(() => undefined);
    expect(await readGraphStartup("/api/control/health", true)).toEqual({ install_id: "current" });
    if (settlement === "resolve") resolve(Response.json({ install_id: "old" }));
    else reject(new TypeError("old failed"));
    await earlier;
    expect(await readGraphStartup("/api/control/health")).toEqual({ install_id: "current" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
