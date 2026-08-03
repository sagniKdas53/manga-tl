import { safeFetch } from "../utils";

/**
 * Page image URLs for the reader, and authenticated access to originals for export.
 *
 * Replaces the fetch-to-blob cache in `authImage.ts`. That existed because
 * `/api/images/{id}/file` is `authenticated()` and `<img src>` cannot send a header — but the
 * reading variant at `/api/images/{id}/reader` is `permitAll` and long-cached, so displaying a
 * page needs no JavaScript at all now. Only export still touches the authenticated original.
 */

/**
 * `/api/images/{id}/file` -> `/api/images/{id}/reader`.
 *
 * The page DTO carries the original's URL; the reader wants the derived variant. Rewriting here
 * rather than adding a second DTO field keeps the API surface unchanged. The endpoint falls back
 * to the original's bytes when no variant was worth storing, so this is always safe.
 */
export const toReaderUrl = (url: string | undefined): string | undefined =>
  url?.replace(/\/file$/, "/reader");

/**
 * Loads an image's *original* bytes as an element ready to draw to a canvas.
 *
 * Export must not read from the on-screen `<img>`: that now holds a lossy WebP variant, so
 * `original.png` in the export ZIP would be a re-encode of a re-encode. This goes to `/file`
 * explicitly, which needs the JWT, hence fetch + object URL rather than a bare `src`.
 *
 * The object URL is revoked once the element has decoded; callers get a detached element that
 * stays valid for `drawImage`.
 */
export const loadOriginalImage = async (
  url: string,
  token: string,
): Promise<HTMLImageElement> => {
  const res = await safeFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to load original image: ${res.status}`);
  }
  const objectUrl = URL.createObjectURL(await res.blob());
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};
