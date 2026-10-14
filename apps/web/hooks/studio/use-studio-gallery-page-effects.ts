import { useEffect, useMemo, useRef } from "react";

import {
  ASSET_APPEND_BATCH_SIZE,
  type AssetPagePayload,
  type GalleryKindFilter,
  INITIAL_ASSET_PAGE_SIZE,
} from "@/lib/media-studio-contract";
import { prefetchAssetThumbs } from "@/lib/media-studio-helpers";
import type { MediaAsset } from "@/lib/types";

type StudioGalleryPageEffectsOptions = {
  activeProjectId: string | null;
  assetPageLimit: number;
  assetFeedHasMore: boolean;
  assetFeedNextOffset: number | null;
  loadingMoreAssets: boolean;
  prefetchedAssetPage: AssetPagePayload | null;
  favoriteAssetFeedHasMore: boolean;
  favoriteAssetFeedNextOffset: number | null;
  loadingMoreFavoriteAssets: boolean;
  prefetchedFavoriteAssetPage: AssetPagePayload | null;
  favoritesOnly: boolean;
  galleryKindFilter: GalleryKindFilter;
  galleryModelFilter: string;
  galleryScrollArmed: boolean;
  skipInitialAssetPageFetch: boolean;
  prefetchedThumbUrls: Set<string>;
  fetchAssetPage: (options: {
    offset: number;
    favorited?: boolean;
    limitOverride?: number;
    silent?: boolean;
  }) => Promise<AssetPagePayload | null>;
  applyLoadedAssetPage: (page: AssetPagePayload) => void;
  applyLoadedFavoriteAssetPage: (page: AssetPagePayload) => void;
  setLocalAssets: (assets: MediaAsset[]) => void;
  setAssetFeedHasMore: (value: boolean) => void;
  setAssetFeedNextOffset: (value: number | null) => void;
  setPrefetchedAssetPage: (value: AssetPagePayload | null) => void;
  setFavoriteAssets: (assets: MediaAsset[] | null) => void;
  setFavoritesLoading: (value: boolean) => void;
  setFavoriteAssetFeedHasMore: (value: boolean) => void;
  setFavoriteAssetFeedNextOffset: (value: number | null) => void;
  setPrefetchedFavoriteAssetPage: (value: AssetPagePayload | null) => void;
  setPrefetchingAssetPage: (value: boolean) => void;
  setPrefetchingFavoriteAssetPage: (value: boolean) => void;
  setFirstGalleryPageFailed: (value: boolean) => void;
};

