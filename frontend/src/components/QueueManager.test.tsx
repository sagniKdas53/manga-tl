import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { QueueManager } from "./QueueManager";
import { safeFetch } from "../utils";

// Mock safeFetch
vi.mock("../utils", () => ({
  safeFetch: vi.fn(),
}));

describe("QueueManager", () => {
  const mockToken = "test-token";
  
  const mockJobs = [
    {
      id: "job-1",
      type: "ocr",
      imageId: "img-1",
      status: "PENDING",
      payload: JSON.stringify({
        chapterNumber: 2,
        pageNumber: 3,
        chapterTitle: "The Beginning",
        seriesTitle: "My Manga",
        ocrProvider: "google",
        ocrModel: "gemini-3.5-flash"
      }),
      error: null,
      attempt: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "job-2",
      type: "translation",
      imageId: "img-2",
      status: "FAILED",
      payload: JSON.stringify({
        chapterNumber: 2,
        pageNumber: 4,
        tlProvider: "openai",
        tlModel: "gpt-4o"
      }),
      error: "API Limit Reached",
      attempt: 3,
      maxAttempts: 3,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders closed dropdown button by default", () => {
    render(<QueueManager token={mockToken} />);
    const button = screen.getByTitle("Queue Manager");
    expect(button).toBeInTheDocument();
    expect(screen.queryByText("Queue Manager")).toBeNull();
  });

  it("fetches and displays jobs immediately and renders dropdown content when opened", async () => {
    (safeFetch as Mock).mockImplementation((url: string) => {
      if (url === "/api/jobs") {
        return Promise.resolve({
          ok: true,
          json: async () => mockJobs,
        });
      }
      if (url === "/api/jobs/status") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ isPaused: false }),
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<QueueManager token={mockToken} />);
    const button = screen.getByTitle("Queue Manager");
    fireEvent.click(button);

    // Dropdown is open, wait for jobs to render
    await waitFor(() => {
      expect(screen.getByText("Queue Manager")).toBeInTheDocument();
    });

    // Check pretty task headers
    expect(screen.getByText("OCR Processing")).toBeInTheDocument();
    expect(screen.getByText("Translation")).toBeInTheDocument();

    // Check payload details (Location & Provider/Model)
    expect(screen.getByText("My Manga - The Beginning (Ch.2) › Page 3")).toBeInTheDocument();
    expect(screen.getByText("google / gemini-3.5-flash")).toBeInTheDocument();
    expect(screen.getByText("Ch.2 › Page 4")).toBeInTheDocument();
    expect(screen.getByText("openai / gpt-4o")).toBeInTheDocument();

    // Check buttons rendered
    expect(screen.getByText("Clear Queue")).toBeInTheDocument();
    expect(screen.getByText("Pause")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.getByText("Dismiss")).toBeInTheDocument();
  });

  it("toggles global queue status (pause/resume)", async () => {
    (safeFetch as Mock).mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/jobs") {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === "/api/jobs/status") {
        return Promise.resolve({ ok: true, json: async () => ({ isPaused: false }) });
      }
      if (url === "/api/jobs/pause" && init?.method === "POST") {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<QueueManager token={mockToken} />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getByText("Pause Queue")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Pause Queue"));

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith("/api/jobs/pause", expect.objectContaining({
        method: "POST",
      }));
    });
  });

  it("handles cancelling a pending job", async () => {
    (safeFetch as Mock).mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/jobs") {
        return Promise.resolve({ ok: true, json: async () => mockJobs });
      }
      if (url === "/api/jobs/status") {
        return Promise.resolve({ ok: true, json: async () => ({ isPaused: false }) });
      }
      if (url === "/api/jobs/job-1" && init?.method === "DELETE") {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<QueueManager token={mockToken} />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith("/api/jobs/job-1", expect.objectContaining({
        method: "DELETE",
      }));
    });
  });

  it("handles dismissing a failed job", async () => {
    (safeFetch as Mock).mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/jobs") {
        return Promise.resolve({ ok: true, json: async () => mockJobs });
      }
      if (url === "/api/jobs/status") {
        return Promise.resolve({ ok: true, json: async () => ({ isPaused: false }) });
      }
      if (url === "/api/jobs/job-2" && init?.method === "DELETE") {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<QueueManager token={mockToken} />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getByText("Dismiss")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Dismiss"));

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith("/api/jobs/job-2", expect.objectContaining({
        method: "DELETE",
      }));
    });
  });
});
