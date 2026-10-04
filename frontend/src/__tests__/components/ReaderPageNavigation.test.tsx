import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  ReaderPageNavigation,
  ReaderPrevNextChapters,
} from "../../components/ReaderPageNavigation";

describe("ReaderPageNavigation", () => {
  it("renders page indicator correctly", () => {
    render(
      <ReaderPageNavigation
        currentPage={2}
        totalPages={10}
        onFirstPage={vi.fn()}
        onPrevPage={vi.fn()}
        onNextPage={vi.fn()}
        onLastPage={vi.fn()}
      />,
    );
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("/ 10")).toBeInTheDocument();
  });

  it("disables prev buttons on first page", () => {
    render(
      <ReaderPageNavigation
        currentPage={1}
        totalPages={10}
        onFirstPage={vi.fn()}
        onPrevPage={vi.fn()}
        onNextPage={vi.fn()}
        onLastPage={vi.fn()}
      />,
    );
    expect(screen.getByTestId("first-page-btn")).toBeDisabled();
    expect(screen.getByTestId("prev-page-btn")).toBeDisabled();
    expect(screen.getByTestId("next-page-btn")).not.toBeDisabled();
    expect(screen.getByTestId("last-page-btn")).not.toBeDisabled();
  });

  it("disables next buttons on last page", () => {
    render(
      <ReaderPageNavigation
        currentPage={10}
        totalPages={10}
        onFirstPage={vi.fn()}
        onPrevPage={vi.fn()}
        onNextPage={vi.fn()}
        onLastPage={vi.fn()}
      />,
    );
    expect(screen.getByTestId("first-page-btn")).not.toBeDisabled();
    expect(screen.getByTestId("prev-page-btn")).not.toBeDisabled();
    expect(screen.getByTestId("next-page-btn")).toBeDisabled();
    expect(screen.getByTestId("last-page-btn")).toBeDisabled();
  });

  it("calls appropriate callbacks when clicked", () => {
    const onFirstPage = vi.fn();
    const onPrevPage = vi.fn();
    const onNextPage = vi.fn();
    const onLastPage = vi.fn();

    render(
      <ReaderPageNavigation
        currentPage={5}
        totalPages={10}
        onFirstPage={onFirstPage}
        onPrevPage={onPrevPage}
        onNextPage={onNextPage}
        onLastPage={onLastPage}
      />,
    );

    fireEvent.click(screen.getByTestId("first-page-btn"));
    expect(onFirstPage).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("prev-page-btn"));
    expect(onPrevPage).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("next-page-btn"));
    expect(onNextPage).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("last-page-btn"));
    expect(onLastPage).toHaveBeenCalled();
  });
});

describe("typing a page number", () => {
  const renderNav = (onJumpToPage = vi.fn()) => {
    render(
      <ReaderPageNavigation
        currentPage={2}
        totalPages={10}
        onFirstPage={vi.fn()}
        onPrevPage={vi.fn()}
        onNextPage={vi.fn()}
        onLastPage={vi.fn()}
        onJumpToPage={onJumpToPage}
      />,
    );
    return onJumpToPage;
  };

  it("goes to the page typed after a double-click", () => {
    const onJump = renderNav();
    fireEvent.doubleClick(screen.getByRole("button", { name: "Page 2 of 10" }));
    const field = screen.getByRole("spinbutton", {
      name: "Go to page, 1 to 10",
    });
    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith(7);
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("keeps the number inside the chapter", () => {
    const onJump = renderNav();
    fireEvent.doubleClick(screen.getByRole("button", { name: "Page 2 of 10" }));
    const field = screen.getByRole("spinbutton");
    fireEvent.change(field, { target: { value: "99" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith(10);
  });

  it("goes nowhere on Escape", () => {
    const onJump = renderNav();
    fireEvent.doubleClick(screen.getByRole("button", { name: "Page 2 of 10" }));
    const field = screen.getByRole("spinbutton");
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onJump).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Page 2 of 10" })).toBeVisible();
  });

  it("opens on a double-tap", () => {
    renderNav();
    const counter = screen.getByRole("button", { name: "Page 2 of 10" });
    fireEvent.pointerUp(counter, { pointerType: "touch", timeStamp: 1000 });
    fireEvent.pointerUp(counter, { pointerType: "touch", timeStamp: 1200 });
    expect(screen.getByRole("spinbutton")).toBeInTheDocument();
  });
});

describe("ReaderPrevNextChapters", () => {
  it("renders disabled buttons when no adjacent chapters exist", () => {
    render(
      <ReaderPrevNextChapters
        hasPrevChapter={false}
        hasNextChapter={false}
        onPrevChapter={vi.fn()}
        onNextChapter={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Previous chapter" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next chapter" })).toBeDisabled();
  });

  it("calls callbacks when active buttons are clicked", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <ReaderPrevNextChapters
        hasPrevChapter={true}
        hasNextChapter={true}
        onPrevChapter={onPrev}
        onNextChapter={onNext}
      />,
    );

    const prevBtn = screen.getByRole("button", { name: "Previous chapter" });
    const nextBtn = screen.getByRole("button", { name: "Next chapter" });

    expect(prevBtn.closest("button")).not.toBeDisabled();
    expect(nextBtn.closest("button")).not.toBeDisabled();

    fireEvent.click(prevBtn);
    expect(onPrev).toHaveBeenCalled();

    fireEvent.click(nextBtn);
    expect(onNext).toHaveBeenCalled();
  });
});
