/**
 * Tracker R7: the Inpainting layer in the editor.
 *
 * Each worker cleanup patch is an element on a `type: "inpainting"` layer, drawn between the page
 * image and the text. The rules here mirror the backend scene builder
 * (`backend-rust/src/page_scene_builder.rs`, `build_pipeline_scene`) so the editor paints exactly
 * what the export paints: the same patches, in the same order, at the same rects and opacity.
 */
import { useEffect, useState } from "react";
import { cleanupOpacity } from "@manga-library/page-scene";
import type { Layer, LayerElement, OcrRegion } from "../types";
import { safeFetch } from "../utils";

export const INPAINTING_LAYER_TYPE = "inpainting";

export {
  cleanupOpacity,
  CLEANUP_PRESERVE_ASPECT_RATIO,
} from "@manga-library/page-scene";

type LayerData = { layer: Layer; elements: LayerElement[] };

export const isInpaintingLayer = (layer: Pick<Layer, "type">): boolean =>
  layer.type.toLowerCase() === INPAINTING_LAYER_TYPE;

export const isPatchElement = (
  element: Pick<LayerElement, "cleanupRef"> | null | undefined,
): boolean => Boolean(element?.cleanupRef);

/**
 * Postgres orders uuids by their bytes, which for the canonical lowercase spelling is plain string
 * order. `localeCompare` is not: it can disagree on hyphens and digits, so use `<` only.
 */
const compareIds = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

const hasText = (text: string | null | undefined) => Boolean(text?.trim());

/**
 * Whether a region's patch may be drawn (user decision R7-D4): the region has visible English, or
 * its own translation is usable. A rejected, failed or refused region keeps its source pixels.
 * Hiding a text layer or one text element keeps the patch: that is the page a user letters by hand.
 */
export function regionAllowsPatch(
  region: OcrRegion,
  layers: LayerData[],
): boolean {
  const hasVisibleText = layers.some(
    ({ layer, elements }) =>
      layer.visible === true &&
      ["translation", "sfx"].includes(layer.type.toLowerCase()) &&
      elements.some(
        (element) =>
          element.regionId === region.id &&
          // The builder reads a text element's null `visible` as shown (COALESCE(visible, TRUE)).
          element.visible !== false &&
          hasText(element.text),
      ),
  );
  if (hasVisibleText) return true;
  return (
    // QA's `reject_sfx` hides the text but keeps `translatedText`; it is no usable English.
    region.qaStatus !== "rejected" &&
    region.qaStatus !== "reject_sfx" &&
    !region.translationFailed &&
    hasText(region.translatedText)
  );
}

/**
 * A region with a worker patch never gets the flat `backgroundColor` plate, even when the user has
 * hidden or deleted the patch (then the source shows). The plate is only the fallback for a region
 * whose cleanup produced nothing.
 */
export const regionHasPatch = (region: OcrRegion | null | undefined): boolean =>
  Boolean(region?.cleanupPatchSha256);

export interface PaintedPatch {
  element: LayerElement;
  patchSha256: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** undefined when opaque, as in the export. */
  opacity: number | undefined;
}

/** The patches the export draws, in its paint order: layer by layer, then each patch's order. */
export function paintedPatches(
  layers: LayerData[],
  regions: OcrRegion[],
): PaintedPatch[] {
  const regionById = new Map(regions.map((region) => [region.id, region]));
  return layers
    .filter(({ layer }) => layer.visible === true && isInpaintingLayer(layer))
    .sort(
      (a, b) =>
        a.layer.zOrder - b.layer.zOrder ||
        (a.layer.createdAt < b.layer.createdAt
          ? -1
          : a.layer.createdAt > b.layer.createdAt
            ? 1
            : 0) ||
        compareIds(a.layer.id, b.layer.id),
    )
    .flatMap(({ elements }) =>
      elements
        .filter((element) => element.visible === true && element.cleanupRef)
        .sort(
          (a, b) =>
            a.cleanupRef!.order - b.cleanupRef!.order || compareIds(a.id, b.id),
        ),
    )
    .filter((element) => {
      const region = element.regionId
        ? regionById.get(element.regionId)
        : undefined;
      return !region || regionAllowsPatch(region, layers);
    })
    .filter(
      (element) => (element.maxWidth ?? 0) > 0 && (element.maxHeight ?? 0) > 0,
    )
    .map((element) => ({
      element,
      patchSha256: element.cleanupRef!.patchSha256,
      x: element.x,
      y: element.y,
      width: element.maxWidth!,
      height: element.maxHeight!,
      opacity: cleanupOpacity(element.opacity ?? undefined),
    }));
}

