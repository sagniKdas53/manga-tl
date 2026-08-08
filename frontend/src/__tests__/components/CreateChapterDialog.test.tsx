import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CreateChapterDialog from "../../components/CreateChapterDialog";

const mockSafeFetch = vi.fn();
vi.mock("../../utils", () => ({
  safeFetch: (url: string, ...args: unknown[]) => {
    // On open the dialog asks the server for the highest chapter number, because the
    // `chapters` prop is only one page of a paginated list. Routed here like /api/settings
    // so it does not consume the per-test `mockResolvedValueOnce` meant for the submit.
    if (typeof url === "string" && url.includes("sortDir=desc")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: [{ chapterNumber: 1 }] }),
      });
    }
    if (typeof url === "string" && url.includes("/api/settings")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ocrProvider: "local",
            ocrVlmModelList: ["model-ocr-1"],
            tlProvider: "openrouter",
            tlLlmModelList: ["model-tl-1"],
            qaProvider: "openrouter",
            qaLlmModelList: ["model-qa-llm-1"],
            qaVlmModelList: ["model-qa-vlm-1"],
            useFallbackModels: true,
          }),
      });
    }
    return mockSafeFetch(url, ...args);
  },
}));

describe("CreateChapterDialog", () => {
  const mockUser = {
    id: "1",
    username: "testuser",
    email: "test@test.com",
    displayName: "testuser",
    role: "translator",
    token: "token123",
  };

  const mockSeries = {
    id: "s1",
    title: "Test Series",
    originalLanguage: "ja",
    readingDirection: "rtl",
  };

  const mockChapters = [
    {
      id: "c1",
      seriesId: "s1",
      chapterNumber: 1,
      title: "Chapter 1",
    },
  ];

  const defaultProps = {
    open: true,
    editingChapter: null,
    user: mockUser,
    selectedSeries: mockSeries,
    chapters: mockChapters,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders when open with next chapter number prefilled", () => {
    render(<CreateChapterDialog {...defaultProps} />);
    expect(screen.getByText("Add Chapter")).toBeInTheDocument();
    const numInput = screen.getByLabelText(
      /Chapter Number/,
    ) as HTMLInputElement;
    expect(numInput.value).toBe("2");
  });

  it("opens overrides accordion", async () => {
    render(<CreateChapterDialog {...defaultProps} />);
    const accordionBtn = screen.getByText("Model Overrides (Optional)");
    fireEvent.click(accordionBtn);
    await waitFor(() => {
      expect(screen.getAllByText("OCR Provider").length).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  it("submits form data when Create Chapter is clicked", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "c2",
          seriesId: "s1",
          chapterNumber: 2,
          title: "New Chapter",
        }),
    });

    render(<CreateChapterDialog {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("e.g. The Beginning");
    fireEvent.change(titleInput, { target: { value: "New Chapter" } });

    const createBtn = screen.getByRole("button", { name: "Create Chapter" });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/series/s1/chapters",
        expect.objectContaining({
          method: "POST",
        }),
      );
      expect(defaultProps.onSuccess).toHaveBeenCalled();
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });
});
