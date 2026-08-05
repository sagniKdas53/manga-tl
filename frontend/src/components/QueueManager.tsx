import React, { useState, useEffect, useCallback, useMemo } from "react";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ChecklistIcon from "@mui/icons-material/Checklist";
import ClearAllIcon from "@mui/icons-material/ClearAll";
import ClearIcon from "@mui/icons-material/Clear";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LoopIcon from "@mui/icons-material/Loop";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PlaylistRemoveIcon from "@mui/icons-material/PlaylistRemove";
import { safeFetch } from "../utils";
import { useNotifications } from "./useNotifications";
import { useToast } from "./ToastContext";
import ConfirmModal from "./ConfirmModal";
import { useDependencyLogger } from "../hooks/useDependencyLogger";

interface Job {
  id: string;
  traceId?: string;
  type: string;
  imageId: string;
  status:
    "PENDING" | "PROCESSING" | "FAILED" | "PAUSED" | "COMPLETED" | "DELETED";
  payload: string | null;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  jobCreatedAt: string;
  updatedAt: string;
}

/** Cached result of JSON.parse(job.payload) — keyed by job id */
interface ParsedPayload {
  seriesTitle?: string;
  chapterTitle?: string;
  chapterNumber?: number;
  pageNumber?: number;
  ocrProvider?: string;
  ocrModel?: string;
  tlProvider?: string;
  tlModel?: string;
  qaProvider?: string;
  qaMode?: string;
  qaVlmModel?: string;
  qaLlmModel?: string;
  redoType?: string;
  [key: string]: unknown;
}

const statusColor: Record<string, string> = {
  PROCESSING: "#4caf50",
  PENDING: "#2196f3",
  COMPLETED: "#2196f3",
  FAILED: "#f44336",
  PAUSED: "#ffc107",
};

const pipelineStages = [
  "panel-detection",
  "ocr",
  "layout",
  "translation",
  "render",
  "qa",
];

const stageLabels: Record<string, string> = {
  "panel-detection": "Panel Detection",
  ocr: "OCR",
  layout: "Layout",
  translation: "Translation",
  render: "Render",
  qa: "QA",
};

/**
 * The stage the backend hands off to once `type` finishes, or null when nothing follows.
 *
 * A queue row is a *pipeline* projection, not a job row: `fetchJobs` keys by `imageId` and
 * keeps only the newest job per image, so stage N+1 replaces stage N in place. That is why
 * "transitioning" stays a derived display value rather than becoming a real job status — it
 * describes the gap between two rows, and there is no single row to store it on. It is also
 * a pure function of the stage, so storing it would buy nothing while adding a second write
 * to clear it, which is one more way for a row to get stuck.
 *
 * The linear chain is already spelled out in `pipelineStages`, so this reads the successor
 * off that rather than restating it. Anything outside the chain ends the pipeline as far as
 * the queue can tell: `qa` is last and branches on its own verdict, and the one-shot manual
 * `region-redo-*` jobs have no successor at all.
 *
 * One known imprecision: `render` only enqueues `qa` when the page carries no manual edits.
 * A hand-edited page therefore reads "TRANSITIONING → QA" for the ten seconds before the row
 * is pruned. Telling those apart needs the edit flag, which the queue payload does not carry.
 */
const nextPipelineStage = (type: string): string | null => {
  // The QA retry loop re-runs OCR over a few regions and then rejoins at translation, so it
  // is a detour rather than a position in the chain.
  if (type === "qa-re-ocr") return "translation";
  const index = pipelineStages.indexOf(type);
  if (index === -1) return null;
  return pipelineStages[index + 1] ?? null;
};

const isRetryLoopType = (jobType: string) =>
  jobType === "qa-re-ocr" || jobType === "region-redo";

