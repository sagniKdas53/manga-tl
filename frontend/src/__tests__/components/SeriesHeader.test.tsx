import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import SeriesHeader from "../../components/SeriesHeader";

vi.mock("../../utils", () => ({
  safeFetch: () =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          ocrProvider: "local",
          ocrModel: "paddleocr",
          tlProvider: "openrouter",
          tlModel: "gemini",
        }),
    }),
  resolveOverride: (_val1: unknown, val2: unknown, val3: unknown) => {
    if (val2) return { value: String(val2), source: "series" };
    if (val3) return { value: String(val3), source: "global" };
    return { value: "", source: "global" };
  },
}));

describe("SeriesHeader", () => {
  const mockSeries = {
    id: "s1",
    title: "One Piece",
    originalLanguage: "ja",
    sourceLanguage: "ja",
    targetLanguage: "en",
    readingDirection: "rtl",
    coverImageUrl: "http://example.com/cover.jpg",
  };

  const mockUser = {
    id: "1",
    username: "test",
    email: "t@t.com",
    displayName: "test",
    role: "translator",
    token: "tok123",
  };

  const mockAddChapter = vi.fn();
  const mockImportChapter = vi.fn();
  const mockEditSeries = vi.fn();
  const mockDeleteSeries = vi.fn();

  it("renders series title and metadata", () => {
    render(
      <SeriesHeader
        series={mockSeries}
        chapterCount={12}
        user={mockUser}
        onAddChapter={mockAddChapter}
        onImportChapter={mockImportChapter}
        onEditSeries={mockEditSeries}
        onDeleteSeries={mockDeleteSeries}
      />,
    );

    expect(screen.getByText("One Piece")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("triggers action button handlers", () => {
    render(
      <SeriesHeader
        series={mockSeries}
        chapterCount={12}
        user={mockUser}
        onAddChapter={mockAddChapter}
        onImportChapter={mockImportChapter}
        onEditSeries={mockEditSeries}
        onDeleteSeries={mockDeleteSeries}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Add Chapter/ }));
    expect(mockAddChapter).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Import Chapter/ }));
    expect(mockImportChapter).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Edit Series/ }));
    expect(mockEditSeries).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Delete Series/ }));
    expect(mockDeleteSeries).toHaveBeenCalledTimes(1);
  });
});
