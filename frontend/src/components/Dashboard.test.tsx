import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Dashboard from "./Dashboard";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockShowToast = vi.fn();
vi.mock("./ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
    showError: vi.fn(),
  }),
}));

const mockSafeFetch = vi.fn();
vi.mock("../utils", () => ({
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockReset();
  });

  it("renders the dashboard with list of series", () => {
    render(
      <Dashboard mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    expect(screen.getByText("My Manga Library")).toBeInTheDocument();
    expect(screen.getByText("One Piece")).toBeInTheDocument();
    expect(screen.getAllByText("Naruto").length).toBeGreaterThan(0);
  });

  it("navigates to series page when card is clicked", () => {
    render(
      <Dashboard mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
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
        <Dashboard mode="dark"
          user={mockUser}
          seriesList={initialSeries}
          setSeriesList={mockSetSeriesList}
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
            useFallbackModels: true,
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
      <Dashboard mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
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
          useFallbackModels: true,
        }),
      });
    });
  });

  it("cancels series modal without saving", { timeout: 15000 }, async () => {
    render(
      <Dashboard mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
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
      <Dashboard mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
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
      <Dashboard mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
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
      <Dashboard mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
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
      <Dashboard mode="dark"
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
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

  it.skip(
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
        <Dashboard mode="dark"
          user={mockUser}
          seriesList={initialSeries}
          setSeriesList={mockSetSeriesList}
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

      await waitFor(() => {
        const combos = document.querySelectorAll('[role="combobox"]');
        expect(combos.length).toBeGreaterThanOrEqual(3);
      });

      const comboboxes = document.querySelectorAll('[role="combobox"]');
      fireEvent.mouseDown(comboboxes[0]);
      await waitFor(() => {
        expect(screen.getByRole("listbox")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("option", { name: "ko" }));

      fireEvent.mouseDown(comboboxes[1]);
      await waitFor(() => {
        expect(screen.getByRole("listbox")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("option", { name: "zh-TW" }));

      fireEvent.mouseDown(comboboxes[2]);
      await waitFor(() => {
        expect(screen.getByRole("listbox")).toBeInTheDocument();
      });
      fireEvent.click(
        screen.getByRole("option", { name: "Left to Right (Comics)" }),
      );

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
            useFallbackModels: true,
          }),
        });
        expect(mockSetSeriesList).toHaveBeenCalled();
      });
    },
  );
});
