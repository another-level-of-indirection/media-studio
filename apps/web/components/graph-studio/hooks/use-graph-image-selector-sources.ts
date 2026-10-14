import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchGeneratedMediaPickerPage,
  fetchReferenceMediaPickerPage,
  generatedMediaPickerItem,
  referenceMediaPickerItem,
} from "@/components/media/media-image-picker-sources";
import type { MediaImagePickerItem, MediaPickerMediaType } from "@/components/media/media-image-picker-types";
import type { MediaProject } from "@/lib/types";
import type {
  GraphImageSelectorProjectOption,
  GraphImageSelectorSource,
  GraphImageSelectorSourceState,
} from "../graph-image-selector-dialog";
import { jsonFetch } from "../utils/graph-api";

const GRAPH_IMAGE_SELECTOR_PAGE_LIMIT = 40;
const FIRST_PAGE_FRESH_MS = 30_000;
const MAX_VISIBLE_ITEMS = 80;

type FirstPage = {
  key: string;
  fetchedAt: number;
  items: MediaImagePickerItem[];
  nextOffset: number | null;
};

export type GraphMediaSelectorMediaType = MediaPickerMediaType;

type GraphImageSelectorSources = Record<
  GraphImageSelectorSource,
  GraphImageSelectorSourceState
>;

type LoadSourceOptions = {
  append?: boolean;
  force?: boolean;
  query?: string;
  projectId?: string | null;
};

function emptySourceState(): GraphImageSelectorSourceState {
  return {
    items: [],
    loading: false,
    loadingMore: false,
    nextOffset: null,
    selectionId: null,
    error: null,
  };
}

function emptySources(): GraphImageSelectorSources {
  return {
    generated: emptySourceState(),
    imported: emptySourceState(),
  };
}

function mergeItems(
  current: MediaImagePickerItem[],
  next: MediaImagePickerItem[],
) {
  const byId = new Map(current.map((item) => [item.id, item]));
  next.forEach((item) => byId.set(item.id, item));
  return Array.from(byId.values());
}

function projectOption(project: MediaProject): GraphImageSelectorProjectOption {
  return {
    projectId: project.project_id,
    label: project.name?.trim() || project.project_id,
    status: project.status,
    hiddenFromGlobalGallery: Boolean(project.hidden_from_global_gallery),
  };
}

