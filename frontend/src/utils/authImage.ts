import { useEffect, useState } from "react";
import { safeFetch } from "../utils";

/**
 * Loads authenticated page images through `fetch` and hands the caller an object URL.
 *
 * `<img src>` cannot carry an `Authorization` header, so the session JWT used to be appended to the
 * image URL as `?token=`. AUDIT-S4 removed the query-string credential path from `JwtAuthFilter`
 * entirely — which is correct, but it left every full-size reader image returning 401, because
 * `/api/images/{id}/file` is `authenticated()` (only `/thumbnail` is `permitAll`, which is why
 * galleries kept working and the reader did not).
 *
 * The image bytes are therefore fetched with a header and wrapped in a blob URL. No credential ever
 * reaches the URL bar, the access log, or the referrer — the property AUDIT-S4 was protecting.
 */

/**
 * The reader prefetches a five-page window (current ±2). The cap sits above that so an ordinary
 * page turn never evicts something the window is about to ask for again, while a long chapter
 * cannot accumulate 55 decoded pages worth of blobs.
 */
const MAX_CACHED_IMAGES = 12;

type CacheEntry = {
  /** Resolves to the object URL. Shared so concurrent callers issue one request. */
  promise: Promise<string>;
  /** Set once resolved, so eviction can revoke it. */
  objectUrl: string | null;
  /** Entries a mounted component is currently displaying are never evicted. */
  pins: number;
};

const cache = new Map<string, CacheEntry>();

/** Re-inserting moves the key to the end of the Map's insertion order, making eviction LRU. */
const touch = (key: string, entry: CacheEntry) => {
  cache.delete(key);
  cache.set(key, entry);
};

const evictIfNeeded = () => {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHED_IMAGES) return;
    if (entry.pins > 0) continue;
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    cache.delete(key);
  }
};

const load = (url: string, token: string): CacheEntry => {
  const existing = cache.get(url);
  if (existing) {
    touch(url, existing);
    return existing;
  }

  const entry: CacheEntry = {
    objectUrl: null,
    pins: 0,
    promise: safeFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(async (res) => {
      if (!res.ok) {
        throw new Error(`Image request failed: ${res.status}`);
      }
      const objectUrl = URL.createObjectURL(await res.blob());
      // The entry may have been dropped by a failed sibling load or a cache clear while the
      // request was in flight; revoking immediately keeps that from leaking.
      if (cache.get(url) === entry) {
        entry.objectUrl = objectUrl;
      } else {
        URL.revokeObjectURL(objectUrl);
      }
      return objectUrl;
    }),
  };

  entry.promise.catch(() => {
    // Drop failures so a later navigation retries instead of replaying the rejection forever.
    if (cache.get(url) === entry) cache.delete(url);
  });

  cache.set(url, entry);
  evictIfNeeded();
  return entry;
};

/**
 * Warms the cache without rendering. Replaces the `new Image()` prefetch, which relied on the
 * browser's HTTP cache being reachable from an unauthenticated `<img>` request.
 */
export const prefetchAuthImage = (url: string, token: string): void => {
  load(url, token).promise.catch(() => {
    /* Prefetch is best-effort; the page's own load reports the error. */
  });
};

/** Drops every cached blob. Call on logout so image bytes do not outlive the session. */
export const clearAuthImageCache = (): void => {
  for (const entry of cache.values()) {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  }
  cache.clear();
};

/**
 * Returns the object URL for `url`, or null while it is loading or if it failed.
 *
 * The entry is pinned for as long as the caller is mounted and showing it, so the displayed image
 * cannot be evicted out from under the `<img>` by prefetches of neighbouring pages.
 */
export const useAuthImage = (
  url: string | undefined,
  token: string,
): { src: string | null; error: boolean } => {
  // The resolved URL is stored with the request it belongs to. Comparing it against the current
  // `url` during render is what keeps the previous page's image from showing under the new page's
  // overlays, without a state reset in the effect body.
  const [resolved, setResolved] = useState<{
    url: string | null;
    src: string | null;
    error: boolean;
  }>({ url: null, src: null, error: false });

  useEffect(() => {
    if (!url || !token) return;

    let active = true;
    const entry = load(url, token);
    entry.pins += 1;

    entry.promise
      .then((objectUrl) => {
        if (active) setResolved({ url, src: objectUrl, error: false });
      })
      .catch(() => {
        if (active) setResolved({ url, src: null, error: true });
      });

    return () => {
      active = false;
      entry.pins -= 1;
      evictIfNeeded();
    };
  }, [url, token]);

  const isCurrent = url != null && resolved.url === url;
  return {
    src: isCurrent ? resolved.src : null,
    error: isCurrent ? resolved.error : false,
  };
};
