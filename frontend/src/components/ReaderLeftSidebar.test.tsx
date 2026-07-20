import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import ReaderLeftSidebar from "./ReaderLeftSidebar";
import { Page } from "../types";

vi.mock("./ToastContext", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

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

  it("calls handleDeletePage when delete button is clicked and confirmed", async () => {
    render(<ReaderLeftSidebar {...defaultProps} />);
    const deleteBtn = screen.getByRole("button", { name: /Delete page/i });
    fireEvent.click(deleteBtn);
    
    // The ConfirmModal should open. Click "Confirm".
    const confirmBtn = await screen.findByRole("button", { name: /Confirm/i });
    fireEvent.click(confirmBtn);
    
    expect(mockHandleDeletePage).toHaveBeenCalledWith("page-123");
  });

  it("calls handleChangePageNumber when form is submitted with new page number", () => {
    render(<ReaderLeftSidebar {...defaultProps} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "5" } });
    
    const moveBtn = screen.getByRole("button", { name: /Move/i });
    fireEvent.click(moveBtn);
    
    expect(mockHandleChangePageNumber).toHaveBeenCalledWith("page-123", 5);
  });

  it("handles zoom and fit mode buttons", () => {
    render(<ReaderLeftSidebar {...defaultProps} zoom={1.5} fitMode="width" />);
    fireEvent.click(screen.getByRole("button", { name: /Reset Zoom/i }));
    expect(defaultProps.setZoom).toHaveBeenCalledWith(1.0);
    expect(defaultProps.setFitMode).toHaveBeenCalledWith("page");

    fireEvent.click(screen.getByRole("button", { name: /^Height$/i }));
    expect(defaultProps.setFitMode).toHaveBeenCalledWith("height");
    fireEvent.click(screen.getByRole("button", { name: /^Width$/i }));
    expect(defaultProps.setFitMode).toHaveBeenCalledWith("width");
    fireEvent.click(screen.getByRole("button", { name: /^Page$/i }));
    expect(defaultProps.setFitMode).toHaveBeenCalledWith("page");
  });

  it("interacts with overlays switches", () => {
    render(<ReaderLeftSidebar {...defaultProps} cleanScanlationView={false} />);
    // The switch can be queried by label
    const cleanSwitch = screen.getByLabelText(/Clean Scanlation/i);
    fireEvent.click(cleanSwitch);
    expect(defaultProps.setCleanScanlationView).toHaveBeenCalledWith(true);
    expect(defaultProps.setManuallyShownOcrLayers).toHaveBeenCalled();
  });

  it("handles form submission edge cases", async () => {
    render(<ReaderLeftSidebar {...defaultProps} />);
    const input = screen.getByRole("spinbutton");
    const moveBtn = screen.getByRole("button", { name: /Move/i });
    
    // Test out of bounds
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.click(moveBtn);
    // Should show toast, mocked so we don't need to assert
    
    // Test 0 (Move to End)
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(moveBtn);
    
    const confirmBtn = await screen.findByRole("button", { name: /Confirm/i });
    fireEvent.click(confirmBtn);
    expect(mockHandleChangePageNumber).toHaveBeenCalledWith("page-123", 0);
  });
  
  it("renders chapter and page navigation correctly and handles clicks", () => {
    const navigateChapterMock = vi.fn();
    const navigatePageMock = vi.fn();
    
    render(<ReaderLeftSidebar 
      {...defaultProps} 
      navigateToChapter={navigateChapterMock} 
      navigateToPage={navigatePageMock}
      curPageNum={2}
      totalPages={5}
      prevChapter={{ id: "prev" } as unknown as import("../types").Chapter} 
      nextChapter={{ id: "next" } as unknown as import("../types").Chapter} 
    />);
    
    // Test chapter navigation
    const prevChBtn = screen.getByText(/Prev Ch/i);
    const nextChBtn = screen.getByText(/Next Ch/i);
    
    expect(prevChBtn).toBeInTheDocument();
    expect(nextChBtn).toBeInTheDocument();
    
    fireEvent.click(prevChBtn);
    expect(navigateChapterMock).toHaveBeenCalledWith(expect.objectContaining({ id: "prev" }));
    
    fireEvent.click(nextChBtn);
    expect(navigateChapterMock).toHaveBeenCalledWith(expect.objectContaining({ id: "next" }));
    
    // Test page navigation
    fireEvent.click(screen.getByTestId("first-page-btn"));
    expect(navigatePageMock).toHaveBeenCalledWith(1);
    
    fireEvent.click(screen.getByTestId("prev-page-btn"));
    expect(navigatePageMock).toHaveBeenCalledWith(1); // 2 - 1
    
    fireEvent.click(screen.getByTestId("next-page-btn"));
    expect(navigatePageMock).toHaveBeenCalledWith(3); // 2 + 1
    
    fireEvent.click(screen.getByTestId("last-page-btn"));
    expect(navigatePageMock).toHaveBeenCalledWith(5);
  });
});
