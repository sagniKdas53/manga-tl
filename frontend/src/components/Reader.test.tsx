import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Reader } from "./Reader";

// Mock external modules
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ pageNumber: "1" }),
}));

vi.mock("./useNotifications", () => ({
  useNotifications: () => ({ notifications: [] }),
}));

vi.mock("./ToastContext", () => ({
  useToast: () => ({
    showToast: vi.fn(),
    showSuccess: vi.fn(),
    showError: vi.fn(),
  }),
}));

const mockSafeFetch = vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
);
vi.mock("../utils", () => ({
  safeFetch: (...args: any[]) => mockSafeFetch(...args),
  toSlug: (s: string) => s.toLowerCase(),
}));

describe("Reader Component", () => {
  const mockUser = {
    id: "1",
    username: "testuser",
    role: "user",
    token: "token123",
  };
  const mockSeries = {
    id: "s1",
    title: "Test Series",
    slug: "test-series",
    description: "desc",
    status: "ONGOING",
    chaptersCount: 0,
    imageId: "img1",
  };
  const mockChapter = {
    id: "c1",
    seriesId: "s1",
    chapterNumber: 1,
    title: "Chapter 1",
    status: "PENDING",
    pagesCount: 1,
  };
  const mockPage = {
    id: "p1",
    chapterId: "c1",
    pageNumber: 1,
    imageId: "img1",
    status: "PENDING",
    imagePath: "/path/to/img",
    processingProgress: 0,
  };

  beforeEach(() => {
    localStorage.clear();
    mockSafeFetch.mockReset();
    mockSafeFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  it("renders reader component basic controls", async () => {
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );
    // Use findByText to wait for asynchronous state updates
    expect(await screen.findByText(/Test Series/)).toBeInTheDocument();
  });

  it("handles sidebar toggles and page navigation clicks", async () => {
    const mockPages = [
      mockPage,
      { ...mockPage, id: "p2", pageNumber: 2 },
    ];
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={mockPages}
        theme="dark"
      />,
    );

    // Wait for render
    await screen.findByText(/Test Series/);

    // By default both sidebars are true (visible)
    expect(screen.getByText("Navigation")).toBeInTheDocument();

    // Click left sidebar toggle to hide it
    const leftSidebarToggle = screen.getByTitle(/Toggle Global Controls/i);
    fireEvent.click(leftSidebarToggle);
    expect(screen.queryByText("Navigation")).not.toBeInTheDocument();

    // Click right sidebar toggle
    const rightSidebarToggle = screen.getByTitle(/Toggle Property Inspector/i);
    fireEvent.click(rightSidebarToggle);
  });

  it("handles toolbar buttons and editor actions", async () => {
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={[mockPage]}
        theme="dark"
      />,
    );

    await screen.findByText(/Test Series/);

    // Click fit mode buttons
    fireEvent.click(screen.getByRole("button", { name: "Page" }));
    fireEvent.click(screen.getByRole("button", { name: "Width" }));
    fireEvent.click(screen.getByRole("button", { name: "Height" }));

    // Click Redo actions
    mockSafeFetch.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByText("Redo Page OCR"));

    mockSafeFetch.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByText("Redo Page Translation"));

    // Click layer creation buttons
    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "l1", type: "translation", name: "TL Layer" }),
    });
    fireEvent.click(screen.getByTitle("Add Translation Layer"));

    mockSafeFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "l2", type: "sfx", name: "SFX Layer" }),
    });
    fireEvent.click(screen.getByTitle("Add SFX Layer"));
  });
});
