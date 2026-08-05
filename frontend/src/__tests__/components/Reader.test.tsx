import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Reader from "../../components/Reader";
import { toReaderUrl } from "../../utils/readerImage";

// Mock external modules
export const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useParams: vi.fn(() => ({ pageNumber: "1" })),
}));

export const mockSubscribe = vi.fn(() => vi.fn());
vi.mock("../../components/useNotifications", () => ({
  useNotifications: () => ({ notifications: [], subscribe: mockSubscribe }),
}));

export const mockShowToast = vi.fn();
vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
    showSuccess: vi.fn(),
    showError: vi.fn(),
  }),
}));

const mockSafeFetch = vi.fn<
  (
    url: string,
    init?: RequestInit,
  ) => Promise<{
    ok: boolean;
    json: () => Promise<unknown>;
    blob?: () => Promise<Blob>;
  }>
>(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve([]),
    blob: () => Promise.resolve(new Blob(["img"])),
  }),
);
vi.mock("../../utils", () => ({
  safeFetch: (url: string, init?: RequestInit) => mockSafeFetch(url, init),
  toSlug: (s: string) => s.toLowerCase(),
}));

describe("Reader Component", () => {
  const mockUser = {
    id: "1",
    username: "testuser",
    email: "test@example.com",
    displayName: "Test User",
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
    originalLanguage: "ja",
    readingDirection: "rtl",
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
    filename: "p1.jpg",
    url: "/path/to/img1.jpg",
    status: "PENDING",
    imagePath: "/path/to/img",
    processingProgress: 0,
  };

  beforeEach(async () => {
    localStorage.clear();
    mockSafeFetch.mockReset();
    mockSubscribe.mockClear();
    mockShowToast.mockClear();
    mockSafeFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
      // Only export reads image bytes now; the page itself is a plain <img src>.
      blob: () => Promise.resolve(new Blob(["img"])),
    });
    mockNavigate.mockClear();
    // Tests below override useParams with mockReturnValue, which persists for
    // the rest of the file. Reset it so tests do not depend on their order.
    const { useParams } = await import("react-router-dom");
    vi.mocked(useParams).mockReturnValue({ pageNumber: "1" });
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

  it("loads the page image with an auth header, not a ?token= URL", async () => {
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

    const img = await screen.findByAltText(`Page ${mockPage.pageNumber}`);
    // The reading variant is public and cacheable, so the page is a plain `src` again -- no
    // blob URL, and no fetch for the image at all. `?token=` must still never appear: AUDIT-S4
    // removed that credential path from JwtAuthFilter and it must not creep back.
    await waitFor(() =>
      expect(img.getAttribute("src")).toBe(toReaderUrl(mockPage.url)),
    );

    expect(
      mockSafeFetch.mock.calls.find(([url]) => url === mockPage.url),
    ).toBeUndefined();
    for (const [url] of mockSafeFetch.mock.calls) {
      expect(url).not.toContain("token=");
    }
  });

  it("points the reader at the derived variant, not the original", () => {
    expect(toReaderUrl("/api/images/abc/file")).toBe("/api/images/abc/reader");
    // Only a trailing /file is rewritten, so an unrelated path is passed through untouched.
    expect(toReaderUrl("/path/to/img1.jpg")).toBe("/path/to/img1.jpg");
    expect(toReaderUrl(undefined)).toBeUndefined();
  });

  /**
   * Overlay coordinates are stored in the original image's pixel space, so the SVG viewBox must
   * match it. Deriving that from the rendered <img> is only correct while the displayed bytes are
   * the original — the moment a downscaled reading variant is served, every overlay shifts and
   * anything drawn or dragged is clamped to, and persisted in, the wrong space.
   */
  it("takes overlay geometry from the API, not from the displayed image", async () => {
    mockSafeFetch.mockImplementation((url: string) => {
      if (url === `/api/pages/${mockPage.id}`) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              // The rendered element is 800x1200 in jsdom; the original is not.
              image: { width: 1809, height: 2551 },
              panels: [],
              ocrRegions: [],
              conversations: [],
              layers: [],
            }),
          blob: () => Promise.resolve(new Blob(["img"])),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
        blob: () => Promise.resolve(new Blob(["img"])),
      });
    });

    const { container } = render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );

    await waitFor(() => {
      const svg = container.querySelector("svg.svg-overlay");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 1809 2551");
    });
  });

  it("falls back to the rendered image when the API reports no dimensions", async () => {
    // Rows predating the dimension backfill still have null width/height.
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

    const img = await screen.findByAltText(`Page ${mockPage.pageNumber}`);
    Object.defineProperty(img, "naturalWidth", {
      value: 1234,
      configurable: true,
    });
    Object.defineProperty(img, "naturalHeight", {
      value: 5678,
      configurable: true,
    });
    fireEvent.load(img);

    await waitFor(() => {
      const svg = document.querySelector("svg.svg-overlay");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 1234 5678");
    });
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
    expect(screen.getByText("Overlays")).toBeInTheDocument();

    // Click left sidebar toggle to hide it
    const leftSidebarToggle = screen.getAllByRole("button", {
      name: /Settings/i,
    })[0]; // Assuming it's the first button with MenuOpenIcon/Settings
    fireEvent.click(leftSidebarToggle);

    expect(screen.queryByText("Overlays")).not.toBeInTheDocument();

    // Click right sidebar toggle
    const rightSidebarToggle = screen.getByLabelText(/Inspector/i);
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
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      fireEvent.click(screen.getByText("Redo Page OCR"));

      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
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

    const sseCallback = (
      mockSubscribe.mock.calls as [
        ((event: { type: string; data: string }) => void)?,
      ][]
    )[0]?.[0];
    expect(sseCallback).toBeDefined();

    // Clear mock history before triggering the SSE
    mockSafeFetch.mockClear();

    // Trigger SSE event
    sseCallback?.({
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
    // We check for the specific url inside waitFor to prevent flakiness if other fetches occur
    await waitFor(() => {
      const fetchCalls = mockSafeFetch.mock.calls as unknown as [
        string,
        RequestInit?,
      ][];
      const fetchUrls = fetchCalls.map((call) => call[0] || "");
      expect(
        fetchUrls.some((url) => url.includes("p1") || url.includes("img1")),
      ).toBe(true);
    });
  });

  it("refreshes on job_update even when the first page fetch is still in flight", async () => {
    // Regression: the SSE handler busts pageDetailsCache, but a request started
    // before the bust used to refill the cache and set loadedImageId back to
    // the page id — swallowing the invalidation so no refetch ever happened.
    mockSafeFetch.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, json: () => Promise.resolve([]) }),
            30,
          ),
        ),
    );

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

    const sseCallback = (
      mockSubscribe.mock.calls as [
        ((event: { type: string; data: string }) => void)?,
      ][]
    )[0]?.[0];
    expect(sseCallback).toBeDefined();

    // Fire the job completion while the initial /api/pages/p1 fetch is pending.
    mockSafeFetch.mockClear();
    sseCallback?.({
      type: "job_update",
      data: JSON.stringify({
        status: "COMPLETED",
        imageId: "img1",
        type: "ocr",
      }),
    });

    await waitFor(() => {
      const urls = mockSafeFetch.mock.calls.map((call) => call[0] as string);
      expect(urls).toContain("/api/pages/p1");
    });
  });

  /**
   * The measured reason this gate exists: the old bidirectional window fired on navigation,
   * putting five image requests on the wire within 25 ms and pushing image p95 to 2482 ms
   * against a p50 of 706 ms. Those five were competing with the one the reader was waiting
   * for. The invariant — nothing warms until the displayed image has loaded — is invisible
   * once it holds, so it regresses quietly.
   */
  it("warms no images until the displayed page has loaded", async () => {
    const p1 = { ...mockPage, id: "p1", pageNumber: 1, imageId: "img1" };
    const p2 = { ...mockPage, id: "p2", pageNumber: 2, imageId: "img2" };
    const p3 = { ...mockPage, id: "p3", pageNumber: 3, imageId: "img3" };

    const warmed: { src: string; fetchPriority?: string }[] = [];
    const RealImage = globalThis.Image;
    class RecordingImage {
      fetchPriority?: string;
      set src(value: string) {
        warmed.push({ src: value, fetchPriority: this.fetchPriority });
      }
    }
    vi.stubGlobal("Image", RecordingImage);

    try {
      render(
        <Reader
          user={mockUser}
          selectedSeries={mockSeries}
          selectedChapter={mockChapter}
          chapters={[mockChapter]}
          pages={[p1, p2, p3]}
          theme="dark"
        />,
      );

      const img = await screen.findByAltText(`Page ${p1.pageNumber}`);

      // Nothing may be on the wire yet. Give the effects a chance to run first, otherwise
      // this asserts only that React has not flushed rather than that the gate holds.
      await waitFor(() => {
        expect(img.getAttribute("src")).toBe(toReaderUrl(p1.url));
      });
      expect(warmed).toHaveLength(0);

      fireEvent.load(img);

      // And once it has loaded, the warming does happen — otherwise this test would still
      // pass with prefetching removed entirely.
      await waitFor(() => {
        expect(warmed.length).toBeGreaterThan(0);
      });
      expect(warmed.every((w) => w.fetchPriority === "low")).toBe(true);
    } finally {
      vi.stubGlobal("Image", RealImage);
    }
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

    // Initial load: fetches img1/p1 data, plus prefetches p2/img2 and p3/img3 data
    await waitFor(() => {
      const fetchCalls = mockSafeFetch.mock.calls as unknown as [
        string,
        RequestInit?,
      ][];
      const fetchUrls = fetchCalls.map((call) => call[0] || "");
      expect(
        fetchUrls.some((url) => url.includes("p1") || url.includes("img1")),
      ).toBe(true);
      expect(
        fetchUrls.some((url) => url.includes("p2") || url.includes("img2")),
      ).toBe(true);
      expect(
        fetchUrls.some((url) => url.includes("p3") || url.includes("img3")),
      ).toBe(true);
      // p4/img4 should not be prefetched yet
      expect(
        fetchUrls.some((url) => url.includes("p4") || url.includes("img4")),
      ).toBe(false);
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

    // The cache hit is synchronous, so the spinner must never render — not for one tick.
    // This has to be asserted here rather than inside the waitFor below. waitFor retries
    // until the whole callback passes, so a spinner that flashes and then goes is
    // indistinguishable from one that never rendered: the assertion would simply pass on
    // a later attempt. Checked synchronously after the rerender, it fails if the spinner
    // was ever committed.
    expect(screen.queryByText(/Loading page details/)).not.toBeInTheDocument();

    await waitFor(() => {
      const fetchCalls = mockSafeFetch.mock.calls as unknown as [
        string,
        RequestInit?,
      ][];
      const fetchUrls = fetchCalls.map((call) => call[0] || "");
      // It SHOULD prefetch p4/img4 now since it's the new N+2. This is the positive that
      // gives waitFor something to wait for; the negative below is only meaningful once
      // it holds.
      expect(
        fetchUrls.some((url) => url.includes("p4") || url.includes("img4")),
      ).toBe(true);
      // Should not refetch p2/img2 because it's cached
      expect(
        fetchUrls.some((url) => url.includes("p2") || url.includes("img2")),
      ).toBe(false);
    });
  });

  it("handles page deletion with correct navigation", async () => {
    const { useParams } = await import("react-router-dom");
    vi.mocked(useParams).mockReturnValue({
      pageNumber: "1",
      seriesId: "s1",
      chapterId: "c1",
    });

    const p1 = { ...mockPage, id: "p1", pageNumber: 1, imageId: "img1" };
    const p2 = { ...mockPage, id: "p2", pageNumber: 2, imageId: "img2" };
    const p3 = { ...mockPage, id: "p3", pageNumber: 3, imageId: "img3" };

    // selectedPage uses curPageNum parsed from useParams which is "1" (p1)
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[p1, p2, p3]}
        theme="dark"
      />,
    );

    await screen.findByText(/Test Series/);

    // Open left sidebar if it's hidden or just click Delete Page
    const deleteBtn = screen.getByRole("button", { name: /Delete Page/i });
    fireEvent.click(deleteBtn);

    // The Confirm modal appears
    await screen.findByText(/Are you sure you want to delete this page/i);

    // Click Confirm
    const confirmBtn = screen.getByRole("button", { name: /Confirm/i });

    // Mock the delete fetch response
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      // 1. Check if safeFetch was called with DELETE for the right page
      expect(mockSafeFetch).toHaveBeenCalledWith(
        `/api/pages/p1`,
        expect.objectContaining({ method: "DELETE" }),
      );

      // 2. Check if navigate was called to the new correct page number (1 in this case, since next is p2 originally at 2)
      // Because we delete p1 (index 0). remainingPages = [p2, p3]. nextTargetIndex = 0. newPageNumber = 1.
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringContaining("/reader/1"),
        expect.objectContaining({ replace: true }),
      );
    });
  });

  it("prefetches next pages by page id, never by image id", async () => {
    const mockPages = [
      mockPage,
      { ...mockPage, id: "p2", pageNumber: 2, imageId: "img2" },
      { ...mockPage, id: "p3", pageNumber: 3, imageId: "img3" },
    ];
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

    await screen.findByText(/Test Series/);

    await waitFor(() => {
      const urls = mockSafeFetch.mock.calls.map((c) => c[0] as string);
      // Prefetch of N+1 and N+2 must hit the pages endpoints with PAGE ids
      expect(urls).toContain("/api/pages/p2");
      expect(urls).toContain("/api/pages/p3");
      // Image ids must never appear in /api/pages/* URLs
      expect(
        urls.some(
          (u) => u.includes("/api/pages/img2") || u.includes("/api/pages/img3"),
        ),
      ).toBe(false);
    });
  });

  it("prefetches the two previous and two following pages", async () => {
    const { useParams } = await import("react-router-dom");
    vi.mocked(useParams).mockReturnValue({
      pageNumber: "3",
      seriesId: "s1",
      chapterId: "c1",
    });
    const pages = [1, 2, 3, 4, 5].map((pageNumber) => ({
      ...mockPage,
      id: `p${pageNumber}`,
      imageId: `img${pageNumber}`,
      pageNumber,
      url: `/url${pageNumber}`,
    }));

    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={pages}
        theme="dark"
      />,
    );

    await waitFor(() => {
      const urls = mockSafeFetch.mock.calls.map((call) => call[0] as string);
      expect(urls).toContain("/api/pages/p1");
      expect(urls).toContain("/api/pages/p2");
      expect(urls).toContain("/api/pages/p4");
      expect(urls).toContain("/api/pages/p5");
    });
  });
});
