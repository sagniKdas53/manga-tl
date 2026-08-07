import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { usePaginatedResource } from "../../hooks/usePaginatedResource";

const mockSafeFetch = vi.fn();
vi.mock("../../utils", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

interface Item {
  id: string;
  pageNumber: number;
}

function pagedResponse(
  content: Item[],
  page: number,
  size: number,
  totalElements: number,
) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        content,
        page,
        size,
        totalElements,
        totalPages: Math.ceil(totalElements / size),
      }),
  };
}

describe("usePaginatedResource", () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
  });

  it("fetches page 0 on mount and exposes items/totalCount/hasMore", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse(
        [
          { id: "1", pageNumber: 1 },
          { id: "2", pageNumber: 2 },
        ],
        0,
        25,
        30,
      ),
    );

    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 25, "tok", []),
    );

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.totalCount).toBe(30);
    expect(result.current.hasMore).toBe(true);
    expect(mockSafeFetch).toHaveBeenCalledWith("/api/things?page=0&size=25", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  // Page size 1 so the fixture is self-consistent: 2 elements really is 2 batches. It used
  // to say `size: 25, totalElements: 2` — a one-page resource — and then expect a page 1,
  // which only "worked" because nothing bounded the walk (AUDIT-F11).
  it("loadMore fetches the next sequential batch and appends it", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 1, 2),
    );
    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 1, "tok", []),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "2", pageNumber: 26 }], 1, 1, 2),
    );
    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.items.map((i) => i.id)).toEqual(["1", "2"]);
    expect(result.current.hasMore).toBe(false);
    expect(mockSafeFetch).toHaveBeenLastCalledWith(
      "/api/things?page=1&size=1",
      expect.any(Object),
    );
  });

  it("ensureLoaded fetches only the batch containing an arbitrary index — the reader's deep-link/jump case", async () => {
    mockSafeFetch.mockResolvedValueOnce(pagedResponse([], 0, 25, 100));
    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 25, "tok", []),
    );
    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(1));

    // index 80 with pageSize 25 -> floor(80/25) = batch 3, not batch 1 or a sequential walk
    // through 1, 2, 3.
    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "81", pageNumber: 81 }], 3, 25, 100),
    );
    act(() => {
      result.current.ensureLoaded(80);
    });

    await waitFor(() =>
      expect(mockSafeFetch).toHaveBeenLastCalledWith(
        "/api/things?page=3&size=25",
        expect.any(Object),
      ),
    );
    await waitFor(() =>
      expect(result.current.items.map((i) => i.id)).toContain("81"),
    );
    // Only two fetches happened: the initial page 0 and the direct jump to page 3 — no
    // sequential walk through the pages in between.
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it("ensureLoaded is a no-op once the containing batch is already loaded", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 25, 25),
    );
    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 25, "tok", []),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => {
      result.current.ensureLoaded(0);
    });

    // No new request — page 0 already covers index 0.
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it("discards a stale in-flight response once url has changed — the generation guard", async () => {
    let resolveStale: (v: unknown) => void = () => {};
    const stale = new Promise((r) => {
      resolveStale = r;
    });
    mockSafeFetch.mockImplementationOnce(() => stale);

    const { result, rerender } = renderHook(
      ({ url }: { url: string }) =>
        usePaginatedResource<Item>(url, 25, "tok", []),
      { initialProps: { url: "/api/a" } },
    );

    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(1));

    // The url changes (e.g. a chapter switch) before /api/a's page 0 has resolved.
    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "b1", pageNumber: 1 }], 0, 25, 1),
    );
    rerender({ url: "/api/b" });

    await waitFor(() =>
      expect(result.current.items.map((i) => i.id)).toEqual(["b1"]),
    );

    // The stale /api/a response now lands — it must not overwrite /api/b's data.
    await act(async () => {
      resolveStale(pagedResponse([{ id: "a1", pageNumber: 1 }], 0, 25, 1));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.items.map((i) => i.id)).toEqual(["b1"]);
  });

  it("reload drops accumulated items and refetches page 0", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 1, 2),
    );
    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 1, "tok", []),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "2", pageNumber: 26 }], 1, 1, 2),
    );
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 1, 26),
    );
    await act(async () => {
      await result.current.reload();
    });

    // Rewound to page 0's content only, not the two accumulated batches.
    expect(result.current.items.map((i) => i.id)).toEqual(["1"]);
  });

  // AUDIT-F10: `fetchPage` used to omit `params` from its `useCallback` deps behind an
  // `eslint-disable`, so the object captured at first render was the one every subsequent
  // fetch used. The reset fired correctly on a `deps` change and then re-requested the
  // *previous* sort, which is what made both sort controls dead.
  it("re-fetches with the NEW params when a sort param changes", async () => {
    mockSafeFetch.mockResolvedValue(pagedResponse([], 0, 10, 0));

    const { rerender } = renderHook(
      ({ dir }: { dir: "asc" | "desc" }) =>
        usePaginatedResource<Item>("/api/series", 10, "tok", [dir], {
          params: { sortDir: dir },
        }),
      { initialProps: { dir: "desc" as "asc" | "desc" } },
    );

    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(1));
    expect(mockSafeFetch.mock.calls[0][0]).toContain("sortDir=desc");

    rerender({ dir: "asc" });

    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(2));
    expect(mockSafeFetch.mock.calls[1][0]).toContain("sortDir=asc");
  });

  it("does not reset the accumulated list when params is a fresh object of equal value", async () => {
    mockSafeFetch.mockResolvedValue(
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 10, 40),
    );

    const { rerender } = renderHook(
      () =>
        // A new object literal every render — the identity churn `deps` exists to decouple.
        usePaginatedResource<Item>("/api/series", 10, "tok", [], {
          params: { sortDir: "desc" },
        }),
      {},
    );

    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    await Promise.resolve();
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  // AUDIT-F11: a sparse jump (`ensureLoaded`'s whole reason to exist) used to strand the
  // skipped batches — `loadMore` walked `max(loaded) + 1`, `hasMore` compared item counts
  // that could then never converge, and nothing refused a page index past the end. The
  // sentinel drove that into an unbounded walk: a 4-page resource was asked for page 15.
  it("a sparse jump then repeated loadMore fills the gaps, terminates, and never requests a page past the end", async () => {
    const TOTAL = 100;
    const SIZE = 25;
    mockSafeFetch.mockImplementation((url: string) => {
      const page = Number(
        new URL(url, "http://test").searchParams.get("page") ?? "0",
      );
      const content: Item[] = [];
      for (let i = 0; i < SIZE; i++) {
        const n = page * SIZE + i;
        if (n < TOTAL) content.push({ id: String(n), pageNumber: n + 1 });
      }
      return Promise.resolve(pagedResponse(content, page, SIZE, TOTAL));
    });

    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", SIZE, "tok", [], {
        sortKey: (p) => p.pageNumber,
      }),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(SIZE));

    // The reader deep-links to a high page: batch 3 lands, batches 1 and 2 never did.
    await act(async () => {
      result.current.ensureLoaded(80);
    });
    await waitFor(() => expect(result.current.items).toHaveLength(SIZE * 2));

    // Now the gallery's sentinel scrolls. Twelve intersections is well past the four
    // batches this resource has.
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        result.current.loadMore();
      });
    }

    const requested = mockSafeFetch.mock.calls.map((c) =>
      Number(new URL(c[0] as string, "http://test").searchParams.get("page")),
    );
    expect(Math.max(...requested)).toBeLessThanOrEqual(3);
    expect(new Set(requested)).toEqual(new Set([0, 1, 2, 3]));
    expect(result.current.items).toHaveLength(TOTAL);
    expect(result.current.hasMore).toBe(false);
  });

  it("refuses a page index at or past totalPages once totalPages is known", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 25, 30),
    );
    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 25, "tok", []),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // 30 elements at size 25 is 2 batches; index 500 is batch 20.
    await act(async () => {
      result.current.ensureLoaded(500);
    });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  // AUDIT-F12: `isLoading` was a plain boolean set true by every fetch and false by every
  // `.finally()`, so the first of two overlapping requests to settle cleared the spinner
  // while the second was still in flight.
  it("keeps isLoading true until every in-flight fetch has settled", async () => {
    let resolveA: (v: unknown) => void = () => {};
    let resolveB: (v: unknown) => void = () => {};
    mockSafeFetch
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveA = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveB = r;
          }),
      );

    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 25, "tok", []),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(true));

    // Page 0 is still in flight; the reader jumps, so a second request overlaps it.
    await act(async () => {
      result.current.ensureLoaded(80);
    });
    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveA(pagedResponse([{ id: "1", pageNumber: 1 }], 0, 25, 100));
    });
    // The jump has not landed yet — the spinner must not disappear.
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveB(pagedResponse([{ id: "81", pageNumber: 81 }], 3, 25, 100));
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it("exposes an error so a failed page-0 fetch is distinguishable from an empty library", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 25, "tok", []),
    );

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.items).toHaveLength(0);
    expect(result.current.isLoading).toBe(false);
  });

  it("clears a previous error once a fetch succeeds again", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) =>
        usePaginatedResource<Item>(url, 25, "tok", [url]),
      { initialProps: { url: "/api/a" } },
    );
    await waitFor(() => expect(result.current.error).toBeTruthy());

    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 25, 1),
    );
    rerender({ url: "/api/b" });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });
});
