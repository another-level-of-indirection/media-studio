import { jsonFetch } from "./graph-api";

type StartupUrl = "/api/control/health" | "/api/control/media/graph/workflows"
  | "/api/control/media/graph/templates" | "/api/control/media/credits";
type StartupRead = { promise: Promise<unknown>; expiresAt: number; timer?: ReturnType<typeof setTimeout> };
const reads = new Map<StartupUrl, StartupRead>();
const STARTUP_REUSE_MS = 4000;

// Share replayed effects and consumers enabled by restored tabs. Explicit refresh replaces boot data.
export function readGraphStartup<T>(url: StartupUrl, fresh = false): Promise<T> {
  const previous = reads.get(url);
  if (!fresh && previous && previous.expiresAt > Date.now()) return previous.promise as Promise<T>;
  if (previous?.timer) clearTimeout(previous.timer);
  const entry: StartupRead = { promise: jsonFetch<T>(url), expiresAt: Infinity };
  reads.set(url, entry);
  entry.promise = entry.promise.then((payload) => {
    if (reads.get(url) === entry) {
      entry.expiresAt = Date.now() + STARTUP_REUSE_MS;
      entry.timer = setTimeout(() => { if (reads.get(url) === entry) reads.delete(url); }, STARTUP_REUSE_MS);
    }
    return payload;
  }, (error) => {
    if (reads.get(url) === entry) reads.delete(url);
    throw error;
  });
  return entry.promise as Promise<T>;
}

export function __resetGraphStartupReadsForTests() {
  for (const entry of reads.values()) if (entry.timer) clearTimeout(entry.timer);
  reads.clear();
}
