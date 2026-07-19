import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  ReaderPageNavigation,
  ReaderPrevNextChapters,
} from "./ReaderPageNavigation";

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
      />
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
      />
    );
    expect(screen.getByTitle("First Page")).toBeDisabled();
    expect(screen.getByTitle("Previous Page")).toBeDisabled();
    expect(screen.getByTitle("Next Page")).not.toBeDisabled();
    expect(screen.getByTitle("Last Page")).not.toBeDisabled();
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
      />
    );
    expect(screen.getByTitle("First Page")).not.toBeDisabled();
    expect(screen.getByTitle("Previous Page")).not.toBeDisabled();
    expect(screen.getByTitle("Next Page")).toBeDisabled();
    expect(screen.getByTitle("Last Page")).toBeDisabled();
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
      />
    );

    fireEvent.click(screen.getByTitle("First Page"));
    expect(onFirstPage).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("Previous Page"));
    expect(onPrevPage).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("Next Page"));
    expect(onNextPage).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("Last Page"));
    expect(onLastPage).toHaveBeenCalled();
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
      />
    );
    expect(screen.getByText("Prev Ch").closest("button")).toBeDisabled();
    expect(screen.getByText("Next Ch").closest("button")).toBeDisabled();
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
      />
    );

    const prevBtn = screen.getByText("Prev Ch");
    const nextBtn = screen.getByText("Next Ch");

    expect(prevBtn.closest("button")).not.toBeDisabled();
    expect(nextBtn.closest("button")).not.toBeDisabled();

    fireEvent.click(prevBtn);
    expect(onPrev).toHaveBeenCalled();

    fireEvent.click(nextBtn);
    expect(onNext).toHaveBeenCalled();
  });
});
