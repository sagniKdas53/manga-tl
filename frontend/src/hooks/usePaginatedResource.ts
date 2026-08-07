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
  const [isLoading, setIsLoading] = useState(false);

  // Fetch bookkeeping lives in refs, not state: it exists purely to dedupe/guard requests
  // and must be readable synchronously from `loadMore`/`ensureLoaded` without waiting on a
  // render.
  const loadedPagesRef = useRef<Set<number>>(new Set());
  const inFlightRef = useRef<Set<number>>(new Set());
  const requestGenerationRef = useRef(0);

  const fetchPage = useCallback(
    (pageIndex: number): Promise<void> => {
      if (!url || pageIndex < 0) return Promise.resolve();
      if (
        loadedPagesRef.current.has(pageIndex) ||
        inFlightRef.current.has(pageIndex)
      ) {
        return Promise.resolve();
      }

      inFlightRef.current.add(pageIndex);
      setIsLoading(true);
      const generation = requestGenerationRef.current;

      const query = new URLSearchParams({
        page: String(pageIndex),
        size: String(pageSize),
        ...params,
      });

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
          setTotalCount(data.totalElements);
          setItems((prev) => {
            const byId = new Map(prev.map((item) => [item.id, item]));
            for (const item of data.content) byId.set(item.id, item);
            const merged = Array.from(byId.values());
            if (sortKey) merged.sort((a, b) => sortKey(a) - sortKey(b));
            return merged;
          });
        })
        .catch((err) =>
          console.error("usePaginatedResource fetch failed:", err),
        )
        .finally(() => {
          inFlightRef.current.delete(pageIndex);
          setIsLoading(false);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url, pageSize, token],
  );

  // Shared by the reset effect (url/deps changed) and `reload` (caller wants a fresh page 0
  // after a mutation) — both mean "forget what's loaded and start over."
  const resetAndFetchFirstPage = useCallback((): Promise<void> => {
    requestGenerationRef.current += 1;
    loadedPagesRef.current = new Set();
    inFlightRef.current = new Set();
    setItems([]);
    setTotalCount(0);
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
    const next =
      loadedPagesRef.current.size === 0
        ? 0
        : Math.max(...loadedPagesRef.current) + 1;
    void fetchPage(next);
  }, [fetchPage]);

  const ensureLoaded = useCallback(
    (index: number) => {
      if (index < 0) return;
      void fetchPage(Math.floor(index / pageSize));
    },
    [fetchPage, pageSize],
  );

  const hasMore = items.length < totalCount;

  return {
    items,
    totalCount,
    hasMore,
    isLoading,
    loadMore,
    ensureLoaded,
    setItems,
    reload: resetAndFetchFirstPage,
  };
}