const PipelineStepper: React.FC<{
  jobType: string;
  jobStatus: string;
  color: string;
}> = ({ jobType, jobStatus, color }) => {
  const isRetry = isRetryLoopType(jobType);
  let currentIndex = pipelineStages.indexOf(jobType);
  if (currentIndex === -1 && isRetry) currentIndex = 1; // re-ocr loops back to the OCR stage

  const isComplete = jobStatus === "COMPLETED";
  const isQaStage = jobType === "qa";

  let stageName = "";
  if (isComplete) {
    stageName = "All stages complete";
  } else if (isRetry) {
    stageName = `QA retry loop · re-running ${stageLabels[pipelineStages[currentIndex]]} after a failed QA pass`;
  } else if (isQaStage) {
    stageName = `Stage ${currentIndex + 1} of ${pipelineStages.length} · QA — can loop back through re-OCR up to 2× on failure`;
  } else if (currentIndex >= 0) {
    stageName = `Stage ${currentIndex + 1} of ${pipelineStages.length} · ${stageLabels[pipelineStages[currentIndex]]}`;
  }

  return (
    <Tooltip
      title={stageName}
      placement="top"
    >
      <Box sx={{ display: "flex", gap: 0.5, mt: 0.75, maxWidth: 140 }}>
        {pipelineStages.map((stage, i) => {
          const isDone = isComplete || (currentIndex >= 0 && i < currentIndex);
          const isCurrent = !isComplete && i === currentIndex;
          return (
            <Box
              key={stage}
              sx={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                backgroundColor:
                  isDone || isCurrent ? color : "action.disabledBackground",
                backgroundImage:
                  isCurrent && isRetry
                    ? `repeating-linear-gradient(45deg, ${color} 0px, ${color} 2px, transparent 2px, transparent 4px)`
                    : "none",
                opacity: isDone ? 0.4 : 1,
              }}
            />
          );
        })}
      </Box>
    </Tooltip>
  );
};

const formatJobType = (type: string) => {
  const map: Record<string, string> = {
    "panel-detection": "Panel Detection",
    ocr: "OCR Processing",
    translation: "Translation",
    qa: "Quality Assurance",
    "qa-re-ocr": "QA Re-OCR",
    "region-redo": "Region Redo",
  };
  return map[type] || type.toUpperCase();
};

interface JobLocation {
  chapterPath: string | null;
  pageLabel: string | null;
}

const renderJobLocation = (
  job: Job,
  parsed: ParsedPayload | null,
): JobLocation => {
  if (!parsed) return { chapterPath: null, pageLabel: null };
  const parts: string[] = [];
  if (parsed.seriesTitle) parts.push(parsed.seriesTitle);
  if (parsed.chapterTitle) {
    parts.push(`${parsed.chapterTitle} (Ch.${parsed.chapterNumber})`);
  } else if (parsed.chapterNumber !== undefined) {
    parts.push(`Ch.${parsed.chapterNumber}`);
  }
  return {
    chapterPath: parts.length ? parts.join(" › ") : null,
    pageLabel:
      parsed.pageNumber !== undefined ? `Page ${parsed.pageNumber}` : null,
  };
};

const renderProviderModel = (job: Job, parsed: ParsedPayload | null) => {
  if (!parsed) return null;
  let providerModel = "";

  if (job.type === "ocr") {
    if (parsed.ocrProvider) {
      providerModel = `${parsed.ocrProvider} / ${parsed.ocrModel || "default"}`;
    }
  } else if (job.type === "translation") {
    if (parsed.tlProvider) {
      providerModel = `${parsed.tlProvider} / ${parsed.tlModel || "default"}`;
    }
  } else if (job.type === "qa") {
    const model =
      parsed.qaMode === "vlm" ? parsed.qaVlmModel : parsed.qaLlmModel;
    if (parsed.qaProvider) {
      providerModel = `${parsed.qaProvider} / ${model || "default"}`;
    }
  } else if (job.type === "qa-re-ocr") {
    if (parsed.ocrProvider) {
      providerModel = `${parsed.ocrProvider} / ${parsed.ocrModel || "default"}`;
    }
  } else if (job.type === "region-redo") {
    providerModel = `Redo: ${parsed.redoType || "manual"}`;
  }

  return providerModel || null;
};

const formatErrorMessage = (error: string) => {
  if (!error) return "";
  if (
    error.includes("Max retries exceeded") ||
    error.includes("NameResolutionError") ||
    error.includes("Failed to resolve") ||
    error.includes("ConnectionError")
  ) {
    return "Could not connect to internal service (Network Error).";
  }
  if (
    error.includes("500 Server Error") ||
    error.includes("500 Internal Server Error")
  ) {
    return "Internal API returned 500 error.";
  }
  if (
    error.includes("402") &&
    (error.includes("Payment Required") || error.includes("Insufficient Quota"))
  ) {
    return "Provider Error (402): Out of credits or payment required.";
  }
  if (error.includes("404") && error.includes("Not Found")) {
    return "Provider Error (404): Resource or model not found.";
  }
  if (
    error.includes("401") ||
    error.includes("Unauthorized") ||
    error.includes("AuthenticationError")
  ) {
    return "Provider Error (401): Invalid API key or unauthorized.";
  }
  const match = error.match(/([a-zA-Z]+Error):\s*(.+)/);
  if (match) return `${match[1]}: ${match[2].substring(0, 100)}`;
  return error.length > 100 ? error.substring(0, 100) + "..." : error;
};

