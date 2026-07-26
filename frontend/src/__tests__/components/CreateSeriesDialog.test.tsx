import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CreateSeriesDialog from "../../components/CreateSeriesDialog";

const mockSafeFetch = vi.fn();
vi.mock("../../utils", () => ({
  safeFetch: (url: string, ...args: unknown[]) => {
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

vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
}));

describe("CreateSeriesDialog", () => {
  const mockUser = {
    id: "1",
    username: "testuser",
    email: "test@test.com",
    displayName: "testuser",
    role: "translator",
    token: "token123",
  };

  const defaultProps = {
    open: true,
    editingSeries: null,
    user: mockUser,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders when open", () => {
    render(<CreateSeriesDialog {...defaultProps} />);
    expect(screen.getByRole("heading", { name: "Create Series" })).toBeInTheDocument();
  });

  it("submits new series payload on Create Series click", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "s1",
          title: "My New Manga",
        }),
    });

    render(<CreateSeriesDialog {...defaultProps} />);

    const titleInput = screen.getByPlaceholderText("e.g. My Hero Academia");
    fireEvent.change(titleInput, { target: { value: "My New Manga" } });

    const createBtn = screen.getByRole("button", { name: "Create Series" });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "/api/series",
        expect.objectContaining({
          method: "POST",
        }),
      );
      expect(defaultProps.onSuccess).toHaveBeenCalled();
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });
});
