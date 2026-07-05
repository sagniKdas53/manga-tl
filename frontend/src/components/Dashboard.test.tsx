import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Dashboard from "./Dashboard";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockSafeFetch = vi.fn();
vi.mock("../utils", () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  toSlug: (s: string) => s.toLowerCase().replace(/\s+/g, "-"),
}));

describe("Dashboard Component", () => {
  const mockUser = {
    id: "1",
    username: "testuser",
    email: "test@test.com",
    role: "translator",
    token: "token123",
  };

  const initialSeries = [
    {
      id: "s1",
      title: "One Piece",
      coverImageUrl: "http://example.com/op.jpg",
      readingDirection: "rtl",
      sourceLanguage: "ja",
      targetLanguage: "en",
    },
    {
      id: "s2",
      title: "Naruto",
      coverImageUrl: "",
      readingDirection: "rtl",
      sourceLanguage: "ja",
      targetLanguage: "en",
    },
  ];

  const mockSetSeriesList = vi.fn();
  const mockOnSelectSeries = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeFetch.mockReset();
  });

  it("renders the dashboard with list of series", () => {
    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    expect(screen.getByText("My Manga Library")).toBeInTheDocument();
    expect(screen.getByText("One Piece")).toBeInTheDocument();
    expect(screen.getAllByText("Naruto").length).toBeGreaterThan(0);
  });

  it("navigates to series page when card is clicked", () => {
    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const card = screen.getByText("One Piece").closest(".manga-card");
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    expect(mockOnSelectSeries).toHaveBeenCalledWith(initialSeries[0]);
    expect(mockNavigate).toHaveBeenCalledWith("/series/s1/one-piece");
  });

  it("opens modal on clicking New Series and submits successfully", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "s3",
          title: "Bleach",
          readingDirection: "rtl",
          sourceLanguage: "ja",
          targetLanguage: "en",
        }),
    });

    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const newBtn = screen.getByRole("button", { name: /\+ new series/i });
    fireEvent.click(newBtn);

    expect(screen.getByText("Create New Series")).toBeInTheDocument();

    const titleInput = screen.getByPlaceholderText("e.g. My Hero Academia");
    fireEvent.change(titleInput, { target: { value: "Bleach" } });

    const submitBtn = screen.getByRole("button", { name: /create/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer token123`,
        },
        body: JSON.stringify({
          title: "Bleach",
          originalLanguage: "ja",
          sourceLanguage: "ja",
          targetLanguage: "en",
          readingDirection: "rtl",
          coverImageUrl: null,
        }),
      });
      expect(mockSetSeriesList).toHaveBeenCalled();
    });
  });

  it("opens edit series modal and performs changes", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ ...initialSeries[0], title: "One Piece Updated" }),
    });

    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const editBtn = screen.getAllByTitle("Edit Series")[0];
    fireEvent.click(editBtn);

    expect(screen.getByText("Edit Series")).toBeInTheDocument();

    const titleInput = screen.getByPlaceholderText("e.g. My Hero Academia");
    expect(titleInput).toHaveValue("One Piece");
    fireEvent.change(titleInput, { target: { value: "One Piece Updated" } });

    const saveBtn = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/s1", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer token123`,
        },
        body: JSON.stringify({
          title: "One Piece Updated",
          originalLanguage: "ja",
          sourceLanguage: "ja",
          targetLanguage: "en",
          readingDirection: "rtl",
          coverImageUrl: "http://example.com/op.jpg",
        }),
      });
    });
  });

  it("cancels series modal without saving", () => {
    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const newBtn = screen.getByRole("button", { name: /\+ new series/i });
    fireEvent.click(newBtn);

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    expect(screen.queryByText("Create New Series")).not.toBeInTheDocument();
  });

  it("handles error when creating a series", async () => {
    mockSafeFetch.mockRejectedValueOnce(new Error("Network Error"));
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const newBtn = screen.getByRole("button", { name: /\+ new series/i });
    fireEvent.click(newBtn);

    const titleInput = screen.getByPlaceholderText("e.g. My Hero Academia");
    fireEvent.change(titleInput, { target: { value: "Bleach" } });

    const submitBtn = screen.getByRole("button", { name: /create/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error saving series:",
        expect.any(Error),
      );
    });

    consoleErrorSpy.mockRestore();
  });

  it("deletes a series successfully", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: true });

    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const deleteBtn = screen.getAllByTitle("Delete Series")[0];
    fireEvent.click(deleteBtn);

    expect(
      screen.getByText("Delete Series", { selector: "h3" }),
    ).toBeInTheDocument();

    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete Series",
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series/s1", {
        method: "DELETE",
        headers: { Authorization: `Bearer token123` },
      });
      expect(mockSetSeriesList).toHaveBeenCalled();
    });
  });

  it("shows alert when deleting series fails", async () => {
    mockSafeFetch.mockResolvedValueOnce({ ok: false });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const deleteBtn = screen.getAllByTitle("Delete Series")[0];
    fireEvent.click(deleteBtn);

    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete Series",
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith("Failed to delete series");
    });

    alertSpy.mockRestore();
  });

  it("handles error when deleting a series", async () => {
    mockSafeFetch.mockRejectedValueOnce(new Error("Network Error"));
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const deleteBtn = screen.getAllByTitle("Delete Series")[0];
    fireEvent.click(deleteBtn);

    const confirmBtns = screen.getAllByRole("button", {
      name: "Delete Series",
    });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Error deleting series:",
        expect.any(Error),
      );
    });

    consoleErrorSpy.mockRestore();
  });

  it("creates a new series with cover url, language, and reading direction changed", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "s4",
          title: "New Manga",
          readingDirection: "ltr",
          sourceLanguage: "ko",
          targetLanguage: "zh-TW",
        }),
    });

    render(
      <Dashboard
        user={mockUser}
        seriesList={initialSeries}
        setSeriesList={mockSetSeriesList}
        onSelectSeries={mockOnSelectSeries}
      />,
    );

    const newBtn = screen.getByRole("button", { name: /\+ new series/i });
    fireEvent.click(newBtn);

    fireEvent.change(screen.getByPlaceholderText("e.g. My Hero Academia"), {
      target: { value: "New Manga" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Leave empty for default cover"),
      { target: { value: "http://example.com/cover.jpg" } },
    );

    // Change selects
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const sourceSelect = selects[0];
    fireEvent.change(sourceSelect, { target: { value: "ko" } });

    const targetSelect = selects[1];
    fireEvent.change(targetSelect, { target: { value: "zh-TW" } });

    const directionSelect = selects[2];
    fireEvent.change(directionSelect, { target: { value: "ltr" } });

    const submitBtn = screen.getByRole("button", { name: /create/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockSafeFetch).toHaveBeenCalledWith("/api/series", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer token123`,
        },
        body: JSON.stringify({
          title: "New Manga",
          originalLanguage: "ko",
          sourceLanguage: "ko",
          targetLanguage: "zh-TW",
          readingDirection: "ltr",
          coverImageUrl: "http://example.com/cover.jpg",
        }),
      });
      expect(mockSetSeriesList).toHaveBeenCalled();
    });
  });
});