interface QueueManagerProps {
  token: string | null;
  forceOpen: boolean;
  onRequestOpen: () => void;
  onClose: () => void;
}

const parsedPayloadCache = new Map<string, ParsedPayload>();
const MAX_PARSED_PAYLOAD_CACHE = 500;

export const QueueManager: React.FC<QueueManagerProps> = ({
  token,
  forceOpen,
  onRequestOpen,
  onClose,
}) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [collapsedChapters, setCollapsedChapters] = useState<Set<string>>(
    new Set(),
  );
  const { subscribe } = useNotifications();
  const { showToast } = useToast();

  const getParsed = useCallback((job: Job): ParsedPayload | null => {
    if (!job.payload) return null;
    const cached = parsedPayloadCache.get(job.payload);
    if (cached) return cached;
    try {
      const parsed = JSON.parse(job.payload) as ParsedPayload;
      if (parsedPayloadCache.size >= MAX_PARSED_PAYLOAD_CACHE) {
        parsedPayloadCache.clear();
      }
      parsedPayloadCache.set(job.payload, parsed);
      return parsed;
    } catch {
      return null;
    }
  }, []);

  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    isDangerous: boolean;
    action: () => void;
  }>({
    isOpen: false,
    title: "",
    message: "",
    isDangerous: false,
    action: () => {},
  });

  useDependencyLogger(
    {
      forceOpen,
      isPaused,
      jobsLength: jobs.length,
      confirmModalOpen: confirmModal.isOpen,
    },
    "QueueManager",
  );

  const sortJobs = useCallback(
    (jobsList: Job[]) => {
      const statusOrder: Record<string, number> = {
        PROCESSING: 1,
        PENDING: 1,
        COMPLETED: 1,
        PAUSED: 2,
        FAILED: 3,
      };

      // Group first, so a job's status changing (e.g. pausing) can never
      // split it away from the rest of its chapter's jobs.
      const groups = new Map<string, Job[]>();
      const groupOrder: string[] = [];
      jobsList.forEach((job) => {
        const parsed = getParsed(job);
        const key =
          renderJobLocation(job, parsed).chapterPath || `__solo__${job.id}`;
        if (!groups.has(key)) {
          groups.set(key, []);
          groupOrder.push(key);
        }
        groups.get(key)!.push(job);
      });

      const rankGroup = (key: string) => {
        const groupJobs = groups.get(key)!;
        const bestStatus = Math.min(
          ...groupJobs.map((j) => statusOrder[j.status] || 99),
        );
        const earliestCreated = Math.min(
          ...groupJobs.map((j) => new Date(j.createdAt).getTime()),
        );
        return { bestStatus, earliestCreated };
      };

      const sortedKeys = [...groupOrder].sort((a, b) => {
        const ra = rankGroup(a);
        const rb = rankGroup(b);
        if (ra.bestStatus !== rb.bestStatus)
          return ra.bestStatus - rb.bestStatus;
        return ra.earliestCreated - rb.earliestCreated;
      });

      return sortedKeys.flatMap((key) =>
        [...groups.get(key)!].sort((a, b) => {
          const orderA = statusOrder[a.status] || 99;
          const orderB = statusOrder[b.status] || 99;
          if (orderA !== orderB) return orderA - orderB;
          return (
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        }),
      );
    },
    [getParsed],
  );

  const fetchJobs = useCallback(async () => {
    if (!token) return;
    try {
      const res = await safeFetch("/api/jobs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setIsPaused(data.isPaused);

        setJobs((prevJobs) => {
          const pipelinesMap = new Map<string, Job>();
          prevJobs.forEach((p) => pipelinesMap.set(p.imageId, p));

          const newJobsList: Array<Omit<Job, "jobCreatedAt">> = data.jobs;
          newJobsList.forEach((job) => {
            const existing = pipelinesMap.get(job.imageId);

            // A fetch response can land after an SSE job_update that already carried a
            // newer status for the same job. `createdAt` is fixed for the lifetime of a
            // job, so comparing it alone cannot tell "same job, fresher" from "same job,
            // staler" — it accepted both, and the stale poll won by arriving last. Use
            // the same rule the SSE handler uses: a strictly newer job replaces, and the
            // same job only replaces when its snapshot is at least as fresh.
            const isNewerJob =
              !!job.createdAt &&
              new Date(job.createdAt) > new Date(existing?.jobCreatedAt ?? 0);
            const isSameJobButNewer =
              !!existing &&
              job.id === existing.id &&
              (!existing.updatedAt ||
                !job.updatedAt ||
                new Date(job.updatedAt) >= new Date(existing.updatedAt));

            if (!existing || isNewerJob || isSameJobButNewer) {
              pipelinesMap.set(job.imageId, {
                ...job,
                jobCreatedAt: job.createdAt,
                createdAt: existing ? existing.createdAt : job.createdAt,
              });
            }
          });

          const activeImageIds = new Set(newJobsList.map((j) => j.imageId));
          const now = Date.now();

          const finalPipelines = Array.from(pipelinesMap.values()).filter(
            (p) => {
              if (!activeImageIds.has(p.imageId)) return false;
              if (p.status === "COMPLETED") {
                const updatedAt = new Date(p.updatedAt).getTime();
                if (now - updatedAt > 10000) return false;
              }
              return true;
            },
          );

          return sortJobs(finalPipelines);
        });
      }
    } catch (err) {
      console.error("Failed to fetch jobs", err);
    }
  }, [token, sortJobs]);

  // One fetch to seed the list; `job_update` over SSE keeps it current from there.
  //
  // AUDIT-F5: this used to also poll every 30s. That poll existed to paper over SSE dropping
  // silently, which AUDIT-F3 fixed — the stream now reconnects with jittered backoff and
  // resubscribes on wake. Polling on top of a working push feed cost every open tab two requests
  // a minute for as long as it stayed open, almost always to learn nothing had changed.
  useEffect(() => {
    if (!token) return;
    const timeout = setTimeout(() => fetchJobs(), 0);
    return () => clearTimeout(timeout);
  }, [token, fetchJobs]);

  useEffect(() => {
    if (!token) return;
    return subscribe((event) => {
      if (event.type === "job_update") {
        try {
          const data = JSON.parse(event.data);
          setJobs((prev) => {
            const imageId = data.imageId;
            if (!imageId) return prev;

            if (data.status === "DELETED") {
              return prev.filter((p) => p.imageId !== imageId);
            }

            const existingIndex = prev.findIndex((p) => p.imageId === imageId);
            const updated = [...prev];

            if (existingIndex !== -1) {
              const existing = updated[existingIndex];
              const dataId = data.jobId || data.id;
              const isSameJob = dataId === existing.id;
              const isNewerJob =
                data.createdAt &&
                new Date(data.createdAt) > new Date(existing.jobCreatedAt);
              const isSameJobButNewer =
                isSameJob &&
                (!existing.updatedAt ||
                  !data.updatedAt ||
                  new Date(data.updatedAt) >= new Date(existing.updatedAt));

              if (isNewerJob || isSameJobButNewer) {
                updated[existingIndex] = {
                  ...existing,
                  ...data,
                  id: dataId,
                  jobCreatedAt: data.createdAt || existing.jobCreatedAt,
                  createdAt: existing.createdAt,
                };
              }
            } else {
              updated.push({
                ...data,
                id: data.jobId || data.id,
                jobCreatedAt: data.createdAt || new Date().toISOString(),
                createdAt: data.createdAt || new Date().toISOString(),
              });
            }

            return sortJobs(updated);
          });
        } catch (e) {
          console.error("Failed to parse job_update", e);
        }
      } else if (event.type === "notification") {
        try {
          const data = JSON.parse(event.data);
          if (
            data.type === "SUCCESS" &&
            data.title === "Page Processing Complete" &&
            data.imageId
          ) {
            setJobs((prev) => prev.filter((p) => p.imageId !== data.imageId));
          }
        } catch (e) {
          console.error("Failed to parse notification", e);
        }
      } else if (event.type === "queue_paused") {
        setIsPaused(true);
      } else if (event.type === "queue_resumed") {
        setIsPaused(false);
      } else if (event.type === "queue_cleared") {
        try {
          const data = JSON.parse(event.data);
          if (data?.force === true) {
            setJobs([]);
          } else {
            setJobs((prev) => prev.filter((j) => j.status === "PROCESSING"));
          }
        } catch {
          setJobs((prev) => prev.filter((j) => j.status === "PROCESSING"));
        }
      }
    });
  }, [token, subscribe, sortJobs]);

  const handleClearQueue = () => {
    setConfirmModal({
      isOpen: true,
      title: "Clear Pending/Failed Jobs",
      message:
        "Are you sure you want to clear the queue? This will delete all pending, paused, and failed jobs.",
      isDangerous: true,
      action: async () => {
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
        if (!token) return;
        try {
          const res = await safeFetch("/api/jobs/clear", {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            setJobs((prev) => prev.filter((j) => j.status === "PROCESSING"));
            showToast("Queue cleared successfully", "success");
          } else if (res.status === 403) {
            showToast("You don't have permission to clear the queue.", "error");
          } else {
            showToast("Failed to clear queue", "error");
          }
        } catch (err) {
          console.error("Failed to clear queue", err);
          showToast("Error clearing queue", "error");
        }
      },
    });
  };

  const handleForceClearQueue = () => {
    setConfirmModal({
      isOpen: true,
      title: "Force Clear Queue",
      message:
        "Are you sure you want to immediately clear ALL jobs, including those currently running? This action cannot be undone.",
      isDangerous: true,
      action: async () => {
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
        if (!token) return;
        try {
          const res = await safeFetch("/api/jobs/clear?force=true", {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            setJobs([]);
            showToast("Queue force cleared successfully", "success");
          } else if (res.status === 403) {
            showToast(
              "You don't have permission to force clear the queue.",
              "error",
            );
          } else {
            showToast("Failed to force clear queue", "error");
          }
        } catch (err) {
          console.error("Failed to force clear queue", err);
          showToast("Error force clearing queue", "error");
        }
      },
    });
  };

  const handlePauseResumeQueue = () => {
    if (isPaused) {
      performPauseResumeQueue();
    } else {
      setConfirmModal({
        isOpen: true,
        title: "Pause Queue",
        message:
          "Are you sure you want to pause the queue? All pending jobs will be paused.",
        isDangerous: true,
        action: () => {
          setConfirmModal((prev) => ({ ...prev, isOpen: false }));
          performPauseResumeQueue();
        },
      });
    }
  };

  const performPauseResumeQueue = async () => {
    if (!token) return;
    try {
      const endpoint = isPaused ? "/api/jobs/resume" : "/api/jobs/pause";
      await safeFetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setIsPaused(!isPaused);
    } catch (err) {
      console.error("Failed to toggle queue state", err);
    }
  };

  const handleRetryJob = async (jobId: string) => {
    if (!token) return;
    try {
      setJobs((prev) =>
        sortJobs(
          prev.map((j) =>
            j.id === jobId ? { ...j, status: "PENDING", attempt: 1 } : j,
          ),
        ),
      );
      await safeFetch(`/api/jobs/${jobId}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.error("Failed to retry job", err);
    }
  };

  const handleToggleJobPause = async (job: Job) => {
    if (!token) return;
    try {
      const endpoint =
        job.status === "PAUSED"
          ? `/api/jobs/${job.id}/resume`
          : `/api/jobs/${job.id}/pause`;
      const newStatus: Job["status"] =
        job.status === "PAUSED" ? "PENDING" : "PAUSED";
      setJobs((prev) =>
        sortJobs(
          prev.map((j) => (j.id === job.id ? { ...j, status: newStatus } : j)),
        ),
      );
      await safeFetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.error("Failed to toggle job pause", err);
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    if (!token) return;
    try {
      const res = await safeFetch(`/api/jobs/${jobId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        showToast("Job deleted successfully", "success");
      } else if (res.status === 403) {
        showToast("You don't have permission to delete this job.", "error");
      } else {
        showToast("Failed to delete job", "error");
      }
    } catch (err) {
      console.error("Failed to delete job", err);
      showToast("Error deleting job", "error");
    }
  };

  /**
   * The stage this row is waiting to be handed to, or null when nothing follows.
   *
   * The previous rule relabelled *every* COMPLETED job as "TRANSITIONING...", which made the
   * end of a pipeline unreadable: a finished `qa` — the whole chapter done — announced itself
   * as mid-flight for the ten seconds before the row was pruned, as did the one-shot
   * `region-redo-*` jobs that nothing follows.
   */
  const getTransitionTarget = (job: Job): string | null =>
    job.status === "COMPLETED" ? nextPipelineStage(job.type) : null;

  /** Coarse label for the summary chips, which group rows by state. */
  const getSummaryLabel = (job: Job): string => {
    if (isPaused && job.status === "PENDING") return "PAUSED";
    return getTransitionTarget(job) ? "TRANSITIONING" : job.status;
  };

  /** Per-row label: the summary label, plus the stage actually being waited on. */
  const getDisplayStatus = (job: Job): string => {
    const target = getTransitionTarget(job);
    if (!target) return getSummaryLabel(job);
    // stageLabels carries the human spelling, so this reads "PANEL DETECTION" rather than
    // "PANEL-DETECTION"; upper-cased to sit alongside PENDING/PROCESSING in the same chip.
    return `TRANSITIONING → ${(stageLabels[target] ?? target).toUpperCase()}`;
  };

  const getJobStatusColor = (job: Job) => {
    if (isPaused && job.status === "PENDING") return statusColor.PAUSED;
    return statusColor[job.status] || "#9e9e9e";
  };

  const statusSummary = useMemo(
    () =>
      jobs.reduce(
        (acc, job) => {
          const label = getSummaryLabel(job);
          const color = getJobStatusColor(job);
          const existing = acc.find((s) => s.label === label);
          if (existing) existing.count += 1;
          else acc.push({ label, color, count: 1 });
          return acc;
        },
        [] as { label: string; color: string; count: number }[],
      ),
    // getSummaryLabel and getJobStatusColor are redeclared every render; listing them would
    // defeat the memo entirely. Must be `next-line` rather than `line` -- Prettier splits the
    // dependency array onto its own line, which silently moved a trailing directive off it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs, isPaused],
  );

  // jobs is already sorted so that a chapter's jobs are always contiguous;
  // this just folds consecutive same-chapter jobs into groups for rendering.
  const jobGroups = useMemo(() => {
    const result: {
      key: string;
      chapterPath: string | null;
      groupJobs: Job[];
    }[] = [];
    jobs.forEach((job) => {
      const parsed = getParsed(job);
      const { chapterPath } = renderJobLocation(job, parsed);
      const key = chapterPath || `__solo__${job.id}`;
      const last = result[result.length - 1];
      if (last && last.key === key) {
        last.groupJobs.push(job);
      } else {
        result.push({ key, chapterPath, groupJobs: [job] });
      }
    });
    return result;
  }, [jobs, getParsed]);

  const toggleChapterCollapse = (key: string) => {
    setCollapsedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <IconButton
        onClick={onRequestOpen}
        color="inherit"
        size="small"
        aria-label="Queue Manager"
        title="Queue Manager"
      >
        <Badge
          badgeContent={jobs.length}
          color="primary"
          invisible={jobs.length === 0}
        >
          <ChecklistIcon />
        </Badge>
      </IconButton>

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        isDangerous={confirmModal.isDangerous}
        onConfirm={confirmModal.action}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, isOpen: false }))}
      />

      <Drawer
        anchor="right"
        open={forceOpen}
        onClose={onClose}
        slotProps={{ paper: { sx: { width: 520 } } }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              px: 2,
              py: 1,
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography
                variant="h6"
                sx={{ fontSize: "16px", fontWeight: 600 }}
              >
                Queue Manager
              </Typography>
              <Tooltip
                title="QA can fail and loop back through re-OCR → translate → render → QA, up to 2 retries (14 queued jobs worst case, 17 in hybrid QA mode). Rows with a striped bar are part of that retry loop, not fresh forward progress."
                placement="bottom-start"
              >
                <InfoOutlinedIcon
                  sx={{ fontSize: 15, color: "text.disabled", cursor: "help" }}
                />
              </Tooltip>
            </Box>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Tooltip title="Force Clear Queue">
                <IconButton
                  size="small"
                  onClick={handleForceClearQueue}
                >
                  <PlaylistRemoveIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Clear Pending/Failed Jobs">
                <IconButton
                  size="small"
                  onClick={handleClearQueue}
                >
                  <ClearAllIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={isPaused ? "Resume Queue" : "Pause Queue"}>
                <IconButton
                  size="small"
                  onClick={handlePauseResumeQueue}
                >
                  {isPaused ? (
                    <PlayArrowIcon fontSize="small" />
                  ) : (
                    <PauseIcon fontSize="small" />
                  )}
                </IconButton>
              </Tooltip>
              <Tooltip title="Close">
                <IconButton
                  size="small"
                  onClick={onClose}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>

          {jobs.length > 0 && (
            <Box
              sx={{
                display: "flex",
                gap: 0.75,
                flexWrap: "wrap",
                px: 2,
                py: 1,
                borderBottom: 1,
                borderColor: "divider",
                backgroundColor: "action.hover",
              }}
            >
              {statusSummary.map((s) => (
                <Chip
                  key={s.label}
                  size="small"
                  label={`${s.count} ${s.label.charAt(0)}${s.label.slice(1).toLowerCase()}`}
                  sx={{
                    height: 22,
                    fontSize: "11px",
                    fontWeight: 600,
                    color: s.color,
                    backgroundColor: `${s.color}1A`,
                    border: `1px solid ${s.color}40`,
                  }}
                />
              ))}
            </Box>
          )}

          {jobs.length === 0 ? (
            <Box
              sx={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "text.secondary",
              }}
            >
              No active jobs
            </Box>
          ) : (
            <Table
              size="small"
              stickyHeader
              sx={{ tableLayout: "fixed" }}
            >
              <TableHead>
                <TableRow>
                  <TableCell sx={{ px: 2, width: "45%" }}>Job</TableCell>
                  <TableCell sx={{ px: 2, width: "40%" }}>
                    Model &amp; Status
                  </TableCell>
                  <TableCell
                    sx={{ px: 2, width: "15%" }}
                    align="right"
                  >
                    Actions
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {jobGroups.map((group) => {
                  const isCollapsed = group.chapterPath
                    ? collapsedChapters.has(group.key)
                    : false;
                  return (
                    <React.Fragment key={group.key}>
                      {group.chapterPath && (
                        <TableRow
                          onClick={() => toggleChapterCollapse(group.key)}
                          sx={{
                            cursor: "pointer",
                            "&:hover": { backgroundColor: "action.selected" },
                          }}
                        >
                          <TableCell
                            colSpan={3}
                            sx={{
                              px: 1,
                              py: 0.5,
                              backgroundColor: "action.hover",
                              borderBottom: 0,
                            }}
                          >
                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "center",
                                gap: 0.5,
                              }}
                            >
                              <ExpandMoreIcon
                                sx={{
                                  fontSize: 16,
                                  color: "text.secondary",
                                  transition: "transform 0.15s ease",
                                  transform: isCollapsed
                                    ? "rotate(-90deg)"
                                    : "rotate(0deg)",
                                }}
                              />
                              <Typography
                                variant="caption"
                                sx={{
                                  fontWeight: 600,
                                  color: "text.secondary",
                                  fontSize: "10.5px",
                                  letterSpacing: 0.2,
                                }}
                              >
                                {group.chapterPath}
                              </Typography>
                              {isCollapsed && (
                                <Typography
                                  variant="caption"
                                  sx={{
                                    color: "text.disabled",
                                    fontSize: "10px",
                                  }}
                                >
                                  · {group.groupJobs.length} job
                                  {group.groupJobs.length !== 1 ? "s" : ""}
                                </Typography>
                              )}
                            </Box>
                          </TableCell>
                        </TableRow>
                      )}
                      {!isCollapsed &&
                        group.groupJobs.map((job) => {
                          const color = getJobStatusColor(job);
                          const parsed = getParsed(job);
                          const { pageLabel } = renderJobLocation(job, parsed);
                          const providerModel = renderProviderModel(
                            job,
                            parsed,
                          );
                          const isRetry = isRetryLoopType(job.type);

                          return (
                            <TableRow
                              key={job.id}
                              sx={{
                                "&:last-child td, &:last-child th": {
                                  borderBottom: 0,
                                },
                              }}
                            >
                              <TableCell
                                sx={{
                                  px: 2,
                                  py: 1.25,
                                  verticalAlign: "top",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                <Box
                                  sx={{
                                    display: "flex",
                                    alignItems: "flex-start",
                                    gap: 1,
                                  }}
                                >
                                  <Box
                                    sx={{
                                      width: 8,
                                      height: 8,
                                      borderRadius: "50%",
                                      backgroundColor: color,
                                      boxShadow: `0 0 6px ${color}66`,
                                      flexShrink: 0,
                                      mt: 0.4,
                                    }}
                                  />
                                  <Box sx={{ minWidth: 0 }}>
                                    <Box
                                      sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 0.5,
                                      }}
                                    >
                                      <Typography
                                        variant="body2"
                                        sx={{
                                          fontWeight: 600,
                                          fontSize: "13px",
                                        }}
                                      >
                                        {formatJobType(job.type)}
                                        {pageLabel && (
                                          <Box
                                            component="span"
                                            sx={{
                                              color: "text.secondary",
                                              fontWeight: 400,
                                            }}
                                          >
                                            {" "}
                                            · {pageLabel}
                                          </Box>
                                        )}
                                      </Typography>
                                      {isRetry && (
                                        <Tooltip title="Part of the QA retry loop, re-running after a failed QA pass">
                                          <LoopIcon
                                            sx={{
                                              fontSize: 13,
                                              color: "text.disabled",
                                            }}
                                          />
                                        </Tooltip>
                                      )}
                                    </Box>
                                    <PipelineStepper
                                      jobType={job.type}
                                      jobStatus={job.status}
                                      color={color}
                                    />
                                  </Box>
                                </Box>
                              </TableCell>
                              <TableCell
                                sx={{
                                  px: 2,
                                  py: 1.25,
                                  verticalAlign: "top",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                <Box sx={{ minHeight: 16 }}>
                                  {providerModel ? (
                                    <Tooltip title={providerModel}>
                                      <Typography
                                        variant="caption"
                                        sx={{
                                          display: "block",
                                          color: "text.primary",
                                          fontSize: "11px",
                                          fontWeight: 500,
                                          whiteSpace: "nowrap",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                        }}
                                      >
                                        {providerModel}
                                      </Typography>
                                    </Tooltip>
                                  ) : (
                                    <Typography
                                      variant="caption"
                                      sx={{
                                        display: "block",
                                        color: "text.disabled",
                                        fontSize: "11px",
                                      }}
                                    >
                                      —
                                    </Typography>
                                  )}
                                </Box>
                                <Box
                                  sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 1,
                                    mt: 0.5,
                                    flexWrap: "wrap",
                                  }}
                                >
                                  <Chip
                                    label={getDisplayStatus(job)}
                                    size="small"
                                    sx={{
                                      height: 20,
                                      fontSize: "10px",
                                      fontWeight: 700,
                                      letterSpacing: 0.2,
                                      color,
                                      backgroundColor: `${color}1A`,
                                      border: `1px solid ${color}55`,
                                      "& .MuiChip-label": { px: 1 },
                                    }}
                                  />
                                  {job.attempt > 1 && (
                                    <Typography
                                      variant="caption"
                                      sx={{
                                        color: "text.disabled",
                                        fontSize: "10px",
                                      }}
                                    >
                                      Attempt {job.attempt}/{job.maxAttempts}
                                    </Typography>
                                  )}
                                  {job.updatedAt && (
                                    <Typography
                                      variant="caption"
                                      sx={{
                                        color: "text.disabled",
                                        fontSize: "10px",
                                      }}
                                    >
                                      {new Date(
                                        job.updatedAt,
                                      ).toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </Typography>
                                  )}
                                </Box>
                                <Box sx={{ minHeight: 14, mt: 0.25 }}>
                                  {job.error && (
                                    <Tooltip title={job.error}>
                                      <Typography
                                        variant="caption"
                                        sx={{
                                          display: "block",
                                          color: "error.main",
                                          fontSize: "10px",
                                        }}
                                      >
                                        {formatErrorMessage(job.error)}
                                      </Typography>
                                    </Tooltip>
                                  )}
                                </Box>
                              </TableCell>
                              <TableCell
                                sx={{ px: 2, py: 1.25, verticalAlign: "top" }}
                                align="right"
                              >
                                <Box
                                  sx={{
                                    display: "flex",
                                    gap: 0.5,
                                    justifyContent: "flex-end",
                                  }}
                                >
                                  <Box
                                    sx={{
                                      visibility:
                                        job.status === "FAILED"
                                          ? "visible"
                                          : "hidden",
                                      width: 28,
                                      height: 28,
                                    }}
                                  >
                                    <Tooltip title="Retry">
                                      <IconButton
                                        size="small"
                                        onClick={() => handleRetryJob(job.id)}
                                      >
                                        <RestartAltIcon fontSize="small" />
                                      </IconButton>
                                    </Tooltip>
                                  </Box>
                                  <Box
                                    sx={{
                                      visibility:
                                        job.status === "PENDING" ||
                                        job.status === "PAUSED"
                                          ? "visible"
                                          : "hidden",
                                      width: 28,
                                      height: 28,
                                    }}
                                  >
                                    <Tooltip
                                      title={
                                        isPaused
                                          ? "Queue is globally paused"
                                          : job.status === "PAUSED"
                                            ? "Resume"
                                            : "Pause"
                                      }
                                    >
                                      <IconButton
                                        size="small"
                                        onClick={() =>
                                          handleToggleJobPause(job)
                                        }
                                        disabled={isPaused}
                                      >
                                        {job.status === "PAUSED" || isPaused ? (
                                          <PlayArrowIcon fontSize="small" />
                                        ) : (
                                          <PauseIcon fontSize="small" />
                                        )}
                                      </IconButton>
                                    </Tooltip>
                                  </Box>
                                  <Box
                                    sx={{
                                      visibility:
                                        job.status !== "PROCESSING"
                                          ? "visible"
                                          : "hidden",
                                      width: 28,
                                      height: 28,
                                    }}
                                  >
                                    <Tooltip title="Delete">
                                      <IconButton
                                        size="small"
                                        color="error"
                                        onClick={() => handleDeleteJob(job.id)}
                                      >
                                        <ClearIcon fontSize="small" />
                                      </IconButton>
                                    </Tooltip>
                                  </Box>
                                </Box>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Box>
      </Drawer>
    </>
  );
};

export default QueueManager;
