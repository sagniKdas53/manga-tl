import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import SettingsModal from "../../components/SettingsModal";
import { safeFetch } from "../../utils";

const mockShowToast = vi.fn();
vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
}));

vi.mock("../../utils", () => ({
  safeFetch: vi.fn(),
}));

describe("SettingsModal", () => {
  const mockOnClose = vi.fn();
  const mockSettings = {
    ocrProvider: "openrouter",
    ocrModel: "qwen/qwen3-vl-8b-instruct",
    ocrVlmModelList: [
      "qwen/qwen3-vl-8b-instruct",
      "google/gemini-3.1-flash-lite",
    ],
    tlProvider: "gemini",
    tlModel: "gemini-1.5-pro",
    tlLlmModelList: ["gemini-1.5-pro", "meta-llama/llama-3-8b-instruct:free"],
    qaProvider: "openai",
    qaLlmModel: "gpt-4o-mini",
    qaLlmModelList: ["gpt-4o-mini", "deepseek/deepseek-v4-flash"],
    qaVlmModel: "google/gemini-3.1-flash-lite",
    qaVlmModelList: [
      "google/gemini-3.1-flash-lite",
      "qwen/qwen3-vl-8b-instruct",
    ],
    useFallbackModels: true,
    activeProviders: [
      "openrouter",
      "gemini",
      "nvidia",
      "openai",
      "anthropic",
      "ollama",
      "lmstudio",
    ],
    activeOcrProviders: [
      "local",
      "openrouter",
      "gemini",
      "nvidia",
      "ollama",
      "lmstudio",
    ],
    providerModelsMap: {
      openrouter: {
        ocr: [
          {
            id: "qwen/qwen3-vl-8b-instruct",
            name: "qwen/qwen3-vl-8b-instruct",
          },
          {
            id: "google/gemini-3.1-flash-lite",
            name: "google/gemini-3.1-flash-lite",
          },
        ],
        tl: [
          { id: "gemini-1.5-pro", name: "gemini-1.5-pro" },
          {
            id: "meta-llama/llama-3-8b-instruct:free",
            name: "meta-llama/llama-3-8b-instruct:free",
          },
        ],
        qaLLM: [
          { id: "gpt-4o-mini", name: "gpt-4o-mini" },
          {
            id: "deepseek/deepseek-v4-flash",
            name: "deepseek/deepseek-v4-flash",
          },
        ],
        qaVLM: [
          {
            id: "google/gemini-3.1-flash-lite",
            name: "google/gemini-3.1-flash-lite",
          },
          {
            id: "qwen/qwen3-vl-8b-instruct",
            name: "qwen/qwen3-vl-8b-instruct",
          },
        ],
      },
      gemini: {
        ocr: [
          {
            id: "google/gemini-3.1-flash-lite",
            name: "google/gemini-3.1-flash-lite",
          },
        ],
        tl: [{ id: "gemini-1.5-pro", name: "gemini-1.5-pro" }],
        qaLLM: [
          {
            id: "deepseek/deepseek-v4-flash",
            name: "deepseek/deepseek-v4-flash",
          },
        ],
        qaVLM: [
          {
            id: "qwen/qwen3-vl-8b-instruct",
            name: "qwen/qwen3-vl-8b-instruct",
          },
        ],
      },
      openai: {
        tl: [
          {
            id: "meta-llama/llama-3-8b-instruct:free",
            name: "meta-llama/llama-3-8b-instruct:free",
          },
        ],
        qaLLM: [{ id: "gpt-4o-mini", name: "gpt-4o-mini" }],
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when isOpen is false", () => {
    const { container } = render(
      <SettingsModal
        isOpen={false}
        onClose={mockOnClose}
        token="mock-token"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("fetches and displays settings on open", { timeout: 15000 }, async () => {
    (safeFetch as Mock).mockResolvedValue({
      ok: true,
      json: async () => mockSettings,
    });

    render(
      <SettingsModal
        isOpen={true}
        onClose={mockOnClose}
        token="mock-token"
      />,
    );

    expect(screen.getByText("Loading settings...")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText("Loading settings...")).toBeNull();
    });

    expect(screen.getByText("System Settings")).toBeInTheDocument();
    // 10 comboboxes: Global OCR Provider, Global OCR Model, Global TL Provider, Global TL Model, Global QA Provider, QA Mode, Global QA LLM Model, Global QA VLM Model, OpenRouter Routing Strategy, Use Fallback Models
    expect(screen.getAllByRole("combobox")).toHaveLength(10);
  });

  it("handles saving the updated settings", { timeout: 30000 }, async () => {
    (safeFetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockSettings,
    });

    render(
      <SettingsModal
        isOpen={true}
        onClose={mockOnClose}
        token="mock-token"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading settings...")).toBeNull();
    });

    (safeFetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...mockSettings,
        ocrProvider: "local",
        ocrModel: "google/gemini-3.1-flash-lite",
        tlProvider: "openai",
        tlModel: "meta-llama/llama-3-8b-instruct:free",
        qaProvider: "gemini",
        qaLlmModel: "deepseek/deepseek-v4-flash",
        qaVlmModel: "qwen/qwen3-vl-8b-instruct",
      }),
    });

    const selects = screen.getAllByRole("combobox");
    // 0=OCR Provider, 1=OCR Model, 2=TL Provider, 3=TL Model,
    // 4=QA Provider, 5=QA Mode, 6=QA LLM Model, 7=QA VLM Model, 8=Routing Strategy, 9=Use Fallback Models
    const change = (idx: number, option: string) => {
      fireEvent.mouseDown(selects[idx]);
      fireEvent.click(
        screen.getByRole("option", {
          name: (accessibleName) =>
            accessibleName === option ||
            accessibleName.startsWith(`${option} · `),
        }),
      );
    };

    change(0, "local");
    // OCR Model is disabled when provider is local — skip and change TL/QA instead
    change(2, "openai");
    change(3, "meta-llama/llama-3-8b-instruct:free");
    change(4, "gemini");
    change(6, "deepseek/deepseek-v4-flash");
    change(7, "qwen/qwen3-vl-8b-instruct");

    const saveButton = screen.getByRole("button", { name: /save settings/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PUT",
        }),
      );
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  it("shows error toast when fetch fails", async () => {
    (safeFetch as Mock).mockResolvedValue({
      ok: false,
    });

    render(
      <SettingsModal
        isOpen={true}
        onClose={mockOnClose}
        token="mock-token"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading settings...")).toBeNull();
    });

    expect(screen.getByText("Failed to load settings.")).toBeInTheDocument();
    expect(mockShowToast).toHaveBeenCalledWith(
      "Failed to load settings",
      "error",
    );
  });

  it("shows error toast when save fails", { timeout: 15000 }, async () => {
    (safeFetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockSettings,
    });

    render(
      <SettingsModal
        isOpen={true}
        onClose={mockOnClose}
        token="mock-token"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading settings...")).toBeNull();
    });

    (safeFetch as Mock).mockResolvedValueOnce({
      ok: false,
    });

    const saveButton = screen.getByRole("button", { name: /save settings/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PUT",
        }),
      );
      expect(mockShowToast).toHaveBeenCalledWith(
        "Failed to save settings",
        "error",
      );
    });
  });
});
