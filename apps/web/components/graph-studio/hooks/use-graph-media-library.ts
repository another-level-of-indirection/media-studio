import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MediaAsset, MediaReference } from "@/lib/types";
import type { StudioNode } from "../types";
import { outputRefs } from "../utils/graph-media-preview";
import { creditBalanceFromPayload, jsonFetch } from "../utils/graph-api";
import { readGraphStartup } from "../utils/graph-startup-reads";

function mergeAssets(
  current: MediaAsset[],
  next: MediaAsset[],
  preserveAssetIds: string[] = [],
) {
  const byId = new Map(current.map((asset) => [String(asset.asset_id), asset]));
  next.forEach((asset) => byId.set(String(asset.asset_id), asset));
  const sorted = Array.from(byId.values()).sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
  if (!preserveAssetIds.length) return sorted.slice(0, 80);
  const preserveSet = new Set(preserveAssetIds);
  const preserved = [...preserveSet]
    .map((assetId) => byId.get(assetId))
    .filter((asset): asset is MediaAsset => Boolean(asset));
  return [
    ...preserved,
    ...sorted.filter((asset) => !preserveSet.has(String(asset.asset_id))),
  ].slice(0, 80);
}

function mergeReferences(
  current: MediaReference[],
  next: MediaReference[],
  preserveReferenceIds: string[] = [],
) {
  const byId = new Map(current.map((reference) => [reference.reference_id, reference]));
  next.forEach((reference) => byId.set(reference.reference_id, reference));
  const sorted = Array.from(byId.values()).sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
  if (!preserveReferenceIds.length) return sorted.slice(0, 80);
  const preserveSet = new Set(preserveReferenceIds);
  const preserved = [...preserveSet]
    .map((referenceId) => byId.get(referenceId))
    .filter((reference): reference is MediaReference => Boolean(reference));
  return [
    ...preserved,
    ...sorted.filter((reference) => !preserveSet.has(reference.reference_id)),
  ].slice(0, 80);
}

export function useGraphMediaLibrary(nodes: StudioNode[] = []) {
  const [references, setReferences] = useState<MediaReference[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [availableCredits, setAvailableCredits] = useState<number | null>(null);
  const [creditsUnavailable, setCreditsUnavailable] = useState(false);
  const creditReadRevision = useRef(0);
  useEffect(() => () => { creditReadRevision.current += 1; }, []);
  const [mediaRevision, setMediaRevision] = useState(0);
  const invalidateMediaLibrary = useCallback(() => setMediaRevision((value) => value + 1), []);
  const assetRequests = useRef(new Map<string, Promise<MediaAsset | null>>());
  const referenceRequests = useRef(new Map<string, Promise<MediaReference | null>>());
  const assetsRef = useRef(assets);
  const referencesRef = useRef(references);
  assetsRef.current = assets;
  referencesRef.current = references;

  const refreshCredits = useCallback(async (options?: { startup?: boolean }) => {
    const revision = ++creditReadRevision.current;
    try {
      const payload = await readGraphStartup<Record<string, unknown>>("/api/control/media/credits", !options?.startup);
      if (revision !== creditReadRevision.current) return;
      setAvailableCredits(creditBalanceFromPayload(payload));
      setCreditsUnavailable(false);
    } catch {
      if (revision === creditReadRevision.current) setCreditsUnavailable(true);
    }
  }, []);

  // Restoration needs selected IDs and output refs, not recent gallery pages.
  const selectedIdsKey = useMemo(() => {
    const assetIds = new Set<string>();
    const referenceIds = new Set<string>();
    for (const node of nodes) {
      const refs = [node.data.fields, ...outputRefs(node.data.outputSnapshot)];
      for (const ref of refs) {
        if (typeof ref.asset_id === "string" && ref.asset_id) assetIds.add(ref.asset_id);
        if (typeof ref.reference_id === "string" && ref.reference_id) referenceIds.add(ref.reference_id);
      }
    }
    return JSON.stringify({ assets: [...assetIds].sort(), references: [...referenceIds].sort() });
  }, [nodes]);

  const selectedIds = useMemo(
    () => JSON.parse(selectedIdsKey) as { assets: string[]; references: string[] },
    [selectedIdsKey],
  );
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const refreshAssetsByIds = useCallback(async (assetIds: string[]) => {
    const uniqueIds = Array.from(new Set(assetIds.filter(Boolean)));
    if (!uniqueIds.length) return;
    const loaded = await Promise.all(
      uniqueIds.map((assetId) =>
        assetRequests.current.get(assetId) ?? (() => {
          const request = jsonFetch<{ asset?: MediaAsset }>(`/api/control/media-assets/${encodeURIComponent(assetId)}`)
            .then((payload) => payload.asset ?? null)
            .catch(() => null)
            .finally(() => assetRequests.current.delete(assetId));
          assetRequests.current.set(assetId, request);
          return request;
        })(),
      ),
    );
    const found = loaded.filter((asset): asset is MediaAsset => Boolean(asset?.asset_id));
    if (!found.length) return;
    setAssets((current) => mergeAssets(current, found, [...selectedIdsRef.current.assets, ...uniqueIds]));
  }, []);

  const refreshReferencesByIds = useCallback(async (referenceIds: string[]) => {
    const uniqueIds = Array.from(new Set(referenceIds.filter(Boolean)));
    if (!uniqueIds.length) return;
    const loaded = await Promise.all(
      uniqueIds.map((referenceId) =>
        referenceRequests.current.get(referenceId) ?? (() => {
          const request = jsonFetch<{ item?: MediaReference }>(`/api/control/reference-media/${encodeURIComponent(referenceId)}`)
            .then((payload) => payload.item ?? null)
            .catch(() => null)
            .finally(() => referenceRequests.current.delete(referenceId));
          referenceRequests.current.set(referenceId, request);
          return request;
        })(),
      ),
    );
    const found = loaded.filter((reference): reference is MediaReference => Boolean(reference?.reference_id));
    if (!found.length) return;
    setReferences((current) => mergeReferences(current, found, [...selectedIdsRef.current.references, ...uniqueIds]));
  }, []);

  useEffect(() => {
    void refreshAssetsByIds(selectedIds.assets.filter((id) => !assetsRef.current.some((asset) => asset.asset_id === id)));
    void refreshReferencesByIds(selectedIds.references.filter((id) => !referencesRef.current.some((reference) => reference.reference_id === id)));
  }, [selectedIds, refreshAssetsByIds, refreshReferencesByIds]);

  const importImageFile = useCallback(async (file: File) => {
    const data = new FormData();
    data.append("file", file);
    const response = await fetch("/api/control/reference-media/import", { method: "POST", body: data });
    if (!response.ok) {
      throw new Error("Image import failed.");
    }
    const payload = (await response.json()) as { item?: MediaReference };
    if (!payload.item?.reference_id) {
      throw new Error("Image import did not return a reference.");
    }
    setReferences((current) => mergeReferences(current, [payload.item as MediaReference], selectedIdsRef.current.references));
    invalidateMediaLibrary();
    return payload.item;
  }, [invalidateMediaLibrary]);

  return {
    references,
    setReferences,
    assets,
    setAssets,
    availableCredits,
    creditsUnavailable,
    refreshCredits,
    refreshAssetsByIds,
    refreshReferencesByIds,
    mediaRevision,
    invalidateMediaLibrary,
    importImageFile,
  };
}