export const sceneAssetUrl = (pageId: string, sha256: string) =>
  `/api/pages/${pageId}/scene-assets/${sha256}`;

/** One patch's bytes; the route needs the JWT, so `<image href>` cannot load it directly. */
export async function fetchSceneAsset(
  pageId: string,
  sha256: string,
  token: string,
  priority: RequestPriority = "auto",
): Promise<Blob> {
  const response = await safeFetch(sceneAssetUrl(pageId, sha256), {
    headers: { Authorization: `Bearer ${token}` },
    priority,
  });
  if (!response.ok) {
    throw new Error(
      `Cleanup patch ${sha256} failed with HTTP ${response.status}`,
    );
  }
  return response.blob();
}

/**
 * Object URLs for scene assets (patches and masks), shared by every page of the session.
 *
 * Assets are content-addressed, so one sha256 is one image wherever it appears. The first
 * version kept URLs per page and revoked them on every page turn, so each turn -- forward or
 * back -- re-fetched all of a page's patches after the page was already on screen: measured
 * 2026-09-28 at 3-17 requests landing 0.25-0.95 s after the page image, the English sitting
 * on the un-erased Japanese until they did. This cache survives page turns, the Reader fills it
 * ahead of time from its details prefetch, and least-recently-used entries past the limit are
 * revoked.
 */
const ASSET_CACHE_LIMIT = 600;
const assetCache = new Map<
  string,
  { url: string | null; pending: Promise<string | null> | null }
>();

const touchAsset = (sha256: string) => {
  const entry = assetCache.get(sha256);
  if (!entry) return;
  assetCache.delete(sha256);
  assetCache.set(sha256, entry);
};

const evictAssets = () => {
  for (const [sha256, entry] of assetCache) {
    if (assetCache.size <= ASSET_CACHE_LIMIT) break;
    if (!entry.url) continue; // still loading
    assetCache.delete(sha256);
    URL.revokeObjectURL(entry.url);
  }
};

/** The asset's object URL if it is already loaded. */
export const peekSceneAssetUrl = (sha256: string) =>
  assetCache.get(sha256)?.url ?? undefined;

/** Loads (once) and caches one asset's object URL; null if it could not be fetched. */
export function loadSceneAssetUrl(
  pageId: string,
  sha256: string,
  token: string,
  priority: RequestPriority = "auto",
): Promise<string | null> {
  const hit = assetCache.get(sha256);
  if (hit?.url) {
    touchAsset(sha256);
    return Promise.resolve(hit.url);
  }
  if (hit?.pending) return hit.pending;
  const pending = fetchSceneAsset(pageId, sha256, token, priority)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      assetCache.set(sha256, { url, pending: null });
      touchAsset(sha256);
      evictAssets();
      return url;
    })
    .catch((err) => {
      assetCache.delete(sha256);
      console.error(err);
      return null;
    });
  assetCache.set(sha256, { url: null, pending });
  return pending;
}

/** Empties the cache, revoking every URL (sign-out, tests). */
export function clearSceneAssetCache() {
  for (const entry of assetCache.values()) {
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
  assetCache.clear();
}

/**
 * Object URLs for these assets of the page, keyed by sha256, from the shared cache. What is
 * already cached is returned on the first render; the rest arrives together once it has loaded.
 */
export function usePatchImageUrls(
  pageId: string | null | undefined,
  token: string,
  sha256s: string[],
): Record<string, string> {
  const [, setLoadedCount] = useState(0);
  const wanted = [...new Set(sha256s)].sort().join(",");

  useEffect(() => {
    if (!pageId || !wanted) return;
    const missing = wanted.split(",").filter((sha) => !peekSceneAssetUrl(sha));
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(
      missing.map((sha) => loadSceneAssetUrl(pageId, sha, token)),
    ).then(() => {
      if (!cancelled) setLoadedCount((count) => count + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [pageId, token, wanted]);

  const urls: Record<string, string> = {};
  if (pageId && wanted) {
    for (const sha of wanted.split(",")) {
      const url = peekSceneAssetUrl(sha);
      if (url) urls[sha] = url;
    }
  }
  return urls;
}
