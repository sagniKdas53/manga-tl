import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ChapterCardGrid from "../../components/ChapterCardGrid";

describe("ChapterCardGrid", () => {
  const mockSeries = {
    id: "s1",
    title: "Test Series",
    originalLanguage: "ja",
    readingDirection: "rtl",
    coverImageUrl: "http://example.com/series.jpg",
  };

  const mockChapters = [
    {
      id: "c1",
      seriesId: "s1",
      chapterNumber: 1,
      title: "Chapter One",
      coverImageUrl: "http://example.com/c1.jpg",
      pageCount: 20,
      useContextMemory: true,
    },
    {
      id: "c2",
      seriesId: "s1",
      chapterNumber: 2,
      title: "Chapter Two",
      pageCount: 15,
      useContextMemory: false,
    },
  ];

  const mockOnToggleSort = vi.fn();
  const mockOnSelectChapter = vi.fn();
  const mockOnEditChapter = vi.fn();
  const mockOnDeleteChapter = vi.fn();
  const mockOnNavigate = vi.fn();

  it("renders chapter cards and controls", () => {
    render(
      <ChapterCardGrid
        chapters={mockChapters}
        series={mockSeries}
        sortAsc={true}
        onToggleSort={mockOnToggleSort}
        onSelectChapter={mockOnSelectChapter}
        onEditChapter={mockOnEditChapter}
        onDeleteChapter={mockOnDeleteChapter}
        onNavigate={mockOnNavigate}
      />,
    );

    expect(screen.getByText("Chapters (2)")).toBeInTheDocument();
    expect(screen.getByText("Chapter One")).toBeInTheDocument();
    expect(screen.getByText("Chapter Two")).toBeInTheDocument();
  });

  it("handles sorting toggle", () => {
    render(
      <ChapterCardGrid
        chapters={mockChapters}
        series={mockSeries}
        sortAsc={true}
        onToggleSort={mockOnToggleSort}
        onSelectChapter={mockOnSelectChapter}
        onEditChapter={mockOnEditChapter}
        onDeleteChapter={mockOnDeleteChapter}
        onNavigate={mockOnNavigate}
      />,
    );

    const sortBtn = screen.getByRole("button", { name: /Sort:/ });
    fireEvent.click(sortBtn);
    expect(mockOnToggleSort).toHaveBeenCalledTimes(1);
  });

  it("handles card click navigation", () => {
    render(
      <ChapterCardGrid
        chapters={mockChapters}
        series={mockSeries}
        sortAsc={true}
        onToggleSort={mockOnToggleSort}
        onSelectChapter={mockOnSelectChapter}
        onEditChapter={mockOnEditChapter}
        onDeleteChapter={mockOnDeleteChapter}
        onNavigate={mockOnNavigate}
      />,
    );

    const card = screen.getByText("Chapter One").closest(".MuiCard-root");
    fireEvent.click(card!);

    expect(mockOnSelectChapter).toHaveBeenCalledWith(mockChapters[0]);
    expect(mockOnNavigate).toHaveBeenCalledWith("/chapters/c1/chapter-one");
  });

  it("handles edit and delete icon clicks", () => {
    render(
      <ChapterCardGrid
        chapters={mockChapters}
        series={mockSeries}
        sortAsc={true}
        onToggleSort={mockOnToggleSort}
        onSelectChapter={mockOnSelectChapter}
        onEditChapter={mockOnEditChapter}
        onDeleteChapter={mockOnDeleteChapter}
        onNavigate={mockOnNavigate}
      />,
    );

    const editBtns = screen.getAllByTitle("Edit Chapter");
    fireEvent.click(editBtns[0]);
    expect(mockOnEditChapter).toHaveBeenCalledWith(
      mockChapters[0],
      expect.anything(),
    );

    const deleteBtns = screen.getAllByTitle("Delete Chapter");
    fireEvent.click(deleteBtns[0]);
    expect(mockOnDeleteChapter).toHaveBeenCalledWith("c1", expect.anything());
  });
});
