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

  it("loadMore fetches the next sequential batch and appends it", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 25, 2),
    );
    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 25, "tok", []),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "2", pageNumber: 26 }], 1, 25, 2),
    );
    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.items.map((i) => i.id)).toEqual(["1", "2"]);
    expect(result.current.hasMore).toBe(false);
    expect(mockSafeFetch).toHaveBeenLastCalledWith(
      "/api/things?page=1&size=25",
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
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 25, 2),
    );
    const { result } = renderHook(() =>
      usePaginatedResource<Item>("/api/things", 25, "tok", []),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "2", pageNumber: 26 }], 1, 25, 2),
    );
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    mockSafeFetch.mockResolvedValueOnce(
      pagedResponse([{ id: "1", pageNumber: 1 }], 0, 25, 26),
    );
    await act(async () => {
      await result.current.reload();
    });

    // Rewound to page 0's content only, not the two accumulated batches.
    expect(result.current.items.map((i) => i.id)).toEqual(["1"]);
  });
});
