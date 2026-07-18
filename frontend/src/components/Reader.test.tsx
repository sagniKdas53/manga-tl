import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Reader } from "./Reader";

// Mock external modules
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: vi.fn(() => ({ pageNumber: "1" })),
}));

export const mockSubscribe = vi.fn(() => vi.fn());
vi.mock("./useNotifications", () => ({
  useNotifications: () => ({ notifications: [], subscribe: mockSubscribe }),
}));

export const mockShowToast = vi.fn();
vi.mock("./ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
    showSuccess: vi.fn(),
    showError: vi.fn(),
  }),
}));

const mockSafeFetch = vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
);
vi.mock("../utils", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  toSlug: (s: string) => s.toLowerCase(),
}));

describe("Reader Component", () => {
  const mockUser = {
    id: "1",
    username: "testuser",
    role: "user",
    token: "token123",
  };
  const mockSeries = {
    id: "s1",
    title: "Test Series",
    slug: "test-series",
    description: "desc",
    status: "ONGOING",
    chaptersCount: 0,
    imageId: "img1",
  };
  const mockChapter = {
    id: "c1",
    seriesId: "s1",
    chapterNumber: 1,
    title: "Chapter 1",
    status: "PENDING",
    pagesCount: 1,
  };
  const mockPage = {
    id: "p1",
    chapterId: "c1",
    pageNumber: 1,
    imageId: "img1",
    status: "PENDING",
    imagePath: "/path/to/img",
    processingProgress: 0,
  };

  beforeEach(() => {
    localStorage.clear();
    mockSafeFetch.mockReset();
    mockSubscribe.mockClear();
    mockShowToast.mockClear();
    mockSafeFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it("renders reader component basic controls", async () => {
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );
    // Use findByText to wait for asynchronous state updates
    expect(await screen.findByText(/Test Series/)).toBeInTheDocument();
  });

  it("handles sidebar toggles and page navigation clicks", async () => {
    const mockPages = [mockPage, { ...mockPage, id: "p2", pageNumber: 2 }];
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={mockPages}
        theme="dark"
      />,
    );

    // Wait for render
    await screen.findByText(/Test Series/);

    // By default both sidebars are true (visible)
    expect(screen.getByText("NAVIGATION")).toBeInTheDocument();

    // Click left sidebar toggle to hide it
    const leftSidebarToggle = screen.getAllByRole("button", {
      name: /Settings/i,
    })[0]; // Assuming it's the first button with MenuOpenIcon/Settings
    fireEvent.click(leftSidebarToggle);

    expect(screen.queryByText("NAVIGATION")).not.toBeInTheDocument();

    // Click right sidebar toggle
    const rightSidebarToggle = screen.getByTitle(/Right Sidebar/i);
    fireEvent.click(rightSidebarToggle);
  });

  it(
    "handles toolbar buttons and editor actions",
    { timeout: 15000 },
    async () => {
      render(
        <Reader
          user={mockUser}
          selectedSeries={mockSeries}
          selectedChapter={mockChapter}
          chapters={[mockChapter]}
          pages={[mockPage]}
          theme="dark"
        />,
      );

      await screen.findByText(/Test Series/);

      // Click fit mode buttons
      fireEvent.click(screen.getByRole("button", { name: "Page" }));
      fireEvent.click(screen.getByRole("button", { name: "Width" }));
      fireEvent.click(screen.getByRole("button", { name: "Height" }));

      // Click Redo actions
      mockSafeFetch.mockResolvedValueOnce({ ok: true });
      fireEvent.click(screen.getByText("Redo Page OCR"));

      mockSafeFetch.mockResolvedValueOnce({ ok: true });
      fireEvent.click(screen.getByText("Redo Page Translation"));

      // Click layer creation buttons
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ id: "l1", type: "translation", name: "TL Layer" }),
      });
      fireEvent.click(screen.getByTitle("Add Translation Layer"));

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ id: "l2", type: "sfx", name: "SFX Layer" }),
      });
      fireEvent.click(screen.getByTitle("Add SFX Layer"));
    },
  );

  it("reloads layers and shows toast on job_update SSE event", async () => {
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );

    await screen.findByText(/Test Series/);

    const sseCallback = mockSubscribe.mock.calls[0][0];
    expect(sseCallback).toBeDefined();

    // Clear mock history before triggering the SSE
    mockSafeFetch.mockClear();

    // Trigger SSE event
    sseCallback({
      type: "job_update",
      data: JSON.stringify({
        status: "COMPLETED",
        imageId: "img1",
        type: "ocr",
      }),
    });

    expect(mockShowToast).toHaveBeenCalledWith(
      "New layers available — refreshed",
      "success",
    );

    // Wait for the Promise.resolve().then() to execute the state update and trigger the fetch
    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalled();
    });

    // Verify that the fetch was called again for the image and layers, indicating cache was busted
    const fetchUrls = mockSafeFetch.mock.calls.map((call) => call[0]);
    expect(fetchUrls.some((url) => url.includes("/api/images/img1"))).toBe(
      true,
    );
  });
  it("prefetches next two pages and applies synchronous cache hits", async () => {
    const p1 = {
      ...mockPage,
      id: "p1",
      pageNumber: 1,
      imageId: "img1",
      url: "/url1",
    };
    const p2 = {
      ...mockPage,
      id: "p2",
      pageNumber: 2,
      imageId: "img2",
      url: "/url2",
    };
    const p3 = {
      ...mockPage,
      id: "p3",
      pageNumber: 3,
      imageId: "img3",
      url: "/url3",
    };
    const p4 = {
      ...mockPage,
      id: "p4",
      pageNumber: 4,
      imageId: "img4",
      url: "/url4",
    };

    const { rerender } = render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[p1, p2, p3, p4]}
        theme="dark"
      />,
    );

    // Initial load: fetches img1 data, plus prefetches img2 and img3 data
    await waitFor(() => {
      const fetchUrls = mockSafeFetch.mock.calls.map((call) => call[0]);
      expect(fetchUrls.some((url) => url.includes("/api/images/img1"))).toBe(
        true,
      );
      expect(fetchUrls.some((url) => url.includes("/api/images/img2"))).toBe(
        true,
      );
      expect(fetchUrls.some((url) => url.includes("/api/images/img3"))).toBe(
        true,
      );
      // img4 should not be prefetched yet
      expect(fetchUrls.some((url) => url.includes("/api/images/img4"))).toBe(
        false,
      );
    });

    // Clear mock to observe the next transition
    mockSafeFetch.mockClear();

    // Now simulate route change to page 2 (which is already in cache)
    // We mock useParams to return "2" for the next render
    const { useParams } = await import("react-router-dom");
    vi.mocked(useParams).mockReturnValue({
      pageNumber: "2",
      seriesId: "s1",
      chapterId: "c1",
    });

    rerender(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[p1, p2, p3, p4]}
        theme="dark"
      />,
    );

    await waitFor(() => {
      // It should NOT show the spinner because the cache hit is synchronous
      expect(
        screen.queryByText(/Loading page details/),
      ).not.toBeInTheDocument();

      const fetchUrls = mockSafeFetch.mock.calls.map((call) => call[0]);
      // Should not refetch img2 because it's cached
      expect(fetchUrls.some((url) => url.includes("/api/images/img2"))).toBe(
        false,
      );
      // It SHOULD prefetch img4 now since it's the new N+2
      expect(fetchUrls.some((url) => url.includes("/api/images/img4"))).toBe(
        true,
      );
    });
  });
});
