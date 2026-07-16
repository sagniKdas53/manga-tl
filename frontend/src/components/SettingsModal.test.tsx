import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import SettingsModal from "./SettingsModal";
import { safeFetch } from "../utils";

// Mock useToast with a shared mock function
const mockShowToast = vi.fn();
vi.mock("./ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
    showError: mockShowToast,
    showSuccess: mockShowToast,
    showInfo: mockShowToast,
  }),
}));

// Mock safeFetch
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

  it("fetches and displays settings on open", async () => {
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

    // Shows loading initially
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    // Wait for the settings to load
    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    expect(screen.getByText("System Settings")).toBeInTheDocument();
    expect(screen.getByLabelText("Global OCR Provider")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Global Translation Provider"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Global QA Provider")).toBeInTheDocument();
  });

  it("handles saving the updated settings", async () => {
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
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    // Mock successful put request
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

    const ocrProviderSelect = screen.getByLabelText("Global OCR Provider");
    fireEvent.change(ocrProviderSelect, { target: { value: "local" } });

    const ocrModelSelect = screen.getByLabelText("Global OCR VLM Model");
    fireEvent.change(ocrModelSelect, {
      target: { value: "google/gemini-3.1-flash-lite" },
    });

    const tlProviderSelect = screen.getByLabelText(
      "Global Translation Provider",
    );
    fireEvent.change(tlProviderSelect, { target: { value: "openai" } });

    const tlModelSelect = screen.getByLabelText("Global Translation LLM Model");
    fireEvent.change(tlModelSelect, {
      target: { value: "meta-llama/llama-3-8b-instruct:free" },
    });

    const qaProviderSelect = screen.getByLabelText("Global QA Provider");
    fireEvent.change(qaProviderSelect, { target: { value: "gemini" } });

    const qaLlmSelect = screen.getByLabelText("Global QA LLM Model");
    fireEvent.change(qaLlmSelect, {
      target: { value: "deepseek/deepseek-v4-flash" },
    });

    const qaVlmSelect = screen.getByLabelText("Global QA VLM Model");
    fireEvent.change(qaVlmSelect, {
      target: { value: "qwen/qwen3-vl-8b-instruct" },
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
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    expect(screen.getByText("Failed to load settings.")).toBeInTheDocument();
    expect(mockShowToast).toHaveBeenCalledWith(
      "Failed to load settings",
      "error",
    );
  });

  it("shows error toast when save fails", async () => {
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
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    // Mock failed put request
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
