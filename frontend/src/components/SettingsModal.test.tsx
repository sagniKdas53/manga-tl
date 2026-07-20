import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import SettingsModal from "./SettingsModal";
import { safeFetch } from "../utils";

const mockShowToast = vi.fn();
vi.mock("./ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
}));

vi.mock("../utils", () => ({
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
    // 9 comboboxes: Routing Strategy, OCR Provider, OCR Model, TL Provider, TL Model, QA Provider, QA Mode, QA LLM Model, QA VLM Model
    expect(screen.getAllByRole("combobox")).toHaveLength(9);
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
    // 0=Routing Strategy, 1=OCR Provider, 2=OCR Model, 3=TL Provider, 4=TL Model,
    // 5=QA Provider, 6=QA Mode, 7=QA LLM Model, 8=QA VLM Model
    const change = (idx: number, option: string) => {
      fireEvent.mouseDown(selects[idx]);
      fireEvent.click(screen.getByRole("option", { name: option }));
    };

    change(1, "local");
    // OCR Model is disabled when provider is local — skip and change TL/QA instead
    change(3, "openai");
    change(4, "meta-llama/llama-3-8b-instruct:free");
    change(5, "gemini");
    change(7, "deepseek/deepseek-v4-flash");
    change(8, "qwen/qwen3-vl-8b-instruct");

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
