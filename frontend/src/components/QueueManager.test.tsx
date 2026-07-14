import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { QueueManager } from "./QueueManager";
import { safeFetch } from "../utils";
import { useNotifications } from "./useNotifications";

// Mock safeFetch
vi.mock("../utils", () => ({
  safeFetch: vi.fn(),
}));

// Mock useNotifications
vi.mock("./useNotifications", () => ({
  useNotifications: vi.fn(),
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
        ocrModel: "gemini-3.5-flash",
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
        tlModel: "gpt-4o",
      }),
      error: "API Limit Reached",
      attempt: 3,
      maxAttempts: 3,
      createdAt: new Date(Date.now() + 1000).toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (useNotifications as Mock).mockReturnValue({
      lastEvent: null,
      lastEventTime: 0,
    });
  });

  it("renders closed dropdown button by default", () => {
    render(<QueueManager token={mockToken} />);
    const button = screen.getByTitle("Queue Manager");
    expect(button).toBeInTheDocument();
    expect(screen.queryByText("Clear Queue")).toBeNull();
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

    await waitFor(() => {
      expect(screen.getByText("Clear Queue")).toBeInTheDocument();
    });

    expect(screen.getByText("OCR Processing")).toBeInTheDocument();
    expect(screen.getByText("Translation")).toBeInTheDocument();

    expect(
      screen.getByText("My Manga - The Beginning (Ch.2) › Page 3"),
    ).toBeInTheDocument();
    expect(screen.getByText("google / gemini-3.5-flash")).toBeInTheDocument();

    // Check buttons rendered via titles
    expect(screen.getByTitle("Pause")).toBeInTheDocument();
    expect(screen.getByTitle("Retry")).toBeInTheDocument();
    expect(screen.getAllByTitle("Delete").length).toBeGreaterThan(0);
  });

  it("toggles global queue status (pause/resume) with modal", async () => {
    (safeFetch as Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url === "/api/jobs") {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        if (url === "/api/jobs/status") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ isPaused: false }),
          });
        }
        if (url === "/api/jobs/pause" && init?.method === "POST") {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error("Unknown URL"));
      },
    );

    render(<QueueManager token={mockToken} />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getByText("Pause")).toBeInTheDocument();
    });

    // Click Pause (Global queue pause button)
    fireEvent.click(screen.getByText("Pause"));

    // Confirm Modal appears
    await waitFor(() => {
      expect(screen.getByText("Are you sure you want to pause the queue? All pending jobs will be paused.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith(
        "/api/jobs/pause",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
  });

  it("handles cancelling a pending job", async () => {
    (safeFetch as Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url === "/api/jobs") {
          return Promise.resolve({ ok: true, json: async () => mockJobs });
        }
        if (url === "/api/jobs/status") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ isPaused: false }),
          });
        }
        if (url === "/api/jobs/job-1" && init?.method === "DELETE") {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error("Unknown URL"));
      },
    );

    render(<QueueManager token={mockToken} />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getAllByTitle("Delete").length).toBeGreaterThan(0);
    });

    // Job-1 delete button
    fireEvent.click(screen.getAllByTitle("Delete")[0]);

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith(
        "/api/jobs/job-1",
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });
  });

  it("updates jobs based on SSE events without polling", async () => {
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

    const { rerender } = render(<QueueManager token={mockToken} />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getByText("OCR Processing")).toBeInTheDocument();
    });

    // Trigger SSE event for job-1 update
    (useNotifications as Mock).mockReturnValue({
      lastEvent: {
        type: "job_update",
        data: JSON.stringify({
          jobId: "job-1",
          status: "PROCESSING",
        }),
      },
      lastEventTime: Date.now(),
    });

    rerender(<QueueManager token={mockToken} />);

    await waitFor(() => {
      expect(screen.getByText("PROCESSING")).toBeInTheDocument();
    });

    // We shouldn't see 'Pause' button for PROCESSING jobs
    expect(screen.queryByTitle("Pause")).toBeNull();
  });
});
