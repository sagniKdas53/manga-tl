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
        onDeletePage={mockOnDeletePage}
        onMovePage={mockOnMovePage}
        onSelectPage={mockOnSelectPage}
      />,
    );

    expect(screen.getByText("Pages (2)")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByText("Page 2")).toBeInTheDocument();

    // A missing thumbnail must not fall back to the full-resolution page URL.
    expect(screen.getByAltText("Page 2")).not.toHaveAttribute("src");
  });

  it("triggers page selection on thumbnail container click", () => {
    render(
      <ChapterPageGrid
        pages={mockPages}
        onDeletePage={mockOnDeletePage}
        onMovePage={mockOnMovePage}
        onSelectPage={mockOnSelectPage}
      />,
    );

    // The tile is a MUI Card since the migration off the hand-rolled .pages-grid CSS.
    const pageTag = screen.getByText("Page 1");
    fireEvent.click(pageTag.closest(".MuiCard-root")!);

    expect(mockOnSelectPage).toHaveBeenCalledWith(mockPages[0], 0);
  });

  it("stops the reorder controls from swallowing the click that opens a page", () => {
    render(
      <ChapterPageGrid
        pages={mockPages}
        onDeletePage={mockOnDeletePage}
        onMovePage={mockOnMovePage}
        onSelectPage={mockOnSelectPage}
      />,
    );

    // The reorder band spans the full width across the middle of the tile. The old CSS gave it
    // pointer-events: none with auto on the buttons; losing that in the migration would have
    // made the middle third of every thumbnail unclickable.
    const band = screen
      .getAllByTitle("Move page left")[0]
      .closest("div") as HTMLElement;
    expect(band).toHaveStyle({ pointerEvents: "none" });
  });

  it("triggers delete and reorder buttons", () => {
    render(
      <ChapterPageGrid
        pages={mockPages}
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

  it("shows the current sort direction and toggles it", () => {
    const onToggleSort = vi.fn();
    const { rerender } = render(
      <ChapterPageGrid
        pages={mockPages}
        onDeletePage={mockOnDeletePage}
        onMovePage={mockOnMovePage}
        onSelectPage={mockOnSelectPage}
        totalCount={2}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={vi.fn()}
        sortAsc={true}
        onToggleSort={onToggleSort}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Sort: Ascending/ }));
    expect(onToggleSort).toHaveBeenCalled();

    rerender(
      <ChapterPageGrid
        pages={mockPages}
        onDeletePage={mockOnDeletePage}
        onMovePage={mockOnMovePage}
        onSelectPage={mockOnSelectPage}
        totalCount={2}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={vi.fn()}
        sortAsc={false}
        onToggleSort={onToggleSort}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Sort: Descending/ }),
    ).toBeInTheDocument();
  });
});
