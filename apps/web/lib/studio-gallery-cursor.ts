// Server-side envelope binds the backend's continuation to its gallery query.
function queryScope(params: URLSearchParams, view: string | null) {
  const scope = new URLSearchParams(params);
  scope.delete("limit");
  scope.delete("cursor");
  scope.set("view", view ?? "full");
  scope.sort();
  return scope.toString();
}

export function encodeStudioGalleryCursor(
  backendCursor: string | null | undefined,
  offset: number,
  params: URLSearchParams,
  view: string | null,
): string | null {
  if (!backendCursor) {
    return null;
  }
  return Buffer.from(JSON.stringify({
    version: 1,
    scope: queryScope(params, view),
    cursor: backendCursor,
    offset,
  })).toString("base64url");
}

export function decodeStudioGalleryCursor(
  token: string,
  params: URLSearchParams,
  view: string | null,
): { cursor: string; offset: number } | null {
  try {
    const decoded = Buffer.from(token, "base64url");
    if (decoded.toString("base64url") !== token) {
      return null;
    }
    const payload = JSON.parse(decoded.toString("utf8"));
    if (
      payload.version !== 1 ||
      payload.scope !== queryScope(params, view) ||
      typeof payload.cursor !== "string" ||
      !payload.cursor ||
      !Number.isSafeInteger(payload.offset) ||
      payload.offset < 1
    ) {
      return null;
    }
    return { cursor: payload.cursor, offset: payload.offset };
  } catch {
    return null;
  }
}
