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
});
