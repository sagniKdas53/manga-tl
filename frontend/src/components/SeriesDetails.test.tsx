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
  safeFetch: (...args: any[]) => mockSafeFetch(...args),
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

    const chapterCard = screen.getByText("Romance Dawn").closest(".chapter-card-nhentai");
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

    expect(screen.getByRole("heading", { name: "Add Chapter" })).toBeInTheDocument();

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
        }),
      });
      expect(mockSetChapters).toHaveBeenCalled();
    });
  });

  it("opens edit series modal and submits updates", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...mockSeries, title: "One Piece Changed" }),
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

    expect(screen.getByRole("heading", { name: "Edit Series" })).toBeInTheDocument();

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
        }),
      });
      expect(mockSetSelectedSeries).toHaveBeenCalled();
    });
  });
});
