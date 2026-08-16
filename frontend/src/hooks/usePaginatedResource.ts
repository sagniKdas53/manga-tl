import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type DependencyList,
} from "react";
import { safeFetch } from "../utils";

export interface PagedResponse<T> {
  content: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface UsePaginatedResourceResult<T> {
  items: T[];
  totalCount: number;
  hasMore: boolean;
  isLoading: boolean;
  /**
   * Message from the most recent failed fetch, or `null`. AUDIT-F12: without this a failed
   * page-0 fetch leaves an empty `items` that a caller cannot tell apart from a genuinely
   * empty library. (`safeFetch` also dispatches a global `api-error` event that `App.tsx`
   * turns into a toast, so a failure was never *silent* — but a transient toast can't
   * change what the list itself renders, which is what this is for.) Cleared by the next
   * successful fetch and by every reset.
   */
  error: string | null;
  /** Fetches the next sequential batch and appends it — the scroll-triggered case. */
  loadMore: () => void;
  /**
   * Fetches whichever batch contains `index` (a 0-based item position) if it isn't loaded
   * yet. `loadMore` is the special case `ensureLoaded(items.length)`; this is the
   * generalization the reader needs to jump straight to an arbitrary page — including one
   * nobody scrolled through — without dead-ending at the last-loaded batch boundary.
   */
  ensureLoaded: (index: number) => void;
  /**
   * The raw state setter, for the create/edit/delete flows that already do optimistic local
   * mutation (`setSeriesList((prev) => [...prev, created])` and friends) — those call sites
   * don't change just because the fetch underneath them became paginated. Note `totalCount`
   * isn't reconciled against manual mutations; `hasMore` can be off by the mutated count until
   * the next reset, which is harmless for a "load more" affordance.
   */
  setItems: Dispatch<SetStateAction<T[]>>;
  /**
   * Drops everything accumulated so far and refetches page 0, for the call sites that used
   * to re-GET the whole (then-unpaginated) list after a mutation — a delete, a reorder, an
   * upload batch finishing. Resolves once page 0 has landed. Note this does *not* restore
   * batches beyond page 0 that were previously loaded by scrolling; the caller sees the list
   * "rewound" to the first batch, same as a fresh visit to the page.
   *
   * Prefer `refresh` for post-mutation refetches: this empties `items` first, which
   * collapses the grid to nothing and throws the scroll position away.
   */
  reload: () => Promise<void>;
  /**
   * Refetches every batch that is currently loaded and swaps the results in *without* ever
   * emptying `items`. This is the post-mutation refetch: `reload` sets `items` to `[]`
   * before page 0 lands, which collapses the rendered grid to zero height, and the browser
   * clamps the scroll position to the new document height — so uploading a page while
   * scrolled halfway down a chapter threw the user back to the top and made them scroll
   * down again to find what they had just added. Rebuilding in place keeps the grid's
   * height stable across the swap, so the scroll position survives on its own.
   *
   * Deletions are pruned (the rebuilt list is exactly what the server just returned) and
   * items appended past the end are picked up when the loaded batches already reached the
   * end — the upload case, where the new pages belong right where the user is looking. If
   * some batch fails to refetch, the successful ones are merged over the existing list
   * instead of replacing it, so a partial failure cannot delete rows that still exist.
   */
  refresh: () => Promise<void>;
}

export interface UsePaginatedResourceOptions<T> {
  /** Extra query params (e.g. sortBy/sortDir) sent with every page fetch. */
  params?: Record<string, string>;
  /**
   * Batches can arrive out of numeric order when `ensureLoaded` jumps straight to a page
   * nobody scrolled through. Supplying this keeps `items` in a stable, display-correct
   * order; omit it for lists that only ever grow through `loadMore`, where append order
   * already matches the server's sort and re-sorting would buy nothing.
   */
  sortKey?: (item: T) => number;
}

/**
 * Backs all three infinite-scroll surfaces (series, chapters, pages) off one
 * implementation, rather than three bespoke fetch-and-accumulate effects.
 *
 * Resets and refetches page 0 whenever `url` or any entry in `deps` changes — callers pass
 * the primitives that should invalidate the accumulated list (e.g. a chapter id, or a sort
 * field/direction pair) rather than the `params`/`sortKey` object identities, which are
 * expected to be fresh references every render and would otherwise thrash the reset.
 */
export function usePaginatedResource<T extends { id: string }>(
  url: string | null,
  pageSize: number,
  token: string | undefined,
  deps: DependencyList,
  options: UsePaginatedResourceOptions<T> = {},
): UsePaginatedResourceResult<T> {
  const { params, sortKey } = options;
  const [items, setItems] = useState<T[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // AUDIT-F12: a refcount, not a boolean. Two fetches overlap routinely — the gallery's
  // sentinel and the reader's `ensureLoaded` share one hook instance — and a boolean lets
  // the first to settle clear the spinner while the second is still in flight.
  const [inFlightCount, setInFlightCount] = useState(0);
  // AUDIT-F11: the server already sends `totalPages` and the hook used to throw it away.
  // Mirrored into a ref as well because `fetchPage` has to consult it synchronously, before
  // any render; `null` means "page 0 hasn't landed, nothing is known yet".
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loadedPageCount, setLoadedPageCount] = useState(0);

  // Fetch bookkeeping lives in refs, not state: it exists purely to dedupe/guard requests
  // and must be readable synchronously from `loadMore`/`ensureLoaded` without waiting on a
  // render.
  const loadedPagesRef = useRef<Set<number>>(new Set());
  const inFlightRef = useRef<Set<number>>(new Set());
  const totalPagesRef = useRef<number | null>(null);
  const requestGenerationRef = useRef(0);

  // AUDIT-F10: `params` cannot go into a dependency list directly — callers build it fresh
  // every render and the identity churn would thrash the reset. Serializing it gives a
  // stable scalar that changes exactly when a value changes, so `fetchPage` can depend on
  // it honestly and the `eslint-disable` that hid the stale closure is gone. The query is
  // rebuilt *from this string* rather than from the captured object, so the two can't drift.
  const paramsKey = new URLSearchParams(params ?? {}).toString();

  // `sortKey` is a fresh closure every render by design (callers write it inline), and it
  // only ever orders an already-fetched batch — it can't change *what* is requested. Read
  // through a ref so it stays out of `fetchPage`'s dependency list without a suppression.
  // (Assigned in an effect, not during render — same pattern as `LoadMoreSentinel`'s
  // `onLoadMoreRef`. `fetchPage` only reads it from inside a `.then`, which always runs
  // after the effect for that render has committed.)
  const sortKeyRef = useRef(sortKey);
  useEffect(() => {
    sortKeyRef.current = sortKey;
  }, [sortKey]);

  /**
   * The bare network leg: request one batch, keep the in-flight bookkeeping honest, and hand
   * back the parsed body — or `null` when the request failed or a reset overtook it. It
   * deliberately touches neither `items` nor the loaded-page set; `fetchPage` (append) and
   * `refresh` (rebuild) each apply the result their own way, over one shared idea of how a
   * batch is fetched.
   */
  const requestPage = useCallback(
    (pageIndex: number): Promise<PagedResponse<T> | null> => {
      // Captured, not re-read in `finally`: a reset swaps `inFlightRef.current` for a fresh
      // Set, and a late `finally` deleting from the *new* set would clear a marker it never
      // set and reopen the dedupe window.
      const inFlight = inFlightRef.current;
      inFlight.add(pageIndex);
      setInFlightCount((n) => n + 1);
      const generation = requestGenerationRef.current;

      const query = new URLSearchParams({
        page: String(pageIndex),
        size: String(pageSize),
      });
      for (const [key, value] of new URLSearchParams(paramsKey)) {
        query.set(key, value);
      }

      return safeFetch(`${url}?${query.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
        .then((res) => {
          if (!res.ok)
            throw new Error(`Failed to fetch ${url} (page ${pageIndex})`);
          return res.json() as Promise<PagedResponse<T>>;
        })
        .then((data) => {
          // A reset (url/deps change) fired mid-flight — this response no longer applies.
          if (generation !== requestGenerationRef.current) return null;
          return data;
        })
        .catch((err) => {
          console.error("usePaginatedResource fetch failed:", err);
          // Same generation guard as the success path: a stale failure must not paint an
          // error over a list that has already been replaced.
          if (generation === requestGenerationRef.current) {
            setError(err instanceof Error ? err.message : String(err));
          }
          return null;
        })
        .finally(() => {
          inFlight.delete(pageIndex);
          setInFlightCount((n) => n - 1);
        });
    },
    [url, pageSize, token, paramsKey],
  );

  /** Merges a batch into `items` by id, re-applying `sortKey` when one was supplied. */
  const mergeIntoItems = useCallback((incoming: T[], base: T[] | null) => {
    setItems((prev) => {
      const byId = new Map((base ?? prev).map((item) => [item.id, item]));
      for (const item of incoming) byId.set(item.id, item);
      const merged = Array.from(byId.values());
      const orderBy = sortKeyRef.current;
      if (orderBy) merged.sort((a, b) => orderBy(a) - orderBy(b));
      return merged;
    });
  }, []);

  const fetchPage = useCallback(
    (pageIndex: number): Promise<void> => {
      if (!url || pageIndex < 0) return Promise.resolve();
      // AUDIT-F11 backstop: refuse a page index past the end of the resource. This is the
      // guarantee that holds even if `loadMore`'s seek or `hasMore` regresses later — an
      // unbounded walk becomes impossible rather than merely unlikely.
      const knownTotalPages = totalPagesRef.current;
      if (knownTotalPages !== null && pageIndex >= knownTotalPages) {
        return Promise.resolve();
      }
      if (
        loadedPagesRef.current.has(pageIndex) ||
        inFlightRef.current.has(pageIndex)
      ) {
        return Promise.resolve();
      }

      return requestPage(pageIndex).then((data) => {
        if (!data) return;
        loadedPagesRef.current.add(pageIndex);
        setLoadedPageCount(loadedPagesRef.current.size);
        totalPagesRef.current = data.totalPages;
        setTotalPages(data.totalPages);
        setTotalCount(data.totalElements);
        setError(null);
        mergeIntoItems(data.content, null);
      });
    },
    [url, requestPage, mergeIntoItems],
  );

  // Shared by the reset effect (url/deps changed) and `reload` (caller wants a fresh page 0
  // after a mutation) — both mean "forget what's loaded and start over."
  const resetAndFetchFirstPage = useCallback((): Promise<void> => {
    requestGenerationRef.current += 1;
    loadedPagesRef.current = new Set();
    inFlightRef.current = new Set();
    totalPagesRef.current = null;
    setItems([]);
    setTotalCount(0);
    setTotalPages(null);
    setLoadedPageCount(0);
    setError(null);
    // `inFlightCount` is deliberately *not* reset: the requests it counts are still
    // running and their `finally` blocks will each decrement once. Zeroing it here would
    // drive the count negative as they settle.
    return url ? fetchPage(0) : Promise.resolve();
  }, [url, fetchPage]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!url) return;
    const indices = Array.from(loadedPagesRef.current).sort((a, b) => a - b);
    // Nothing accumulated yet (the very first fetch is still in flight, or it failed):
    // there is no in-place swap to make, and page 0 is what a caller wants either way.
    if (indices.length === 0) {
      await resetAndFetchFirstPage();
      return;
    }

    const generation = requestGenerationRef.current;
    const previousTotalPages = totalPagesRef.current;
    // Whether the loaded batches ran all the way to the end *before* the mutation. If they
    // did, anything the server appended (an upload) belongs on screen right now; if they
    // didn't, the user is mid-list and the sentinel will reach the new tail in due course.
    const wasLoadedToEnd =
      previousTotalPages !== null &&
      loadedPagesRef.current.has(previousTotalPages - 1);

    const results = await Promise.all(indices.map((i) => requestPage(i)));
    // A reset (chapter change, sort change) overtook this refresh — its results describe a
    // list nobody is looking at any more.
    if (generation !== requestGenerationRef.current) return;

    const landed = results.filter((data): data is PagedResponse<T> => !!data);
    // Every batch failed: `requestPage` has already recorded the error, and the list the
    // user is looking at is still the best thing available.
    if (landed.length === 0) return;
    const allLanded = landed.length === results.length;

    // Concurrent responses agree on the totals; any of them will do.
    const totals = landed[landed.length - 1];
    totalPagesRef.current = totals.totalPages;
    setTotalPages(totals.totalPages);
    setTotalCount(totals.totalElements);
    if (allLanded) setError(null);

    // A mutation can shrink the resource (deleting the only page of the last batch), which
    // strands loaded indices past the new end — `hasMore` would then read as "more to load"
    // against batches that no longer exist.
    const stillLoaded = new Set(indices.filter((i) => i < totals.totalPages));
    loadedPagesRef.current = stillLoaded;
    setLoadedPageCount(stillLoaded.size);

    // `base: []` when everything landed — the rebuilt list is exactly what the server just
    // returned, which is what prunes deleted rows. On a partial failure the successful
    // batches merge over what is already there instead, so a network blip cannot silently
    // drop rows that still exist server-side.
    mergeIntoItems(
      landed.flatMap((data) => data.content),
      allLanded ? [] : null,
    );

    if (wasLoadedToEnd && totals.totalPages > (previousTotalPages ?? 0)) {
      await Promise.all(
        Array.from(
          { length: totals.totalPages - (previousTotalPages ?? 0) },
          (_, offset) => fetchPage((previousTotalPages ?? 0) + offset),
        ),
      );
    }
  }, [url, requestPage, resetAndFetchFirstPage, fetchPage, mergeIntoItems]);

  useEffect(() => {
    // Deferred to a microtask: this effect's own setState calls (via
    // resetAndFetchFirstPage) must not run synchronously in the effect body.
    Promise.resolve().then(() => {
      void resetAndFetchFirstPage();
    });
    // `deps` is spread deliberately: callers pass the values that should invalidate the
    // accumulated list, decoupled from `fetchPage`'s own identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);

  const loadMore = useCallback(() => {
    // AUDIT-F11: the lowest *unloaded* index, not `max(loaded) + 1`. `ensureLoaded` exists
    // to land a batch nobody scrolled to, and `max + 1` walks straight past the gap that
    // leaves — the skipped batches then have nothing that would ever go back for them.
    // In-flight pages are not skipped here; `fetchPage` already dedupes them, which
    // preserves the "calling loadMore repeatedly is harmless" contract LoadMoreSentinel
    // relies on.
    const loaded = loadedPagesRef.current;
    let next = 0;
    while (loaded.has(next)) next += 1;
    void fetchPage(next);
  }, [fetchPage]);

  const ensureLoaded = useCallback(
    (index: number) => {
      if (index < 0) return;
      void fetchPage(Math.floor(index / pageSize));
    },
    [fetchPage, pageSize],
  );

  // AUDIT-F11: batches loaded vs. batches that exist, not items vs. totalCount. The item
  // comparison can never converge once a sparse jump leaves a gap `loadMore` has walked
  // past, so it pinned `hasMore` to `true` and the sentinel kept firing forever.
  const hasMore = totalPages !== null && loadedPageCount < totalPages;

  return {
    items,
    totalCount,
    hasMore,
    isLoading: inFlightCount > 0,
    error,
    loadMore,
    ensureLoaded,
    setItems,
    reload: resetAndFetchFirstPage,
    refresh,
  };
}
