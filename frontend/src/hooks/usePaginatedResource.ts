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
   */
  reload: () => Promise<void>;
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
          if (generation !== requestGenerationRef.current) return;
          loadedPagesRef.current.add(pageIndex);
          setLoadedPageCount(loadedPagesRef.current.size);
          totalPagesRef.current = data.totalPages;
          setTotalPages(data.totalPages);
          setTotalCount(data.totalElements);
          setError(null);
          setItems((prev) => {
            const byId = new Map(prev.map((item) => [item.id, item]));
            for (const item of data.content) byId.set(item.id, item);
            const merged = Array.from(byId.values());
            const orderBy = sortKeyRef.current;
            if (orderBy) merged.sort((a, b) => orderBy(a) - orderBy(b));
            return merged;
          });
        })
        .catch((err) => {
          console.error("usePaginatedResource fetch failed:", err);
          // Same generation guard as the success path: a stale failure must not paint an
          // error over a list that has already been replaced.
          if (generation !== requestGenerationRef.current) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          inFlight.delete(pageIndex);
          setInFlightCount((n) => n - 1);
        });
    },
    [url, pageSize, token, paramsKey],
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
  };
}
