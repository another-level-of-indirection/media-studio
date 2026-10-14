import { NextResponse } from "next/server";

import {
  getControlApiJson,
  mapAssetPickerRecord,
  mapAssetRecord,
  mapAssetSummaryRecord,
} from "@/lib/control-api";
import type {
  MediaAssetPickerResponse,
  MediaAssetSummaryResponse,
  MediaAssetsResponse,
} from "@/lib/types";
import { decodeStudioGalleryCursor, encodeStudioGalleryCursor } from "@/lib/studio-gallery-cursor";
import { boundedIntegerParam } from "../pagination";

const CONTROL_ASSET_PAGE_LIMIT = 100;
const CONTROL_ASSET_MAX_LIMIT = 200;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = boundedIntegerParam(
    url.searchParams.get("limit"),
    12,
    1,
    CONTROL_ASSET_MAX_LIMIT,
  );
  const offset = boundedIntegerParam(
    url.searchParams.get("offset"),
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const generationKind = url.searchParams.get("generation_kind");
  const modelKey = url.searchParams.get("model_key");
  const status = url.searchParams.get("status");
  const presetKey = url.searchParams.get("preset_key");
  const projectId = url.searchParams.get("project_id");
  const favorited = url.searchParams.get("favorited");
  const view = url.searchParams.get("view");
  const q = url.searchParams.get("q");
  const mapAssetForView =
    view === "picker"
      ? mapAssetPickerRecord
      : view === "summary"
        ? mapAssetSummaryRecord
        : mapAssetRecord;
  const mediaType =
    generationKind === "image" ||
    generationKind === "video" ||
    generationKind === "audio"
      ? generationKind
      : null;
  const baseParams = new URLSearchParams();
  if (mediaType) {
    baseParams.set("media_type", mediaType);
  }
  if (modelKey) {
    baseParams.set("model_key", modelKey);
  }
  if (status) {
    baseParams.set("status", status);
  }
  if (presetKey) {
    baseParams.set("preset_key", presetKey);
  }
  if (projectId) {
    baseParams.set("project_id", projectId);
  }
  if (favorited === "true") {
    baseParams.set("favorites", "true");
  }
  if (q?.trim()) {
    baseParams.set("q", q.trim());
  }
  if (view === "picker" || view === "summary") {
    baseParams.set("compact", "true");
  }

  const cursorToken = url.searchParams.get("cursor");
  if (url.searchParams.get("pagination") === "cursor" || cursorToken !== null) {
    baseParams.set("cursor_mode", "asset_id");
    const continuation = cursorToken === null
      ? null
      : decodeStudioGalleryCursor(cursorToken, baseParams, view);
    if (
      (cursorToken !== null && !continuation) ||
      (cursorToken === null && offset !== 0) ||
      (continuation && url.searchParams.has("offset") && offset !== continuation.offset)
    ) {
      return NextResponse.json({
        ok: false,
        error: "Invalid gallery continuation. Reload the gallery to restart.",
      }, { status: 400 });
    }
    const pageOffset = continuation?.offset ?? 0;
    const endpointParams = new URLSearchParams(baseParams);
    endpointParams.set("limit", String(limit));
    if (continuation) {
      endpointParams.set("cursor", continuation.cursor);
    }
    const result = await getControlApiJson<{
      items?: Record<string, unknown>[];
      next_cursor?: string | null;
    }>(`/media/assets?${endpointParams.toString()}`, "read");
    if (!result.ok || !result.data?.items) {
      return NextResponse.json({
        ok: false,
        error: result.error ?? "Unable to load media assets from the Control API.",
      }, { status: 502 });
    }
    const assets = result.data.items.map(mapAssetForView);
    const nextOffset = pageOffset + assets.length;
    const nextCursor = encodeStudioGalleryCursor(result.data.next_cursor, nextOffset, baseParams, view);
    return NextResponse.json({
      ok: true,
      assets,
      limit,
      offset: pageOffset,
      has_more: Boolean(nextCursor),
      next_offset: nextCursor ? nextOffset : null,
      next_cursor: nextCursor,
    });
  }

  let remainingOffset = offset;
  const page: Array<
    ReturnType<typeof mapAssetRecord> | ReturnType<typeof mapAssetPickerRecord>
  > = [];
  let nextCursor: string | null = null;
  let firstRequest = true;
  let hasMore = false;

  while (page.length < limit) {
    const endpointParams = new URLSearchParams(baseParams);
    endpointParams.set(
      "limit",
      String(
        Math.min(
          CONTROL_ASSET_MAX_LIMIT,
          Math.max(
            CONTROL_ASSET_PAGE_LIMIT,
            limit -
              page.length +
              Math.min(remainingOffset, CONTROL_ASSET_PAGE_LIMIT),
          ),
        ),
      ),
    );
    if (!firstRequest && nextCursor) {
      endpointParams.set("cursor", nextCursor);
    }

    const result = await getControlApiJson<{
      items?: Record<string, unknown>[];
      next_cursor?: string | null;
    }>(`/media/assets?${endpointParams.toString()}`, "read");

    if (!result.ok || !result.data?.items) {
      return NextResponse.json(
        {
          ok: false,
          error:
            result.error ?? "Unable to load media assets from the Control API.",
        },
        { status: 502 },
      );
    }

    const assets = result.data.items.map(mapAssetForView);
    const startIndex = Math.min(remainingOffset, assets.length);
    if (startIndex < assets.length) {
      const taken = assets.slice(
        startIndex,
        startIndex + (limit - page.length),
      );
      page.push(...taken);
      if (startIndex + taken.length < assets.length) {
        hasMore = true;
      }
    }
    remainingOffset = Math.max(0, remainingOffset - assets.length);
    nextCursor = result.data.next_cursor ?? null;
    firstRequest = false;

    if (!nextCursor || assets.length === 0) {
      break;
    }
  }

  return NextResponse.json({
    ok: true,
    assets: page,
    limit,
    offset,
    has_more: hasMore || Boolean(nextCursor),
    next_offset: hasMore || nextCursor ? offset + page.length : null,
  } as
    | MediaAssetsResponse
    | MediaAssetPickerResponse
    | MediaAssetSummaryResponse);
}
