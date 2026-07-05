import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ChapterGallery from "./ChapterGallery";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockSafeFetch = vi.fn();
vi.mock("../utils", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  toSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "-"),
  getContextPath: () => "",
}));

vi.mock("./ToastContext", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

describe("ChapterGallery Component", () => {
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

  const mockChapter = {
    id: "c1",
    seriesId: "s1",
    chapterNumber: 1,
    title: "Romance Dawn",
    status: "PENDING",
    pagesCount: 1,
  };

  const mockPages = [
    {
      id: "p1",
      chapterId: "c1",
      pageNumber: 1,
      imageId: "img1",
      status: "PENDING",
      imagePath: "/path/to/img",
      processingProgress: 0,
      url: "http://example.com/p1.jpg",
    },
  ];

  const mockSetSelectedChapter = vi.fn();
  const mockSetPages = vi.fn();
  const mockOnSelectPage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockReset();
  });

  it("renders chapter details and pages", () => {
    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    expect(screen.getByText("Chapter 1")).toBeInTheDocument();
    expect(screen.getByText("One Piece / Romance Dawn")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("clicks page thumbnail to open in reader", () => {
    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    const thumbnail = screen.getByAltText("Page 1");
    fireEvent.click(thumbnail);

    expect(mockOnSelectPage).toHaveBeenCalledWith(mockPages[0]);
    expect(mockNavigate).toHaveBeenCalledWith(
      "/chapters/c1/romance-dawn/reader/1",
    );
  });

  it("opens edit chapter name modal and saves updates", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ ...mockChapter, title: "Romance Dawn Updated" }),
    });

    render(
      <ChapterGallery
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        setSelectedChapter={mockSetSelectedChapter}
        pages={mockPages}
        setPages={mockSetPages}
        onSelectPage={mockOnSelectPage}
        isLoadingDetails={false}
      />,
    );

    const editBtn = screen.getByTitle("Edit Chapter Name & Number");
    fireEvent.click(editBtn);

    expect(
      screen.getByRole("heading", { name: "Edit Chapter" }),
    ).toBeInTheDocument();

    const titleInput = screen.getByDisplayValue("Romance Dawn");
    fireEvent.change(titleInput, { target: { value: "Romance Dawn Updated" } });

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
        }),
      });
      expect(mockSetSelectedChapter).toHaveBeenCalled();
    });
  });
});
