import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Dashboard from "../../components/Dashboard";
import type { Series } from "../../types";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockShowToast = vi.fn();
vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
    showError: vi.fn(),
  }),
}));

const mockSafeFetch = vi.fn();
vi.mock("../../utils", () => ({
  safeFetch: (url: string, ...args: unknown[]) => {
    if (typeof url === "string" && url.includes("/api/settings")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ocrProvider: "local",
            ocrVlmModelList: ["model-ocr-1"],
            tlProvider: "openrouter",
            tlLlmModelList: ["model-tl-1"],
            qaProvider: "openrouter",
            qaLlmModelList: ["model-qa-llm-1"],
            qaVlmModelList: ["model-qa-vlm-1"],
            useFallbackModels: true,
          }),
      });
    }
    return mockSafeFetch(url, ...args);
  },
  toSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "-"),
}));

// The import dialog has its own tests; here it only has to open with the right file and report
// back what it imported.
vi.mock("../../components/ZipImportDialog", () => ({
  default: ({
    open,
    initialFile,
    onImported,
  }: {
    open: boolean;
    initialFile?: File | null;
    onImported: (chapter: unknown, series: unknown, pages: number) => void;
  }) =>
    open ? (
      <div
        role="dialog"
        aria-label="Import chapter"
      >
        {initialFile?.name ?? "no file yet"}
        <button
          onClick={() =>
            onImported(
              { id: "c1" },
              {
                id: "s9",
                title: "Fresh Series",
                kind: "series",
                readingDirection: "rtl",
                originalLanguage: "ja",
              },
              2,
            )
          }
        >
          finish import into new series
        </button>
        <button
          onClick={() =>
            onImported(
              { id: "c9" },
              {
                id: "os1",
                title: "Romance Dawn",
                kind: "oneshot",
                oneshotChapterId: "c9",
                readingDirection: "rtl",
                originalLanguage: "ja",
              },
              3,
            )
          }
        >
          finish import
        </button>
      </div>
    ) : null,
}));

