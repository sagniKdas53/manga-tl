import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ChapterPageGrid from "../../components/ChapterPageGrid";

describe("ChapterPageGrid", () => {
  const mockPages = [
    {
      id: "p1",
      pageNumber: 1,
      imageId: "img1",
      filename: "p1.jpg",
      url: "http://example.com/p1.jpg",
      thumbnailUrl: "http://example.com/thumb1.jpg",
    },
    {
      id: "p2",
      pageNumber: 2,
      imageId: "img2",
      filename: "p2.jpg",
      url: "http://example.com/p2.jpg",
    },
  ];

  const mockOnDeletePage = vi.fn();
  const mockOnMovePage = vi.fn();
  const mockOnSelectPage = vi.fn();

  it("renders pages and page counts", () => {
    render(
      <ChapterPageGrid
        pages={mockPages}
        token="tok123"
        onDeletePage={mockOnDeletePage}
        onMovePage={mockOnMovePage}
        onSelectPage={mockOnSelectPage}
      />,
    );

    expect(screen.getByText("Pages (2)")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByText("Page 2")).toBeInTheDocument();
  });

  it("triggers page selection on thumbnail container click", () => {
    render(
      <ChapterPageGrid
        pages={mockPages}
        token="tok123"
        onDeletePage={mockOnDeletePage}
        onMovePage={mockOnMovePage}
        onSelectPage={mockOnSelectPage}
      />,
    );

    const pageTag = screen.getByText("Page 1");
    fireEvent.click(pageTag.closest(".page-thumbnail-container")!);

    expect(mockOnSelectPage).toHaveBeenCalledWith(mockPages[0], 0);
  });

  it("triggers delete and reorder buttons", () => {
    render(
      <ChapterPageGrid
        pages={mockPages}
        token="tok123"
        onDeletePage={mockOnDeletePage}
        onMovePage={mockOnMovePage}
        onSelectPage={mockOnSelectPage}
      />,
    );

    const deleteBtns = screen.getAllByTitle("Delete page");
    fireEvent.click(deleteBtns[0]);
    expect(mockOnDeletePage).toHaveBeenCalledWith("p1");

    const moveRightBtns = screen.getAllByTitle("Move page right");
    fireEvent.click(moveRightBtns[0]);
    expect(mockOnMovePage).toHaveBeenCalledWith(0, "right");
  });
});
