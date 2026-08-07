import React, { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Dashboard from "../../components/Dashboard";
import { usePaginatedResource } from "../../hooks/usePaginatedResource";
import type { Series } from "../../types";

/**
 * AUDIT-T3: the AUDIT-F8 suite tests `Dashboard` with its sort props *injected* and
 * `usePaginatedResource` with *literal* arguments, so AUDIT-F10 — which lives in the wiring
 * between them — fell through the seam and shipped with 316 green tests over it. This file
 * closes that seam: it renders the real `Dashboard` against the real hook, wired the way
 * `App.tsx` wires them, and asserts on what actually goes over the wire.
 */

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({ showToast: vi.fn(), showError: vi.fn() }),
}));

const mockSafeFetch = vi.fn();
vi.mock("../../utils", () => ({
  safeFetch: (url: string, ...args: unknown[]) => {
    if (typeof url === "string" && url.includes("/api/settings")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return mockSafeFetch(url, ...args);
  },
  toSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "-"),
}));

const mockUser = {
  id: "1",
  username: "testuser",
  email: "test@test.com",
  displayName: "testuser",
  role: "translator",
  token: "token123",
};

function seriesPage(ids: string[], totalElements: number) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        content: ids.map((id) => ({
          id,
          title: `Series ${id}`,
          description: "",
          chapterCount: 0,
        })),
        page: 0,
        size: 10,
        totalElements,
        totalPages: Math.ceil(totalElements / 10),
      }),
  };
}

/**
 * The composition under test — a faithful transcription of `App.tsx:301-326` plus
 * `:577-590`, with the router and auth shell left out because neither participates in the
 * behaviour. If `App.tsx`'s wiring changes, this harness must change with it.
 */
const DashboardWithPagination: React.FC = () => {
  const [sortBy, setSortBy] = useState<"createdAt" | "updatedAt">("updatedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const seriesPagination = usePaginatedResource<Series>(
    "/api/series",
    10,
    mockUser.token,
    [sortBy, sortDir],
    { params: { sortBy, sortDir } },
  );

  return (
    <Dashboard
      user={mockUser as never}
      seriesList={seriesPagination.items}
      setSeriesList={seriesPagination.setItems}
      onSelectSeries={vi.fn()}
      mode="dark"
      sortBy={sortBy}
      setSortBy={setSortBy}
      sortDir={sortDir}
      setSortDir={setSortDir}
      hasMore={seriesPagination.hasMore}
      isLoadingMore={seriesPagination.isLoading}
      onLoadMore={seriesPagination.loadMore}
      loadError={seriesPagination.error}
    />
  );
};

function requestedSorts() {
  return mockSafeFetch.mock.calls.map((c) => {
    const params = new URL(c[0] as string, "http://test").searchParams;
    return `${params.get("sortBy")}-${params.get("sortDir")}`;
  });
}

describe("Dashboard + usePaginatedResource wiring (AUDIT-F10 / AUDIT-T3)", () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
    localStorage.clear();
  });

  it("requests the sort the user just picked, not the one that was active before", async () => {
    mockSafeFetch.mockResolvedValue(seriesPage(["s1"], 1));

    render(<DashboardWithPagination />);

    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(1));
    expect(requestedSorts()[0]).toBe("updatedAt-desc");

    // Pick "Created Date ↑" — a change of both field and direction.
    fireEvent.mouseDown(document.querySelector('[role="combobox"]')!);
    fireEvent.click(await screen.findByText("Created Date ↑"));

    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(2));
    // The whole point: the second request carries the NEW sort. Before AUDIT-F10 was
    // fixed it carried "updatedAt-desc" again, forever.
    expect(requestedSorts()[1]).toBe("createdAt-asc");
  });

  // AUDIT-F12: an empty grid used to mean "no series yet" and "the fetch failed" equally.
  it("tells the user the list failed rather than rendering as an empty library", async () => {
    mockSafeFetch.mockResolvedValue({ ok: false, status: 500 });

    render(<DashboardWithPagination />);

    expect(await screen.findByText(/Couldn't load your series/)).toBeTruthy();
  });

  it("persists the picked sort to localStorage and keeps requesting it on load-more", async () => {
    mockSafeFetch.mockResolvedValue(seriesPage(["s1"], 40));

    render(<DashboardWithPagination />);
    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(1));

    fireEvent.mouseDown(document.querySelector('[role="combobox"]')!);
    fireEvent.click(await screen.findByText("Last Updated ↑"));

    await waitFor(() => expect(mockSafeFetch).toHaveBeenCalledTimes(2));
    expect(localStorage.getItem("dashboard_sort_by")).toBe("updatedAt");
    expect(localStorage.getItem("dashboard_sort_dir")).toBe("asc");
    expect(requestedSorts()[1]).toBe("updatedAt-asc");
  });
});
