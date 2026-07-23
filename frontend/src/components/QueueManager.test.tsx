import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { QueueManager } from "./QueueManager";
import { safeFetch } from "../utils";
import { useNotifications } from "./useNotifications";
import { useColorMode } from "../hooks/useColorMode";

vi.mock("../utils", () => ({
  safeFetch: vi.fn(),
}));

vi.mock("./useNotifications", () => ({
  useNotifications: vi.fn(),
}));

vi.mock("../hooks/useColorMode", () => ({
  useColorMode: vi.fn(),
}));

vi.mock("./ToastContext", () => ({
  useToast: () => ({
    showToast: vi.fn(),
  }),
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

  const QueueManagerWrapper = ({ token = mockToken }) => {
    const [open, setOpen] = React.useState(false);
    return (
      <QueueManager
        token={token}
        forceOpen={open}
        onRequestOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
      />
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useColorMode as Mock).mockReturnValue({
      mode: "dark",
    });
    (useNotifications as Mock).mockReturnValue({
      subscribe: vi.fn(() => () => {}),
    });
  });

  it("renders closed state by default", () => {
    render(<QueueManagerWrapper />);
    const button = screen.getByTitle("Queue Manager");
    expect(button).toBeInTheDocument();
    expect(screen.queryByText("Queue Manager")).toBeNull();
  });

  it("fetches and displays jobs immediately and renders drawer content when opened", async () => {
    (safeFetch as Mock).mockImplementation((url: string) => {
      if (url === "/api/jobs") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ isPaused: false, jobs: mockJobs }),
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getByLabelText("Clear Queue")).toBeInTheDocument();
      expect(screen.getByText("OCR Processing")).toBeInTheDocument();
      expect(screen.getByText("Translation")).toBeInTheDocument();
    });

    expect(screen.getByText(/My Manga/i)).toBeInTheDocument();
    expect(screen.getByText(/The Beginning/i)).toBeInTheDocument();
    expect(screen.getByText(/Page 3/i)).toBeInTheDocument();

    expect(screen.getAllByLabelText("Pause")[0]).toBeInTheDocument();
    expect(screen.getAllByLabelText("Retry").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Delete").length).toBeGreaterThan(0);
  });

  it("toggles global queue status (pause/resume) with modal", async () => {
    (safeFetch as Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url === "/api/jobs") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ isPaused: false, jobs: [] }),
          });
        }
        if (url === "/api/jobs/pause" && init?.method === "POST") {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error("Unknown URL"));
      },
    );

    render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getByLabelText("Pause Queue")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Pause Queue"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Are you sure you want to pause the queue? All pending jobs will be paused.",
        ),
      ).toBeInTheDocument();
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
          return Promise.resolve({
            ok: true,
            json: async () => ({ isPaused: false, jobs: mockJobs }),
          });
        }
        if (url === "/api/jobs/job-1" && init?.method === "DELETE") {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error("Unknown URL"));
      },
    );

    render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getAllByLabelText("Delete").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByLabelText("Delete")[0]);

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
          json: async () => ({ isPaused: false, jobs: mockJobs }),
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    const { rerender } = render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getByText("OCR Processing")).toBeInTheDocument();
      expect(screen.getAllByLabelText("Pause")[0]).toBeInTheDocument();
    });

    const subscribeMock = (useNotifications as Mock).mock.results[0].value
      .subscribe;
    const callback = subscribeMock.mock.calls[0][0];

    callback({
      type: "job_update",
      data: JSON.stringify({
        jobId: "job-1",
        imageId: "img-1",
        status: "PROCESSING",
      }),
    });

    rerender(<QueueManagerWrapper />);

    await waitFor(() => {
      expect(screen.getByText("PROCESSING")).toBeInTheDocument();
    });
  });

  it("handles retrying a failed job", async () => {
    (safeFetch as Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url === "/api/jobs") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ isPaused: false, jobs: mockJobs }),
          });
        }
        if (url === "/api/jobs/job-2/retry" && init?.method === "POST") {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error("Unknown URL"));
      },
    );

    render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getAllByLabelText("Retry").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByLabelText("Retry")[1]);

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith(
        "/api/jobs/job-2/retry",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("handles pausing a pending job", async () => {
    (safeFetch as Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url === "/api/jobs") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ isPaused: false, jobs: mockJobs }),
          });
        }
        if (url === "/api/jobs/job-1/pause" && init?.method === "POST") {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error("Unknown URL"));
      },
    );

    render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getAllByLabelText("Pause").length).toBeGreaterThan(0);
    });

    const pauseButtons = screen.getAllByLabelText("Pause");
    fireEvent.click(pauseButtons[0]);

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith(
        "/api/jobs/job-1/pause",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("filters out old COMPLETED jobs on fetch", async () => {
    const oldCompletedJob = {
      id: "job-3",
      type: "qa",
      imageId: "img-3",
      status: "COMPLETED",
      payload: JSON.stringify({}),
      error: null,
      attempt: 1,
      maxAttempts: 3,
      createdAt: new Date(Date.now() - 20000).toISOString(),
      updatedAt: new Date(Date.now() - 15000).toISOString(),
    };
    const recentCompletedJob = {
      id: "job-4",
      type: "qa",
      imageId: "img-4",
      status: "COMPLETED",
      payload: JSON.stringify({}),
      error: null,
      attempt: 1,
      maxAttempts: 3,
      createdAt: new Date(Date.now() - 5000).toISOString(),
      updatedAt: new Date(Date.now() - 2000).toISOString(),
    };

    (safeFetch as Mock).mockImplementation((url: string) => {
      if (url === "/api/jobs") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            isPaused: false,
            jobs: [oldCompletedJob, recentCompletedJob],
          }),
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      const texts = screen.queryAllByText("TRANSITIONING...");
      expect(texts.length).toBe(1);
    });
  });
});
