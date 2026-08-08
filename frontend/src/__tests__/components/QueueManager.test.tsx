import React from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { QueueManager } from "../../components/QueueManager";
import { safeFetch } from "../../utils";
import { useNotifications } from "../../components/useNotifications";
import { useColorMode } from "../../hooks/useColorMode";

vi.mock("../../utils", () => ({
  safeFetch: vi.fn(),
}));

vi.mock("../../components/useNotifications", () => ({
  useNotifications: vi.fn(),
}));

vi.mock("../../hooks/useColorMode", () => ({
  useColorMode: vi.fn(),
}));

vi.mock("../../components/ToastContext", () => ({
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
      expect(
        screen.getByLabelText("Clear Pending/Failed Jobs"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Force Clear Queue")).toBeInTheDocument();
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

  it("force kills/flushes the whole queue via /api/jobs/clear?force=true", async () => {
    (safeFetch as Mock).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url === "/api/jobs") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ isPaused: false, jobs: mockJobs }),
          });
        }
        if (url === "/api/jobs/clear?force=true" && init?.method === "DELETE") {
          return Promise.resolve({ ok: true });
        }
        return Promise.reject(new Error("Unknown URL"));
      },
    );

    render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(screen.getByLabelText("Force Clear Queue")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Force Clear Queue"));

    await waitFor(() => {
      expect(
        screen.getByText(
          /immediately clear all jobs, including those currently running/i,
        ),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith(
        "/api/jobs/clear?force=true",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
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

  it("does not let a stale poll response overwrite a newer SSE status", async () => {
    // The poll is in flight; its payload predates the SSE event. `createdAt` is fixed for
    // a job's lifetime so it is identical in both — only `updatedAt` separates them, and
    // the poll's is older. Comparing createdAt alone accepted the stale one, and it won
    // simply by arriving last.
    const staleSnapshot = {
      ...mockJobs[0],
      status: "PENDING",
      updatedAt: new Date(Date.now() - 5000).toISOString(),
    };
    let landPoll: () => void = () => {};
    const pollInFlight = new Promise<void>((r) => {
      landPoll = r;
    });

    (safeFetch as Mock).mockImplementation((url: string) => {
      if (url === "/api/jobs") {
        return pollInFlight.then(() => ({
          ok: true,
          json: async () => ({ isPaused: false, jobs: [staleSnapshot] }),
        }));
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    const { rerender } = render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    const subscribeMock = (useNotifications as Mock).mock.results[0].value
      .subscribe;
    const callback = subscribeMock.mock.calls[0][0];

    // SSE arrives first with a fresher snapshot of the same job.
    callback({
      type: "job_update",
      data: JSON.stringify({
        ...mockJobs[0],
        jobId: "job-1",
        status: "PROCESSING",
        updatedAt: new Date().toISOString(),
      }),
    });
    rerender(<QueueManagerWrapper />);

    await waitFor(() => {
      expect(screen.getByText("PROCESSING")).toBeInTheDocument();
    });

    landPoll();
    await pollInFlight;
    rerender(<QueueManagerWrapper />);

    // Must not roll back. Asserting the positive rather than only the absence — a bare
    // queryByText(...).toBeNull() inside waitFor passes on the first tick and can never
    // fail, which is AUDIT-F8 in the Reader tests.
    await waitFor(() => {
      expect(screen.getByText("PROCESSING")).toBeInTheDocument();
    });
    expect(screen.queryByText("PENDING")).toBeNull();
  });

  it("still applies a poll response that is fresher than what is held", async () => {
    // The guard must not wedge the 30s poll shut: same job, newer updatedAt, applies.
    const fresherSnapshot = {
      ...mockJobs[0],
      status: "FAILED",
      error: "API Limit Reached",
      updatedAt: new Date(Date.now() + 5000).toISOString(),
    };
    let landPoll: () => void = () => {};
    const pollInFlight = new Promise<void>((r) => {
      landPoll = r;
    });

    (safeFetch as Mock).mockImplementation((url: string) => {
      if (url === "/api/jobs") {
        return pollInFlight.then(() => ({
          ok: true,
          json: async () => ({ isPaused: false, jobs: [fresherSnapshot] }),
        }));
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    const { rerender } = render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    const subscribeMock = (useNotifications as Mock).mock.results[0].value
      .subscribe;
    const callback = subscribeMock.mock.calls[0][0];

    callback({
      type: "job_update",
      data: JSON.stringify({
        ...mockJobs[0],
        jobId: "job-1",
        status: "PROCESSING",
        updatedAt: new Date().toISOString(),
      }),
    });
    rerender(<QueueManagerWrapper />);

    await waitFor(() => {
      expect(screen.getByText("PROCESSING")).toBeInTheDocument();
    });

    landPoll();
    await pollInFlight;
    rerender(<QueueManagerWrapper />);

    await waitFor(() => {
      expect(screen.getByText("FAILED")).toBeInTheDocument();
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
      // Both rows are finished `qa` jobs, which end the pipeline — so the surviving row
      // reads COMPLETED. This assertion used to look for "TRANSITIONING...", which the old
      // blanket relabel produced for every COMPLETED job; that pinned the bug rather than
      // the pruning this test is actually about.
      const texts = screen.queryAllByText("COMPLETED");
      expect(texts.length).toBe(1);
    });
  });

  it("names the stage a finished job is waiting to be handed to", async () => {
    // One row per pipeline: fetchJobs keys by imageId, so a COMPLETED row means stage N is
    // done and stage N+1 has not been enqueued yet. Mid-chain stages should say what is
    // coming; stages that end the pipeline should not claim anything is.
    const completedAt = new Date(Date.now() - 1000).toISOString();
    const jobAt = (id: string, type: string) => ({
      id,
      type,
      imageId: `img-${id}`,
      status: "COMPLETED",
      payload: JSON.stringify({}),
      error: null,
      attempt: 1,
      maxAttempts: 3,
      createdAt: completedAt,
      updatedAt: completedAt,
    });

    (safeFetch as Mock).mockImplementation((url: string) => {
      if (url === "/api/jobs") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            isPaused: false,
            jobs: [
              jobAt("a", "panel-detection"),
              jobAt("b", "ocr"),
              jobAt("c", "layout"),
              jobAt("d", "translation"),
              jobAt("e", "render"),
              jobAt("f", "qa-re-ocr"),
              jobAt("g", "qa"),
              jobAt("h", "region-redo-tl"),
            ],
          }),
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    render(<QueueManagerWrapper />);
    fireEvent.click(screen.getByTitle("Queue Manager"));

    await waitFor(() => {
      expect(
        screen.getByText("TRANSITIONING → OCR", { exact: false }),
      ).toBeInTheDocument();
    });

    // Each mid-chain stage names its own successor rather than a generic label. Both
    // `layout` and `qa-re-ocr` hand off to translation, hence the count of 2 there.
    const expected: Record<string, number> = {
      "TRANSITIONING → OCR": 1,
      "TRANSITIONING → LAYOUT": 1,
      "TRANSITIONING → TRANSLATION": 2,
      "TRANSITIONING → RENDER": 1,
      "TRANSITIONING → QA": 1,
    };
    for (const [label, count] of Object.entries(expected)) {
      expect(screen.queryAllByText(label)).toHaveLength(count);
    }

    // The terminal stages — a finished `qa` and a one-shot region redo — end the pipeline,
    // so they read COMPLETED and must not claim a successor.
    expect(screen.queryAllByText("COMPLETED")).toHaveLength(2);
    expect(screen.queryAllByText(/UNDEFINED|→\s*$/)).toHaveLength(0);

    // The summary chips group on the coarse label, so the six in-flight rows fold into one.
    expect(screen.getByText("6 Transitioning")).toBeInTheDocument();
    expect(screen.getByText("2 Completed")).toBeInTheDocument();
  });

  // AUDIT-F5 removed the 30s poll, and the 10s eviction of finished jobs was living inside
  // the polled `fetchJobs` — so nothing reaped them any more. A job that completes over SSE
  // has to age out on its own, with no second fetch, or the drawer fills up with finished
  // work until the user clears the queue by hand.
  it("evicts a job that completes over SSE once its grace period elapses, without refetching", async () => {
    vi.useFakeTimers();
    try {
      let emit: ((event: { type: string; data: string }) => void) | null = null;
      (useNotifications as Mock).mockReturnValue({
        subscribe: vi.fn((cb) => {
          emit = cb;
          return () => {};
        }),
      });

      const processing = {
        ...mockJobs[0],
        id: "job-live",
        imageId: "img-live",
        status: "PROCESSING",
      };
      (safeFetch as Mock).mockImplementation((url: string) => {
        if (url === "/api/jobs") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ isPaused: false, jobs: [processing] }),
          });
        }
        return Promise.reject(new Error("Unknown URL"));
      });

      render(<QueueManagerWrapper />);
      fireEvent.click(screen.getByTitle("Queue Manager"));
      await vi.waitFor(() => {
        expect(screen.getByText(/Page 3/i)).toBeInTheDocument();
      });

      const fetchCallsBefore = (safeFetch as Mock).mock.calls.length;

      // The pipeline finishes. This is the only signal the drawer gets — there is no
      // second /api/jobs fetch behind it.
      act(() => {
        emit!({
          type: "job_update",
          data: JSON.stringify({
            ...processing,
            jobId: processing.id,
            status: "COMPLETED",
            updatedAt: new Date().toISOString(),
          }),
        });
      });

      // Still on screen during the grace period — the eviction is deliberately not instant.
      expect(screen.getByText(/Page 3/i)).toBeInTheDocument();

      // Past the 10s grace the row must be gone on its own.
      await act(async () => {
        vi.advanceTimersByTime(20000);
      });

      await vi.waitFor(() => {
        expect(screen.queryByText(/Page 3/i)).toBeNull();
      });

      // And it must not have cost a network round-trip to get there.
      expect((safeFetch as Mock).mock.calls.length).toBe(fetchCallsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