describe("Dashboard Component", () => {
  const mockUser = {
    id: "1",
    username: "testuser",
    email: "test@test.com",
    displayName: "testuser",
    role: "translator",
    token: "token123",
  };

  const initialSeries = [
    {
      id: "s1",
      title: "One Piece",
      coverImageUrl: "http://example.com/op.jpg",
      readingDirection: "rtl",
      originalLanguage: "ja",
      sourceLanguage: "ja",
      targetLanguage: "en",
    },
    {
      id: "s2",
      title: "Naruto",
      coverImageUrl: "",
      readingDirection: "rtl",
      originalLanguage: "ja",
      sourceLanguage: "ja",
      targetLanguage: "en",
    },
  ];

  const mockSetSeriesList = vi.fn();
  const mockOnSelectSeries = vi.fn();
  const mockSetSortBy = vi.fn();
  const mockSetSortDir = vi.fn();
  const mockOnLoadMore = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockReset();
    localStorage.clear();
  });

  const renderDashboard = (seriesList: Series[] = initialSeries) =>
    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={seriesList}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

  const oneshot = {
    id: "os1",
    title: "Romance Dawn",
    coverImageUrl: "",
    readingDirection: "rtl",
    originalLanguage: "ja",
    kind: "oneshot" as const,
    oneshotChapterId: "c9",
  };

  it("New chapter opens the one-shot dialog (#216)", () => {
    renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: /New chapter/ }));
    expect(
      screen.getByRole("heading", { name: "Create One-shot" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/One-shot Title/)).toBeInTheDocument();
  });

  it("Import chapter and a dropped ZIP open the import dialog (#216)", () => {
    renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: /Import chapter/ }));
    expect(
      screen.getByRole("dialog", { name: "Import chapter" }),
    ).toHaveTextContent("no file yet");
    // An imported one-shot joins the library.
    fireEvent.click(screen.getByRole("button", { name: "finish import" }));
    expect(mockSetSeriesList).toHaveBeenCalled();
    const update = mockSetSeriesList.mock.calls.at(-1)![0];
    expect(update(initialSeries)[0]).toMatchObject({ id: "os1" });
    expect(mockShowToast).toHaveBeenCalledWith(
      "Imported Romance Dawn as a one-shot (3 pages)",
      "success",
    );
  });

  it("lists a series made by the import dialog, once", () => {
    renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: /Import chapter/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "finish import into new series" }),
    );
    const update = mockSetSeriesList.mock.calls.at(-1)![0];
    expect(update(initialSeries)[0]).toMatchObject({ id: "s9" });
    const listed = [{ ...initialSeries[0], id: "s9" }];
    expect(update(listed)).toBe(listed);
  });

  it("deletes a one-shot that lost its chapter as a series", () => {
    renderDashboard([{ ...oneshot, oneshotChapterId: null }]);
    fireEvent.click(screen.getByTitle("Delete One-shot"));
    expect(
      screen.getByRole("heading", { name: "Delete Series" }),
    ).toBeInTheDocument();
  });

  it("takes a ZIP dropped on the library into the import dialog", async () => {
    renderDashboard();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: ["Files"], files: [new File(["z"], "chapter.zip")] },
    });
    window.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true); // the browser must not open the file
    expect(
      await screen.findByRole("dialog", { name: "Import chapter" }),
    ).toHaveTextContent("chapter.zip");
  });

  it("opens a one-shot's chapter straight from its card", () => {
    renderDashboard([oneshot, ...initialSeries]);
    expect(screen.getByText("One-shot")).toBeInTheDocument();
    const card = screen.getByText("Romance Dawn").closest(".MuiCard-root");
    fireEvent.click(card!);
    expect(mockOnSelectSeries).toHaveBeenCalledWith(oneshot);
    expect(mockNavigate).toHaveBeenCalledWith("/chapters/c9/romance-dawn");
  });

  it("deletes a one-shot through its chapter", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: true });
    renderDashboard([oneshot, ...initialSeries]);

    fireEvent.click(screen.getByTitle("Delete One-shot"));
    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete One-shot",
    });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    await waitFor(() =>
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/chapters/c9", {
        method: "DELETE",
        headers: { Authorization: `Bearer token123` },
      }),
    );
    expect(mockSafeFetch).not.toHaveBeenCalledWith(
      "/api/series/os1",
      expect.anything(),
    );
  });

  it("renders the dashboard with list of series", () => {
    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Library" }),
    ).toBeInTheDocument();
    expect(screen.getByText("One Piece")).toBeInTheDocument();
    expect(screen.getAllByText("Naruto").length).toBeGreaterThan(0);
  });

  it("navigates to series page when card is clicked", () => {
    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const card = screen.getByText("One Piece").closest(".MuiCard-root");
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    expect(mockOnSelectSeries).toHaveBeenCalledWith(initialSeries[0]);
    expect(mockNavigate).toHaveBeenCalledWith("/series/s1/one-piece");
  });

  it(
    "opens modal on clicking New Series and submits successfully",
    { timeout: 15000 },
    async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "s3",
            title: "Bleach",
            readingDirection: "rtl",
            sourceLanguage: "ja",
            targetLanguage: "en",
          }),
      });

      render(
        <Dashboard
          mode="dark"
          user={mockUser}
          seriesList={initialSeries}
          setSeriesList={mockSetSeriesList}
          sortBy="updatedAt"
          setSortBy={mockSetSortBy}
          sortDir="desc"
          setSortDir={mockSetSortDir}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={mockOnLoadMore}
          onSelectSeries={mockOnSelectSeries}
        />,
      );

      const newBtn = screen.getByRole("button", { name: /new series/i });
      fireEvent.click(newBtn);

      expect(
        screen.getByRole("heading", { name: "Create Series" }),
      ).toBeInTheDocument();

      const titleInput = screen.getByPlaceholderText("e.g. My Hero Academia");
      fireEvent.change(titleInput, { target: { value: "Bleach" } });

      const submitBtn = screen.getByRole("button", { name: /create/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(mockSafeFetch).toHaveBeenCalledWith("/api/series", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer token123`,
          },
          body: JSON.stringify({
            title: "Bleach",
            originalLanguage: "ja",
            sourceLanguage: "ja",
            targetLanguage: "en",
            readingDirection: "rtl",
            ocrProvider: null,
            ocrModel: null,
            tlProvider: null,
            tlModel: null,
            qaProvider: null,
            qaLlmModel: null,
            qaVlmModel: null,
            qaMode: null,
            routingStrategy: null,
            cleanupMode: null,
            ocrMergeThreshold: null,
            ocrTextAngle: null,
            useFallbackModels: null,
          }),
        });
        expect(mockSetSeriesList).toHaveBeenCalled();
      });
    },
  );

  it("opens edit series modal and performs changes", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ ...initialSeries[0], title: "One Piece Updated" }),
    });

    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const editBtn = screen.getAllByTitle("Edit Series")[0];
    fireEvent.click(editBtn);

    expect(
      screen.getByRole("heading", { name: "Edit Series" }),
    ).toBeInTheDocument();

    const titleInput = screen.getByPlaceholderText("e.g. My Hero Academia");
    expect(titleInput).toHaveValue("One Piece");
    fireEvent.change(titleInput, { target: { value: "One Piece Updated" } });

    const saveBtn = screen.getByRole("button", { name: /update/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/s1", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer token123`,
        },
        body: JSON.stringify({
          title: "One Piece Updated",
          originalLanguage: "ja",
          sourceLanguage: "ja",
          targetLanguage: "en",
          readingDirection: "rtl",
          ocrProvider: null,
          ocrModel: null,
          tlProvider: null,
          tlModel: null,
          qaProvider: null,
          qaLlmModel: null,
          qaVlmModel: null,
          qaMode: null,
          routingStrategy: null,
          cleanupMode: null,
          ocrMergeThreshold: null,
          ocrTextAngle: null,
          useFallbackModels: null,
        }),
      });
    });
  });

  it("cancels series modal without saving", { timeout: 15000 }, async () => {
    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const newBtn = screen.getByRole("button", { name: /new series/i });
    fireEvent.click(newBtn);

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    // Cancel fires onClose which calls handleCancelSeriesModal — the click
    // handler is sufficient proof; MUI Dialog keeps content in DOM during
    // exit transition which never completes in jsdom.
    expect(mockSafeFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/series"),
      expect.anything(),
    );
  });

  it("handles error when creating a series", async () => {
    mockSafeFetch.mockRejectedValueOnce(new Error("Network Error"));

    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const newBtn = screen.getByRole("button", { name: /new series/i });
    fireEvent.click(newBtn);

    const titleInput = screen.getByPlaceholderText("e.g. My Hero Academia");
    fireEvent.change(titleInput, { target: { value: "Bleach" } });

    const submitBtn = screen.getByRole("button", { name: /create/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        "Failed to save series",
        "error",
      );
    });
  });

  it("deletes a series successfully", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: true });

    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const deleteBtn = screen.getAllByTitle("Delete Series")[0];
    fireEvent.click(deleteBtn);

    expect(
      screen.getByRole("heading", { name: "Delete Series" }),
    ).toBeInTheDocument();

    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete Series",
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/s1", {
        method: "DELETE",
        headers: { Authorization: `Bearer token123` },
      });
      expect(mockSetSeriesList).toHaveBeenCalled();
    });
  });

  it("shows alert when deleting series fails", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: false });

    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const deleteBtn = screen.getAllByTitle("Delete Series")[0];
    fireEvent.click(deleteBtn);

    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete Series",
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        "Failed to delete series",
        "error",
      );
    });
  });

  it("handles error when deleting a series", async () => {
    mockSafeFetch.mockRejectedValueOnce(new Error("Network Error"));
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const deleteBtn = screen.getAllByTitle("Delete Series")[0];
    fireEvent.click(deleteBtn);

    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete Series",
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error deleting series:",
        expect.any(Error),
      );
    });

    consoleErrorSpy.mockRestore();
  });

  it("shows permission error when deleting series returns 403", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const deleteBtn = screen.getAllByTitle("Delete Series")[0];
    fireEvent.click(deleteBtn);

    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete Series",
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        "You don't have permission to delete this series.",
        "error",
      );
    });
  });

  it("renders series sorted by date", () => {
    const seriesWithDates = [
      {
        id: "s1",
        title: "Old Series",
        coverImageUrl: "",
        readingDirection: "rtl",
        originalLanguage: "ja",
        sourceLanguage: "ja",
        targetLanguage: "en",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-06-01T00:00:00Z",
      },
      {
        id: "s2",
        title: "New Series",
        coverImageUrl: "",
        readingDirection: "rtl",
        originalLanguage: "ja",
        sourceLanguage: "ja",
        targetLanguage: "en",
        createdAt: "2024-02-01T00:00:00Z",
        updatedAt: "2024-07-01T00:00:00Z",
      },
    ];

    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        seriesList={seriesWithDates as any}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    expect(screen.getAllByText("Old Series").length).toBeGreaterThan(0);
    expect(screen.getAllByText("New Series").length).toBeGreaterThan(0);
  });

  it("changes sort order via select", { timeout: 15000 }, async () => {
    localStorage.setItem("dashboard_sort_by", "updatedAt");
    localStorage.setItem("dashboard_sort_dir", "desc");

    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    render(
      <Dashboard
        mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        sortBy="updatedAt"
        setSortBy={mockSetSortBy}
        sortDir="desc"
        setSortDir={mockSetSortDir}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={mockOnLoadMore}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const comboboxes = document.querySelectorAll('[role="combobox"]');
    expect(comboboxes.length).toBeGreaterThanOrEqual(1);

    const sortSelect = comboboxes[0];
    fireEvent.mouseDown(sortSelect);
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("option", { name: /Newest first/ }));

    // AUDIT-T3: this test used to end at the click with no assertion at all — deleting the
    // Select's entire `onChange` would not have failed it. `Dashboard` owns exactly two
    // things here: telling the parent what was picked, and persisting it. What the parent
    // then *fetches* is the wiring, covered in DashboardSortWiring.test.tsx.
    await waitFor(() =>
      expect(mockSetSortBy).toHaveBeenCalledWith("createdAt"),
    );
    expect(mockSetSortDir).toHaveBeenCalledWith("desc");
    expect(localStorage.getItem("dashboard_sort_by")).toBe("createdAt");
    expect(localStorage.getItem("dashboard_sort_dir")).toBe("desc");
  });

  it(
    "creates a new series with language and reading direction changed",
    { timeout: 15000 },
    async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "s4",
            title: "New Manga",
            readingDirection: "ltr",
            sourceLanguage: "ko",
            targetLanguage: "zh-TW",
          }),
      });

      render(
        <Dashboard
          mode="dark"
          user={mockUser}
          seriesList={initialSeries}
          setSeriesList={mockSetSeriesList}
          sortBy="updatedAt"
          setSortBy={mockSetSortBy}
          sortDir="desc"
          setSortDir={mockSetSortDir}
          hasMore={false}
          isLoadingMore={false}
          onLoadMore={mockOnLoadMore}
          onSelectSeries={mockOnSelectSeries}
        />,
      );

      const newBtn = screen.getByRole("button", { name: /new series/i });
      fireEvent.click(newBtn);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("e.g. My Hero Academia"),
        ).toBeInTheDocument();
      });

      fireEvent.change(screen.getByPlaceholderText("e.g. My Hero Academia"), {
        target: { value: "New Manga" },
      });

      // Scoped to the dialog. Querying the whole document put the Dashboard's own sort Select at
      // index 0, so this opened the sort menu and looked for a language in it -- which is why the
      // test was skipped rather than fixed. MUI portals the open menu outside the dialog, so the
      // options themselves are still found on `screen`.
      const dialog = await screen.findByRole("dialog");
      const pick = async (comboIndex: number, optionName: string) => {
        const combos = within(dialog).getAllByRole("combobox");
        fireEvent.mouseDown(combos[comboIndex]);
        await waitFor(() => {
          expect(screen.getByRole("listbox")).toBeInTheDocument();
        });
        fireEvent.click(screen.getByRole("option", { name: optionName }));
        await waitFor(() => {
          expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        });
      };

      await pick(0, "ko");
      await pick(1, "zh-TW");
      // An em dash, not parentheses — the other reason this could not pass as written.
      await pick(2, "Left to Right — Comics");

      const submitBtn = screen.getByRole("button", { name: /create/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(mockSafeFetch).toHaveBeenCalledWith("/api/series", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer token123`,
          },
          body: JSON.stringify({
            title: "New Manga",
            originalLanguage: "ko",
            sourceLanguage: "ko",
            targetLanguage: "zh-TW",
            readingDirection: "ltr",
            ocrProvider: null,
            ocrModel: null,
            tlProvider: null,
            tlModel: null,
            qaProvider: null,
            qaLlmModel: null,
            qaVlmModel: null,
            qaMode: null,
            routingStrategy: null,
            cleanupMode: null,
            ocrMergeThreshold: null,
            ocrTextAngle: null,
            useFallbackModels: null,
          }),
        });
        expect(mockSetSeriesList).toHaveBeenCalled();
      });
    },
  );
});
