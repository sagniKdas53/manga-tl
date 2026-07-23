import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditSeriesDialog } from "./EditSeriesDialog";

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
            ocrVlmModelList: ["vlm-ocr-1"],
            tlProvider: "openrouter",
            tlModel: "gemini-flash",
            tlLlmModelList: ["gemini-flash"],
            qaProvider: "openrouter",
            qaMode: "hybrid",
            qaLlmModel: "gpt-4",
            qaVlmModel: "gpt-4v",
            qaLlmModelList: ["gpt-4"],
            qaVlmModelList: ["gpt-4v"],
            routingStrategy: "lowest-cost",
            useFallbackModels: true,
          }),
      });
    }
    return mockSafeFetch(url, options);
  },
}));

const defaultSeries = {
  id: "s1",
  title: "One Piece",
  originalLanguage: "ja",
  readingDirection: "rtl",
  sourceLanguage: "ja",
  targetLanguage: "en",
};

const defaultProps = {
  open: true,
  series: defaultSeries,
  user: {
    id: "1",
    username: "test",
    email: "t@t.com",
    displayName: "test",
    role: "translator",
    token: "tok",
  },
  onClose: vi.fn(),
  onSuccess: vi.fn(),
};

describe("EditSeriesDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "s1", title: "Updated" }),
    });
  });

  it("renders nothing when closed", () => {
    render(
      <EditSeriesDialog
        {...defaultProps}
        open={false}
      />,
    );
    expect(screen.queryByText("Edit Series")).toBeNull();
  });

  it("renders dialog when open", () => {
    render(<EditSeriesDialog {...defaultProps} />);
    expect(screen.getByText("Edit Series")).toBeDefined();
  });

  it("pre-fills title from series", async () => {
    render(<EditSeriesDialog {...defaultProps} />);
    const input = (await screen.findByLabelText(
      /Series Title/,
    )) as HTMLInputElement;
    expect(input.value).toBe("One Piece");
  });

  it("calls onClose when Cancel clicked", async () => {
    render(<EditSeriesDialog {...defaultProps} />);
    fireEvent.click(await screen.findByText("Cancel"));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("can toggle override accordion", async () => {
    render(<EditSeriesDialog {...defaultProps} />);
    fireEvent.click(await screen.findByText("Model Overrides (Optional)"));
    await waitFor(() => {
      const labels = screen.getAllByText("OCR Provider");
      expect(labels.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("submits correct data on success", async () => {
    render(<EditSeriesDialog {...defaultProps} />);
    await screen.findByText("Model Overrides (Optional)");

    const titleInput = (await screen.findByLabelText(
      /Series Title/,
    )) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Updated Title" } });

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalled();
      const [url, init] = mockSafeFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/series/s1");
      expect(init.method).toBe("PUT");
      const body = JSON.parse(init.body as string);
      expect(body.title).toBe("Updated Title");
      expect(defaultProps.onSuccess).toHaveBeenCalled();
    });
  });
});
