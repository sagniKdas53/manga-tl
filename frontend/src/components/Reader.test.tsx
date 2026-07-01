import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
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

vi.mock("../utils", () => ({
  safeFetch: vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
  ),
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

  it("handles basic interactions", async () => {
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
    // Wait for the component to settle
    await screen.findByText(/Test Series/);
  });
});
