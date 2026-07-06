import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import SeriesDetails from "./SeriesDetails";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
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
          }),
      });
    }
    return mockSafeFetch(url, ...args);
  },
  toSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "-"),
}));

describe("SeriesDetails Component", () => {
  const mockUser = {
    id: "1",
    username: "testuser",
    email: "test@test.com",
    role: "translator",
    token: "token123",
  };

  const mockSeries = {
    id: "s1",
    title: "One Piece",
    coverImageUrl: "http://example.com/op.jpg",
    readingDirection: "rtl",
    sourceLanguage: "ja",
    targetLanguage: "en",
    chaptersCount: 1,
    imageId: "img1",
    slug: "one-piece",
  };

  const mockChapters = [
    {
      id: "c1",
      seriesId: "s1",
      chapterNumber: 1,
      title: "Romance Dawn",
      status: "PENDING",
      pagesCount: 10,
    },
  ];

  const mockSetSelectedSeries = vi.fn();
  const mockSetChapters = vi.fn();
  const mockOnSelectChapter = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockReset();
    localStorage.clear();
  });

  it("renders series details page with list of chapters", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    expect(screen.getByText("One Piece")).toBeInTheDocument();
    expect(screen.getByText("Romance Dawn")).toBeInTheDocument();
    expect(screen.getByText("Chapter 1")).toBeInTheDocument();
  });

  it("clicks chapter card to navigate to chapter details page", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    const chapterCard = screen
      .getByText("Romance Dawn")
      .closest(".chapter-card-nhentai");
    expect(chapterCard).not.toBeNull();
    fireEvent.click(chapterCard!);

    expect(mockOnSelectChapter).toHaveBeenCalledWith(mockChapters[0]);
    expect(mockNavigate).toHaveBeenCalledWith("/chapters/c1/romance-dawn");
  });

  it("opens add chapter modal and submits successfully", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "c2",
          seriesId: "s1",
          chapterNumber: 2,
          title: "The Man Luffy",
        }),
    });

    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    const addBtn = screen.getByRole("button", { name: /add chapter/i });
    fireEvent.click(addBtn);

    expect(
      screen.getByRole("heading", { name: "Add Chapter" }),
    ).toBeInTheDocument();

    const titleInput = screen.getByPlaceholderText("e.g. The Beginning");
    fireEvent.change(titleInput, { target: { value: "The Man Luffy" } });

    const submitBtn = screen.getByRole("button", { name: "Add" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/s1/chapters", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer token123`,
        },
        body: JSON.stringify({
          chapterNumber: 2,
          title: "The Man Luffy",
          ocrProvider: null,
          ocrModel: null,
          tlProvider: null,
          tlModel: null,
          qaProvider: null,
          qaLlmModel: null,
          qaVlmModel: null,
          qaMode: null,
        }),
      });
      expect(mockSetChapters).toHaveBeenCalled();
    });
  });

  it("opens edit series modal and submits updates", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ ...mockSeries, title: "One Piece Changed" }),
    });

    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    const editBtn = screen.getByRole("button", { name: /edit series/i });
    fireEvent.click(editBtn);

    expect(
      screen.getByRole("heading", { name: "Edit Series" }),
    ).toBeInTheDocument();

    const titleInput = screen.getByDisplayValue("One Piece");
    fireEvent.change(titleInput, { target: { value: "One Piece Changed" } });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/s1", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer token123`,
        },
        body: JSON.stringify({
          title: "One Piece Changed",
          originalLanguage: "ja",
          sourceLanguage: "ja",
          targetLanguage: "en",
          readingDirection: "rtl",
          coverImageUrl: "http://example.com/op.jpg",
          ocrProvider: null,
          ocrModel: null,
          tlProvider: null,
          tlModel: null,
          qaProvider: null,
          qaLlmModel: null,
          qaVlmModel: null,
          qaMode: null,
        }),
      });
      expect(mockSetSelectedSeries).toHaveBeenCalled();
    });
  });

  it("handles deleting a series", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: true });

    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    const deleteBtn = screen.getByRole("button", { name: /delete series/i });
    fireEvent.click(deleteBtn);

    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete Series",
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1]; // The modal button
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/s1", {
        method: "DELETE",
        headers: { Authorization: `Bearer token123` },
      });
      expect(mockNavigate).toHaveBeenCalledWith("/");
      expect(mockSetSelectedSeries).toHaveBeenCalledWith(null);
    });
  });

  it("handles deleting a chapter", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: true });

    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    const deleteBtn = screen.getAllByTitle("Delete Chapter")[0];
    fireEvent.click(deleteBtn);

    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete Chapter",
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1]; // The last one is the one in the modal
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/chapters/c1", {
        method: "DELETE",
        headers: { Authorization: `Bearer token123` },
      });
      expect(mockSetChapters).toHaveBeenCalled();
    });
  });

  it("handles editing a chapter", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "c1",
          seriesId: "s1",
          chapterNumber: 1,
          title: "Romance Dawn Updated",
        }),
    });

    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    const editBtn = screen.getAllByTitle("Edit Chapter")[0];
    fireEvent.click(editBtn);

    expect(
      screen.getByRole("heading", { name: "Edit Chapter" }),
    ).toBeInTheDocument();

    const titleInput = screen.getByDisplayValue("Romance Dawn");
    fireEvent.change(titleInput, { target: { value: "Romance Dawn Updated" } });

    // Ensure we get the correct 'Save' button in case there are multiple
    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/chapters/c1", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer token123`,
        },
        body: JSON.stringify({
          chapterNumber: 1,
          title: "Romance Dawn Updated",
          ocrProvider: null,
          ocrModel: null,
          tlProvider: null,
          tlModel: null,
          qaProvider: null,
          qaLlmModel: null,
          qaVlmModel: null,
          qaMode: null,
        }),
      });
      expect(mockSetChapters).toHaveBeenCalled();
    });
  });

  it("handles importing a chapter", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "c3",
          seriesId: "s1",
          chapterNumber: 3,
          title: "Imported Chapter",
        }),
    });

    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    const importBtn = screen.getByRole("button", {
      name: /import chapter \(zip\/epub\)/i,
    });
    fireEvent.click(importBtn);

    expect(
      screen.getByRole("heading", { name: "Import Chapter (ZIP/ePub)" }),
    ).toBeInTheDocument();

    // Use document.querySelector or something if getByLabelText fails, actually there's no id so we can use placeholder or type="file"
    // Since there's only one file input, let's find it by type
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["dummy content"], "chapter.zip", {
      type: "application/zip",
    });

    fireEvent.change(fileInput, { target: { files: [file] } });

    // The other labels also lack 'htmlFor'
    const inputs = screen.getAllByRole("textbox");
    const titleInput = inputs.find((i) =>
      (i as HTMLInputElement).placeholder.includes("Imported Volume"),
    ) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Imported Chapter" } });

    const submitBtn = screen.getByRole("button", { name: "Import" });
    const form = submitBtn.closest("form") as HTMLFormElement;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/series/s1/chapters/import",
        expect.objectContaining({
          method: "POST",
        }),
      );
      expect(mockSetChapters).toHaveBeenCalled();
    });
  });

  it("cancels series editing", () => {
    render(
      <SeriesDetails
        user={mockUser}
        selectedSeries={mockSeries}
        setSelectedSeries={mockSetSelectedSeries}
        chapters={mockChapters}
        setChapters={mockSetChapters}
        onSelectChapter={mockOnSelectChapter}
        isLoadingDetails={false}
      />,
    );

    const editBtn = screen.getByRole("button", { name: /edit series/i });
    fireEvent.click(editBtn);

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);

    expect(
      screen.queryByRole("heading", { name: "Edit Series" }),
    ).not.toBeInTheDocument();
  });
});
