import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ChapterHeader, { type ChapterHeaderProps } from "../../components/ChapterHeader";

const defaultProps: ChapterHeaderProps = {
  selectedSeries: {
    id: "s1",
    title: "One Piece",
    originalLanguage: "ja",
    readingDirection: "rtl",
  },
  selectedChapter: {
    id: "c1",
    seriesId: "s1",
    chapterNumber: 1,
    title: "Romance Dawn",
    pageCount: 42,
    useFallbackModels: true,
    useContextMemory: true,
  },
  onBack: vi.fn(),
  onEditClick: vi.fn(),
  onImportClick: vi.fn(),
  onExportClick: vi.fn(),
  onReexportClick: vi.fn(),
  onClearExportsClick: vi.fn(),
  onUploadClick: vi.fn(),
  onDeleteClick: vi.fn(),
  isImporting: false,
  mode: "dark",
};

describe("ChapterHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders chapter title and series info", () => {
    render(<ChapterHeader {...defaultProps} />);
    expect(screen.getByRole("heading", { name: "Chapter 1" })).toBeDefined();
    expect(screen.getByText(/One Piece/)).toBeDefined();
  });

  it("renders page count", () => {
    render(<ChapterHeader {...defaultProps} />);
    const pageChips = screen.getAllByText("42");
    expect(pageChips.length).toBeGreaterThan(0);
  });

  it("renders page count of 0 when undefined", () => {
    render(
      <ChapterHeader
        {...defaultProps}
        selectedChapter={{
          ...defaultProps.selectedChapter,
          pageCount: undefined,
        }}
      />,
    );
    expect(screen.getByText("0")).toBeDefined();
  });

  it("renders context injection Enabled chip", () => {
    render(<ChapterHeader {...defaultProps} />);
    const enabledChips = screen.getAllByText("Enabled");
    expect(enabledChips.length).toBeGreaterThanOrEqual(2);
  });

  it("renders context injection Disabled when useContextMemory is false", () => {
    render(
      <ChapterHeader
        {...defaultProps}
        selectedChapter={{
          ...defaultProps.selectedChapter,
          useContextMemory: false,
        }}
      />,
    );
    expect(screen.getByText("Disabled")).toBeDefined();
  });

  it("renders fallback models Disabled when false", () => {
    render(
      <ChapterHeader
        {...defaultProps}
        selectedChapter={{
          ...defaultProps.selectedChapter,
          useFallbackModels: false,
        }}
      />,
    );
    const disabledChips = screen.getAllByText("Disabled");
    expect(disabledChips.length).toBeGreaterThanOrEqual(1);
  });

  it("calls onBack when back button clicked", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByText("← Back to Series"));
    expect(defaultProps.onBack).toHaveBeenCalledTimes(1);
  });

  it("calls onEditClick when edit button clicked", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByTitle("Edit Chapter Name & Number"));
    expect(defaultProps.onEditClick).toHaveBeenCalledTimes(1);
  });

  it("calls onUploadClick when Upload Page clicked", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByText("Upload Page"));
    expect(defaultProps.onUploadClick).toHaveBeenCalledTimes(1);
  });

  it("calls onImportClick when Import Project clicked", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByText("Import Project (ZIP)"));
    expect(defaultProps.onImportClick).toHaveBeenCalledTimes(1);
  });

  it("disables import and shows Importing... when isImporting", () => {
    render(
      <ChapterHeader
        {...defaultProps}
        isImporting={true}
      />,
    );
    expect(screen.getByText("Importing...")).toBeDefined();
  });

  it("calls onExportClick when Export Chapter clicked", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByText("Export Chapter (ZIP)"));
    expect(defaultProps.onExportClick).toHaveBeenCalledTimes(1);
  });

  it("calls onDeleteClick when Delete Chapter clicked", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByText("Delete Chapter"));
    expect(defaultProps.onDeleteClick).toHaveBeenCalledTimes(1);
  });

  it("opens overflow menu and triggers Clear Exports", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("more actions"));
    fireEvent.click(screen.getByText("Clear Exports"));
    expect(defaultProps.onClearExportsClick).toHaveBeenCalledTimes(1);
  });

  it("opens overflow menu and triggers Force Re-export", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("more actions"));
    fireEvent.click(screen.getByText("Force Re-export"));
    expect(defaultProps.onReexportClick).toHaveBeenCalledTimes(1);
  });

  it("closes overflow menu via Escape", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("more actions"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  });



  it("renders cover image when coverImageUrl present", () => {
    render(
      <ChapterHeader
        {...defaultProps}
        selectedChapter={{
          ...defaultProps.selectedChapter,
          coverImageUrl: "http://example.com/cover.webp",
        }}
      />,
    );
    expect(screen.getByAltText("Romance Dawn")).toBeDefined();
  });

  it("renders resolved OCR chips", () => {
    render(
      <ChapterHeader
        {...defaultProps}
        selectedChapter={{
          ...defaultProps.selectedChapter,
          resolvedOcr: {
            provider: "openrouter",
            model: "ocr-model",
            source: "chapter" as const,
          },
        }}
      />,
    );
    expect(screen.getByText(/OCR Provider: openrouter/)).toBeDefined();
    expect(screen.getByText(/OCR: ocr-model/)).toBeDefined();
  });

  it("renders resolved translation chips", () => {
    render(
      <ChapterHeader
        {...defaultProps}
        selectedChapter={{
          ...defaultProps.selectedChapter,
          resolvedTranslation: {
            provider: "gemini",
            model: "gemini-flash",
            source: "series" as const,
          },
        }}
      />,
    );
    expect(screen.getByText(/TL Provider: gemini/)).toBeDefined();
    expect(screen.getByText(/Translation: gemini-flash/)).toBeDefined();
  });

  it("renders resolved QA chips", () => {
    render(
      <ChapterHeader
        {...defaultProps}
        selectedChapter={{
          ...defaultProps.selectedChapter,
          resolvedQa: {
            provider: "openai",
            llmModel: "gpt-4",
            vlmModel: "gpt-4v",
            mode: "hybrid",
            source: "chapter" as const,
          },
        }}
      />,
    );
    expect(screen.getByText(/QA Mode: hybrid/)).toBeDefined();
    expect(screen.getByText(/QA LLM: gpt-4/)).toBeDefined();
    expect(screen.getByText(/QA VLM: gpt-4v/)).toBeDefined();
  });

  it("closes menus via Escape key", () => {
    render(<ChapterHeader {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("more actions"));
    fireEvent.keyDown(document.body, { key: "Escape" });
  });
});
