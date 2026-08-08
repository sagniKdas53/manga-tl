import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import SeriesDetails from "../../components/SeriesDetails";
import { safeFetch } from "../../utils";
import type { Chapter } from "../../types";

/**
 * The seam between `SeriesDetails` and the real `CreateChapterDialog`, wired as `App.tsx`
 * wires them — the same shape as `DashboardSortWiring.test.tsx`.
 *
 * Both bugs this covers are invisible from either component alone: the dialog derives its
 * default number from whatever list it is handed, and `SeriesDetails` appends whatever the
 * dialog returns. Each is locally reasonable; the defect only exists at the join, against a
 * list that is a *paginated prefix* rather than the whole chapter set.
 */

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: vi.fn(),
    showError: vi.fn(),
  }),
}));

vi.mock("../../utils", async () => {
  const actual =
    await vi.importActual<typeof import("../../utils")>("../../utils");
  return {
    ...actual,
    safeFetch: vi.fn(),
  };
});

describe("chapter creation wiring (SeriesDetails + CreateChapterDialog)", () => {
  const mockUser = {
    id: "1",
    username: "test",
    email: "t@t.com",
    displayName: "test",
    role: "translator",
    token: "tok123",
  };

  const mockSeries = {
    id: "s1",
    title: "Bleach",
    originalLanguage: "ja",
    readingDirection: "rtl",
  };

  const chapter = (n: number): Chapter =>
    ({
      id: `c${n}`,
      seriesId: "s1",
      chapterNumber: n,
      title: `Chapter ${n}`,
    }) as Chapter;

  /**
   * The series has 18 chapters but only the first page of 15 is loaded — the exact shape
   * reproduced against the live stack.
   */
  const LOADED_ASC = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(
    chapter,
  );
  const HIGHEST_ON_SERVER = 17;

  const renderSeries = (
    sortAsc: boolean,
    chapters: Chapter[],
    setChapters: Mock,
  ) =>
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={vi.fn()}
        chapters={chapters}
        setChapters={setChapters}
        onSelectChapter={vi.fn()}
        isLoadingDetails={false}
        sortAsc={sortAsc}
        setSortAsc={vi.fn()}
        hasMoreChapters={true}
        isLoadingMoreChapters={false}
        onLoadMoreChapters={vi.fn()}
      />,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    (safeFetch as Mock).mockImplementation((url: string) => {
      // The dialog asks the server for the highest chapter number rather than trusting
      // the loaded prefix.
      if (url.includes("/chapters") && url.includes("sortDir=desc")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            content: [chapter(HIGHEST_ON_SERVER)],
            totalElements: 18,
            totalPages: 18,
          }),
        });
      }
      if (url === "/api/settings") {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  it("defaults the new chapter number past the highest on the server, not the loaded prefix", async () => {
    renderSeries(true, LOADED_ASC, vi.fn());

    fireEvent.click(screen.getByText("Add Chapter"));
    await waitFor(() =>
      expect(screen.getByText("Create Chapter")).toBeInTheDocument(),
    );

    // The loaded prefix tops out at 14, so a max over it suggests 15 — which already
    // exists on the server, along with 16 and 17.
    await waitFor(() => {
      expect(screen.getByRole("spinbutton")).toHaveValue(HIGHEST_ON_SERVER + 1);
    });
  });

  it("puts a newly created chapter at the top of a descending list", async () => {
    const setChapters = vi.fn();
    // Sorted newest-first, which is what the server returns for sortDir=desc.
    const loadedDesc = [17, 16, 15].map(chapter);
    renderSeries(false, loadedDesc, setChapters);

    const created = chapter(18);
    (safeFetch as Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url.includes("sortDir=desc")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ content: [chapter(HIGHEST_ON_SERVER)] }),
          });
        }
        if (init?.method === "POST") {
          return Promise.resolve({ ok: true, json: async () => created });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      },
    );

    fireEvent.click(screen.getByText("Add Chapter"));
    await waitFor(() =>
      expect(screen.getByText("Create Chapter")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Create Chapter"));

    await waitFor(() => expect(setChapters).toHaveBeenCalled());

    const updater = setChapters.mock.calls.at(-1)![0] as (
      prev: Chapter[],
    ) => Chapter[];
    const next = updater(loadedDesc);

    expect(next.map((c) => c.chapterNumber)).toEqual([18, 17, 16, 15]);
  });

  it("keeps a newly created chapter in place in an ascending list", async () => {
    const setChapters = vi.fn();
    const loadedAsc = [1, 2, 3].map(chapter);
    renderSeries(true, loadedAsc, setChapters);

    const created = chapter(4);
    (safeFetch as Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url.includes("sortDir=desc")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ content: [chapter(3)] }),
          });
        }
        if (init?.method === "POST") {
          return Promise.resolve({ ok: true, json: async () => created });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      },
    );

    fireEvent.click(screen.getByText("Add Chapter"));
    await waitFor(() =>
      expect(screen.getByText("Create Chapter")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Create Chapter"));

    await waitFor(() => expect(setChapters).toHaveBeenCalled());

    const updater = setChapters.mock.calls.at(-1)![0] as (
      prev: Chapter[],
    ) => Chapter[];
    expect(updater(loadedAsc).map((c) => c.chapterNumber)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});
