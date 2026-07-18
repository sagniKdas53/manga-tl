import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import ReaderLeftSidebar from "./ReaderLeftSidebar";
import { Page, Chapter } from "../types";

describe("ReaderLeftSidebar Component", () => {
  const mockHandleDeletePage = vi.fn();
  const mockHandleChangePageNumber = vi.fn();

  const mockPage: Page = {
    id: "page-123",
    chapterId: "chapter-123",
    pageNumber: 1,
    imageId: "image-123",
    url: "http://example.com/image.jpg",
    width: 800,
    height: 1200,
  };

  const defaultProps = {
    showPanels: true,
    setShowPanels: vi.fn(),
    showOcr: true,
    setShowOcr: vi.fn(),
    cleanScanlationView: false,
    setCleanScanlationView: vi.fn(),
    setManuallyShownOcrLayers: vi.fn(),
    groupByConversation: true,
    setGroupByConversation: vi.fn(),
    zoom: 1,
    setZoom: vi.fn(),
    fitMode: "page" as const,
    setFitMode: vi.fn(),
    curPageNum: 1,
    totalPages: 10,
    navigateToPage: vi.fn(),
    prevChapter: null,
    nextChapter: null,
    navigateToChapter: vi.fn(),
    selectedPage: mockPage,
    handleDeletePage: mockHandleDeletePage,
    handleChangePageNumber: mockHandleChangePageNumber,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls handleDeletePage when delete button is clicked and confirmed", () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);
    render(<ReaderLeftSidebar {...defaultProps} />);
    const deleteBtn = screen.getByRole("button", { name: /Delete page/i });
    fireEvent.click(deleteBtn);
    expect(mockHandleDeletePage).toHaveBeenCalledWith("page-123");
    confirmSpy.mockRestore();
  });

  it("calls handleChangePageNumber when form is submitted with new page number", () => {
    render(<ReaderLeftSidebar {...defaultProps} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "5" } });
    
    const moveBtn = screen.getByRole("button", { name: /Move/i });
    fireEvent.click(moveBtn);
    
    expect(mockHandleChangePageNumber).toHaveBeenCalledWith("page-123", 5);
  });
});
