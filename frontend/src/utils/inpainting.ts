/**
 * Tracker R7: the Inpainting layer in the editor.
 *
 * Each worker cleanup patch is an element on a `type: "inpainting"` layer, drawn between the page
 * image and the text. The rules here mirror the backend scene builder
 * (`backend-rust/src/page_scene_builder.rs`, `build_pipeline_scene`) so the editor paints exactly
 * what the export paints: the same patches, in the same order, at the same rects and opacity.
 */
import { useEffect, useRef, useState } from "react";
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
): Promise<Blob> {
  const response = await safeFetch(sceneAssetUrl(pageId, sha256), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `Cleanup patch ${sha256} failed with HTTP ${response.status}`,
    );
  }
  return response.blob();
}

/**
 * Object URLs for the page's patches, keyed by sha256. Patches are immutable, so each is fetched
 * once per page; the URLs are revoked when the page changes or the editor closes.
 */
export function usePatchImageUrls(
  pageId: string | null | undefined,
  token: string,
  sha256s: string[],
): Record<string, string> {
  const [loaded, setLoaded] = useState<{
    pageId: string | null;
    urls: Record<string, string>;
  }>({
    pageId: null,
    urls: {},
  });
  const owned = useRef<{ pageId: string | null; urls: string[] }>({
    pageId: null,
    urls: [],
  });
  const wanted = [...new Set(sha256s)].sort().join(",");

  // Revoke everything the previous page created, and everything on unmount.
  useEffect(() => {
    return () => {
      owned.current.urls.forEach((url) => URL.revokeObjectURL(url));
      owned.current = { pageId: null, urls: [] };
    };
  }, [pageId]);

  useEffect(() => {
    if (!pageId || !wanted) return;
    const have = loaded.pageId === pageId ? loaded.urls : {};
    const missing = wanted.split(",").filter((sha) => !(sha in have));
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (sha) => {
        try {
          return [
            sha,
            URL.createObjectURL(await fetchSceneAsset(pageId, sha, token)),
          ] as const;
        } catch (err) {
          console.error(err);
          return null;
        }
      }),
    ).then((entries) => {
      const fetched = entries.filter((entry) => entry !== null);
      if (cancelled) {
        fetched.forEach(([, url]) => URL.revokeObjectURL(url));
        return;
      }
      owned.current = {
        pageId,
        urls: [...owned.current.urls, ...fetched.map(([, url]) => url)],
      };
      setLoaded((prev) => ({
        pageId,
        urls: {
          ...(prev.pageId === pageId ? prev.urls : {}),
          ...Object.fromEntries(fetched),
        },
      }));
    });
    return () => {
      cancelled = true;
    };
    // `loaded` is read only to skip what is already fetched; re-running on it would fetch nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, token, wanted]);

  return loaded.pageId === pageId ? loaded.urls : {};
}
