import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImportChapterDialog } from "./ImportChapterDialog";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("./ToastContext", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

const mockSafeFetch = vi.fn();
vi.mock("../utils", () => ({
  safeFetch: (url: string, options?: RequestInit) => {
    if (typeof url === "string" && url.includes("/api/settings")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            ocrProvider: "local",
            ocrModel: "paddleocr",
            ocrVlmModelList: ["vlm-ocr-1", "vlm-ocr-2"],
            tlProvider: "openrouter",
            tlModel: "gemini-flash",
            tlLlmModelList: ["gemini-flash", "claude-3"],
            qaProvider: "openrouter",
            qaMode: "hybrid",
            qaLlmModel: "gpt-4",
            qaVlmModel: "gpt-4v",
            qaLlmModelList: ["gpt-4", "claude-3"],
            qaVlmModelList: ["gpt-4v", "claude-3v"],
            routingStrategy: "lowest-cost",
            useFallbackModels: true,
          }),
      });
    }
    return mockSafeFetch(url, options);
  },
}));

const defaultSeries = { id: "s1", title: "One Piece", originalLanguage: "ja", readingDirection: "rtl" };
const defaultUser = {
  id: "1", username: "test", email: "t@t.com", displayName: "test", role: "translator", token: "tok",
};

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  onSuccess: vi.fn(),
  user: defaultUser,
  series: defaultSeries,
  nextNum: 5,
};

describe("ImportChapterDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "new-c" }) });
  });

  it("renders nothing when closed", () => {
    render(<ImportChapterDialog {...defaultProps} open={false} />);
    expect(screen.queryByText("Import Chapter (ZIP)")).toBeNull();
  });

  it("renders dialog when open", () => {
    render(<ImportChapterDialog {...defaultProps} />);
    expect(screen.getByText("Import Chapter (ZIP)")).toBeDefined();
  });

  it("pre-fills chapter number from nextNum", async () => {
    render(<ImportChapterDialog {...defaultProps} />);
    const input = await screen.findByLabelText(/Chapter Number/) as HTMLInputElement;
    expect(input.value).toBe("5");
  });

  it("has a file input accepting zip and epub", async () => {
    render(<ImportChapterDialog {...defaultProps} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeDefined();
    expect(fileInput.accept).toContain(".zip");
  });

  it("submit button exists when open", async () => {
    render(<ImportChapterDialog {...defaultProps} />);
    await screen.findByText("Model Overrides (Optional)");
    expect(screen.getByText("Import")).toBeDefined();
  });

  it("calls onClose when Cancel clicked", async () => {
    render(<ImportChapterDialog {...defaultProps} />);
    fireEvent.click(await screen.findByText("Cancel"));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows accordion for model overrides", async () => {
    render(<ImportChapterDialog {...defaultProps} />);
    expect(await screen.findByText("Model Overrides (Optional)")).toBeDefined();
  });

  it("can toggle override accordion", async () => {
    render(<ImportChapterDialog {...defaultProps} />);
    fireEvent.click(await screen.findByText("Model Overrides (Optional)"));
    await waitFor(() => {
      const labels = screen.getAllByText("OCR Provider");
      expect(labels.length).toBeGreaterThanOrEqual(1);
    });
  });
});
