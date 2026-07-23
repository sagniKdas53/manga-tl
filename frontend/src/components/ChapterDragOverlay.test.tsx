import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ChapterDragOverlay from "./ChapterDragOverlay";

describe("ChapterDragOverlay", () => {
  it("renders nothing when visible is false", () => {
    const { container } = render(
      <ChapterDragOverlay
        visible={false}
        chapterNumber={1}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders overlay when visible is true", () => {
    render(
      <ChapterDragOverlay
        visible={true}
        chapterNumber={5}
      />,
    );
    expect(screen.getByText("Drop Manga Pages Anywhere")).toBeInTheDocument();
    expect(screen.getByText(/Chapter 5/)).toBeInTheDocument();
  });
});