export function useGraphImageSelectorSources(
  mediaType: GraphMediaSelectorMediaType = "image",
  mediaRevision = 0,
) {
  const [sources, setSources] =
    useState<GraphImageSelectorSources>(emptySources);
  const [searchQuery, setSearchQueryState] = useState("");
  const [projectId, setProjectIdState] = useState<string | null>(null);
  const [projectOptions, setProjectOptions] = useState<
    GraphImageSelectorProjectOption[]
  >([]);
  const [loadingProjectOptions, setLoadingProjectOptions] = useState(false);
  // Only the latest first page for each source survives close/reopen. No global cache.
  const firstPages = useRef<Partial<Record<GraphImageSelectorSource, FirstPage>>>({});
  const revisionRef = useRef(mediaRevision);
  const sourceKeys = useRef<Partial<Record<GraphImageSelectorSource, string>>>({});
  const pendingKeys = useRef<Partial<Record<GraphImageSelectorSource, string>>>({});
  const sourcesRef = useRef(sources);
  const searchQueryRef = useRef(searchQuery);
  const projectIdRef = useRef(projectId);
  const mediaTypeRef = useRef<GraphMediaSelectorMediaType>(mediaType);
  const projectOptionsLoadedRef = useRef(false);
  const requestCountersRef = useRef<Record<GraphImageSelectorSource, number>>({
    generated: 0,
    imported: 0,
  });

  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  useEffect(() => {
    if (mediaTypeRef.current === mediaType && revisionRef.current === mediaRevision) return;
    if (mediaTypeRef.current !== mediaType) setSources(emptySources());
    mediaTypeRef.current = mediaType;
    revisionRef.current = mediaRevision;
    firstPages.current = {};
    pendingKeys.current = {};
    requestCountersRef.current.generated += 1;
    requestCountersRef.current.imported += 1;
  }, [mediaType, mediaRevision]);

  const setSearchQuery = useCallback((query: string) => {
    searchQueryRef.current = query;
    setSearchQueryState(query);
  }, []);

  const setProjectId = useCallback((nextProjectId: string | null) => {
    projectIdRef.current = nextProjectId;
    setProjectIdState(nextProjectId);
    requestCountersRef.current.generated += 1;
    requestCountersRef.current.imported += 1;
    pendingKeys.current = {};
    setSources(emptySources());
  }, []);

  const loadProjects = useCallback(async (options?: { force?: boolean }) => {
    if (!options?.force && projectOptionsLoadedRef.current) return;
    setLoadingProjectOptions(true);
    try {
      const payload = await jsonFetch<{ projects?: MediaProject[] }>(
        "/api/control/media/projects?status=all",
      );
      setProjectOptions(
        (payload.projects ?? [])
          .filter((project) => project.project_id)
          .map(projectOption),
      );
      projectOptionsLoadedRef.current = true;
    } finally {
      setLoadingProjectOptions(false);
    }
  }, []);

  const loadSource = useCallback(
    async (source: GraphImageSelectorSource, options?: LoadSourceOptions) => {
      const append = options?.append ?? false;
      const currentSource = sourcesRef.current[source];
      if (append && currentSource.nextOffset == null) return;
      const offset = append ? currentSource.nextOffset ?? 0 : 0;
      const query = options?.query ?? searchQueryRef.current;
      const selectedProjectId =
        options && "projectId" in options
          ? options.projectId ?? null
          : projectIdRef.current;
      const key = JSON.stringify([mediaType, selectedProjectId, query.trim()]);
      if (append && sourceKeys.current[source] !== key) return;
      const cached = firstPages.current[source];
      if (!append && !options?.force && cached?.key === key && Date.now() - cached.fetchedAt < FIRST_PAGE_FRESH_MS) {
        requestCountersRef.current[source] += 1;
        delete pendingKeys.current[source];
        sourceKeys.current[source] = key;
        setSources((current) => ({ ...current, [source]: {
          ...emptySourceState(), items: cached.items, nextOffset: cached.nextOffset,
        } }));
        return;
      }
      if (options?.force) delete firstPages.current[source];
      const pendingKey = JSON.stringify([key, offset]);
      if (!options?.force && pendingKeys.current[source] === pendingKey) return;
      pendingKeys.current[source] = pendingKey;
      sourceKeys.current[source] = key;
      const requestId = requestCountersRef.current[source] + 1;
      requestCountersRef.current[source] = requestId;

      setSources((current) => ({
        ...current,
        [source]: {
          ...current[source],
          items: append ? current[source].items : [],
          loading: !append,
          loadingMore: append,
          error: null,
        },
      }));

      try {
        let items: MediaImagePickerItem[];
        let nextOffset: number | null;
        if (source === "generated") {
          const page = await fetchGeneratedMediaPickerPage(
            mediaType,
            offset,
            query,
            selectedProjectId,
            GRAPH_IMAGE_SELECTOR_PAGE_LIMIT,
          );
          items = page.items
            .map((item) => generatedMediaPickerItem(item, mediaType))
            .filter((item): item is MediaImagePickerItem => Boolean(item));
          nextOffset = page.nextOffset;
        } else {
          const page = await fetchReferenceMediaPickerPage(
            mediaType,
            offset,
            query,
            selectedProjectId,
            GRAPH_IMAGE_SELECTOR_PAGE_LIMIT,
          );
          items = page.items
            .map((item) => referenceMediaPickerItem(item, mediaType))
            .filter((item): item is MediaImagePickerItem => Boolean(item));
          nextOffset = page.nextOffset;
        }
        if (requestCountersRef.current[source] !== requestId) return;
        if (!append) firstPages.current[source] = { key, fetchedAt: Date.now(), items, nextOffset };
        setSources((current) => ({
          ...current,
          [source]: {
            ...current[source],
            items: append ? mergeItems(current[source].items, items).slice(-MAX_VISIBLE_ITEMS) : items,
            loading: false,
            loadingMore: false,
            nextOffset,
            error: null,
          },
        }));
      } catch (error) {
        if (requestCountersRef.current[source] !== requestId) return;
        setSources((current) => ({
          ...current,
          [source]: {
            ...current[source],
            loading: false,
            loadingMore: false,
            error:
              error instanceof Error
                ? error.message
                : `Unable to load ${mediaType} assets.`,
          },
        }));
      } finally {
        if (requestCountersRef.current[source] === requestId) delete pendingKeys.current[source];
      }
    },
    [mediaType, mediaRevision],
  );

  return {
    generated: sources.generated,
    imported: sources.imported,
    searchQuery,
    setSearchQuery,
    projectId,
    setProjectId,
    projectOptions,
    loadingProjectOptions,
    loadProjects,
    loadSource,
  };
}