export function useStudioGalleryPageEffects({
  activeProjectId,
  assetPageLimit,
  assetFeedHasMore,
  assetFeedNextOffset,
  loadingMoreAssets,
  prefetchedAssetPage,
  favoriteAssetFeedHasMore,
  favoriteAssetFeedNextOffset,
  loadingMoreFavoriteAssets,
  prefetchedFavoriteAssetPage,
  favoritesOnly,
  galleryKindFilter,
  galleryModelFilter,
  galleryScrollArmed,
  skipInitialAssetPageFetch,
  prefetchedThumbUrls,
  fetchAssetPage,
  applyLoadedAssetPage,
  applyLoadedFavoriteAssetPage,
  setLocalAssets,
  setAssetFeedHasMore,
  setAssetFeedNextOffset,
  setPrefetchedAssetPage,
  setFavoriteAssets,
  setFavoritesLoading,
  setFavoriteAssetFeedHasMore,
  setFavoriteAssetFeedNextOffset,
  setPrefetchedFavoriteAssetPage,
  setPrefetchingAssetPage,
  setPrefetchingFavoriteAssetPage,
  setFirstGalleryPageFailed,
}: StudioGalleryPageEffectsOptions) {
  const assetQueryScopeKey = useMemo(
    () => JSON.stringify({ projectId: activeProjectId ?? null, kind: galleryKindFilter, model: galleryModelFilter }),
    [activeProjectId, galleryKindFilter, galleryModelFilter],
  );
  const serverSeedQueryScopeRef = useRef(skipInitialAssetPageFetch ? assetQueryScopeKey : null);

  useEffect(() => {
    if (favoritesOnly || assetQueryScopeKey !== serverSeedQueryScopeRef.current) {
      serverSeedQueryScopeRef.current = null;
    }
    if (favoritesOnly) {
      return;
    }
    if (skipInitialAssetPageFetch && serverSeedQueryScopeRef.current === assetQueryScopeKey) {
      return;
    }
    let cancelled = false;
    setFirstGalleryPageFailed(false);
    setPrefetchedAssetPage(null);
    setAssetFeedHasMore(false);
    setAssetFeedNextOffset(null);
    void fetchAssetPage({ offset: 0, limitOverride: INITIAL_ASSET_PAGE_SIZE, silent: true })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        if (!payload) {
          setFirstGalleryPageFailed(true);
          return;
        }
        setLocalAssets(payload.assets ?? []);
        setAssetFeedHasMore(Boolean(payload.has_more));
        setAssetFeedNextOffset(payload.next_offset ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [assetQueryScopeKey, favoritesOnly]);

  useEffect(() => {
    if (!favoritesOnly) {
      setFavoriteAssets(null);
      setFavoriteAssetFeedHasMore(false);
      setFavoriteAssetFeedNextOffset(null);
      setPrefetchedFavoriteAssetPage(null);
      return;
    }
    let cancelled = false;
    setFirstGalleryPageFailed(false);
    setFavoritesLoading(true);
    setFavoriteAssetFeedHasMore(false);
    setFavoriteAssetFeedNextOffset(null);
    setPrefetchedFavoriteAssetPage(null);
    void fetchAssetPage({ offset: 0, favorited: true, limitOverride: INITIAL_ASSET_PAGE_SIZE })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        if (!payload) {
          setFirstGalleryPageFailed(true);
          return;
        }
        setFavoriteAssets(payload.assets ?? []);
        setFavoriteAssetFeedHasMore(Boolean(payload.has_more));
        setFavoriteAssetFeedNextOffset(payload.next_offset ?? null);
        setPrefetchedFavoriteAssetPage(null);
      })
      .finally(() => {
        if (!cancelled) {
          setFavoritesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, favoritesOnly, galleryKindFilter, galleryModelFilter]);

  useEffect(() => {
    if (
      favoritesOnly ||
      !galleryScrollArmed ||
      !assetFeedHasMore ||
      assetFeedNextOffset == null ||
      loadingMoreAssets ||
      prefetchedAssetPage
    ) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPrefetchingAssetPage(true);
      void fetchAssetPage({ offset: assetFeedNextOffset, limitOverride: ASSET_APPEND_BATCH_SIZE, silent: true })
        .then((page) => {
          if (cancelled || !page) {
            return;
          }
          prefetchAssetThumbs(page.assets ?? [], prefetchedThumbUrls);
          const scrollBottom = window.innerHeight + window.scrollY;
          const documentHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
          if (documentHeight - scrollBottom <= 520) {
            applyLoadedAssetPage(page);
            return;
          }
          setPrefetchedAssetPage(page);
        })
        .finally(() => {
          if (!cancelled) {
            setPrefetchingAssetPage(false);
          }
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setPrefetchingAssetPage(false);
    };
  }, [
    activeProjectId,
    assetFeedHasMore,
    assetFeedNextOffset,
    assetPageLimit,
    favoritesOnly,
    galleryScrollArmed,
    galleryKindFilter,
    galleryModelFilter,
    loadingMoreAssets,
    prefetchedAssetPage,
  ]);

  useEffect(() => {
    if (
      !favoritesOnly ||
      !galleryScrollArmed ||
      !favoriteAssetFeedHasMore ||
      favoriteAssetFeedNextOffset == null ||
      loadingMoreFavoriteAssets ||
      prefetchedFavoriteAssetPage
    ) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPrefetchingFavoriteAssetPage(true);
      void fetchAssetPage({
        offset: favoriteAssetFeedNextOffset,
        favorited: true,
        limitOverride: ASSET_APPEND_BATCH_SIZE,
        silent: true,
      })
        .then((page) => {
          if (cancelled || !page) {
            return;
          }
          prefetchAssetThumbs(page.assets ?? [], prefetchedThumbUrls);
          const scrollBottom = window.innerHeight + window.scrollY;
          const documentHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
          if (documentHeight - scrollBottom <= 520) {
            applyLoadedFavoriteAssetPage(page);
            return;
          }
          setPrefetchedFavoriteAssetPage(page);
        })
        .finally(() => {
          if (!cancelled) {
            setPrefetchingFavoriteAssetPage(false);
          }
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setPrefetchingFavoriteAssetPage(false);
    };
  }, [
    favoriteAssetFeedHasMore,
    favoriteAssetFeedNextOffset,
    favoritesOnly,
    galleryScrollArmed,
    galleryKindFilter,
    galleryModelFilter,
    activeProjectId,
    loadingMoreFavoriteAssets,
    prefetchedFavoriteAssetPage,
  ]);
}
