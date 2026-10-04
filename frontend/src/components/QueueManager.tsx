import React, { useState, useEffect, useCallback, useMemo } from "react";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ChecklistIcon from "@mui/icons-material/Checklist";
import ClearIcon from "@mui/icons-material/Clear";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import { safeFetch } from "../utils";
import { useNotifications } from "./useNotifications";
import { useToast } from "./ToastContext";
import ConfirmModal from "./ConfirmModal";
import { useDependencyLogger } from "../hooks/useDependencyLogger";
import { formatErrorMessage } from "../utils/jobErrorMessage";
import { PipelineStrip } from "./QueueParts";
import {
  formatElapsed,
  stageLabelOf,
  type StripState,
} from "../utils/queueStages";

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

/**
 * Width of a row's right column: three 28 px button slots (retry, pause/resume, remove).
 * Fixed, so every row's strip has the same width; elapsed time sits on the title line.
 */
const ROW_TOOLS_WIDTH = 84;

/** From this many jobs on, the running segment stops pulsing (one CSS animation per row). */
const STRIP_ANIMATION_LIMIT = 100;

/** How long a finished job stays visible before it is swept out of the drawer. */
const COMPLETED_GRACE_MS = 10000;

/** How often the sweep runs. Local state and a clock — deliberately not a fetch. */
const COMPLETED_SWEEP_MS = 2000;

/**
 * A finished job that has outlived its grace period.
 *
 * Only COMPLETED expires: FAILED and PAUSED are states the user has to act on, so they stay
 * until they are retried or cleared. An unparseable `updatedAt` yields `NaN`, which fails the
 * comparison and keeps the job — dropping a row because its timestamp was malformed would
 * lose work from the display for the wrong reason.
 */
const isExpiredCompletion = (job: Pick<Job, "status" | "updatedAt">): boolean =>
  job.status === "COMPLETED" &&
  Date.now() - new Date(job.updatedAt).getTime() > COMPLETED_GRACE_MS;

const pipelineStages = [
  "panel-detection",
  "ocr",
  "layout",
  "translation",
  "render",
  "qa",
];

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

const formatJobType = (type: string) => {
  const map: Record<string, string> = {
    "panel-detection": "Panel detection",
    ocr: "OCR",
    cleanup: "Cleanup",
    translation: "Translation",
    qa: "QA",
    "qa-re-ocr": "QA re-OCR",
    "region-redo": "Region redo",
  };
  return map[type] || type;
};

interface JobLocation {
  chapterPath: string | null;
  pageLabel: string | null;
}

const renderJobLocation = (parsed: ParsedPayload | null): JobLocation => {
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
      // AUDIT-F20: PROCESSING used to share rank 1 with PENDING and COMPLETED, so a job starting
      // work did not move at all — it stayed wherever `createdAt` had put it, which reads from
      // the outside as the queue neither prioritising active items nor updating. It gets its own
      // rank now. The tie between PENDING and COMPLETED is kept deliberately: those two swap as a
      // page finishes, and separating them would make finished rows jump the queue on their way
      // out. FAILED stays last so a stuck row does not push live work down the list.
      //
      // Ranks start at 1, not 0. Both lookups below fall back to 99 for an unrecognised status,
      // and a 0 rank is falsy — so with `PROCESSING: 0` and `||` the running job took the
      // *unknown* rank and sorted below even FAILED, exactly inverting the fix. The `?? 99` is
      // belt and braces; keeping every rank truthy is what actually removes the trap.
      const statusOrder: Record<string, number> = {
        PROCESSING: 1,
        PENDING: 2,
        COMPLETED: 2,
        PAUSED: 3,
        FAILED: 4,
      };

      // Group first, so a job's status changing (e.g. pausing) can never
      // split it away from the rest of its chapter's jobs.
      const groups = new Map<string, Job[]>();
      const groupOrder: string[] = [];
      jobsList.forEach((job) => {
        const parsed = getParsed(job);
        const key =
          renderJobLocation(parsed).chapterPath || `__solo__${job.id}`;
        if (!groups.has(key)) {
          groups.set(key, []);
          groupOrder.push(key);
        }
        groups.get(key)!.push(job);
      });

      const rankGroup = (key: string) => {
        const groupJobs = groups.get(key)!;
        const bestStatus = Math.min(
          ...groupJobs.map((j) => statusOrder[j.status] ?? 99),
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
          const orderA = statusOrder[a.status] ?? 99;
          const orderB = statusOrder[b.status] ?? 99;
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

          const finalPipelines = Array.from(pipelinesMap.values()).filter(
            (p) => activeImageIds.has(p.imageId) && !isExpiredCompletion(p),
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

  // Finished jobs age out of the drawer on a timer, not on a fetch.
  //
  // The grace rule above used to live *only* inside `fetchJobs`, so removing AUDIT-F5's 30s
  // poll silently removed the reaper with it: SSE marks a job COMPLETED but never drops it,
  // and the one eviction that survived keys off a literal notification title, so anything
  // titled differently stayed until the user cleared the queue by hand. This is local state
  // and a clock — no network — so it costs nothing to run while the drawer is open.
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      setJobs((prev) => {
        const kept = prev.filter((p) => !isExpiredCompletion(p));
        return kept.length === prev.length ? prev : kept;
      });
    }, COMPLETED_SWEEP_MS);
    return () => clearInterval(interval);
  }, [token]);

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
   * A finished job used to be relabelled "TRANSITIONING..." even at the end of the pipeline,
   * so a finished `qa` (the whole chapter done) announced itself as mid-flight. Only a stage
   * with a successor reads as a hand-off.
   */
  const getTransitionTarget = (job: Job): string | null =>
    job.status === "COMPLETED" ? nextPipelineStage(job.type) : null;

  type Bucket = "running" | "waiting" | "failed" | "done";
  type Filter = "all" | "running" | "waiting" | "failed";
  const [filter, setFilter] = useState<Filter>("all");
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);

  // A clock for the "in this stage for 3 min" text. Ticks only while the drawer is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!forceOpen) return;
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, [forceOpen]);

  const bucketOf = (job: Job): Bucket => {
    if (job.status === "PROCESSING") return "running";
    if (job.status === "FAILED") return "failed";
    if (job.status === "COMPLETED" && !getTransitionTarget(job)) return "done";
    return "waiting";
  };

  /** What the row says, in words, and how its strip is coloured. */
  const describe = (job: Job): { text: string; state: StripState } => {
    const stage = stageLabelOf(job.type);
    if (job.status === "PROCESSING") return { text: stage, state: "running" };
    if (job.status === "FAILED")
      return { text: `Failed at ${stage}`, state: "failed" };
    if (job.status === "PAUSED" || (isPaused && job.status === "PENDING"))
      return { text: `Paused before ${stage}`, state: "paused" };
    if (job.status === "COMPLETED") {
      const target = getTransitionTarget(job);
      return target
        ? { text: `Waiting for ${stageLabelOf(target)}`, state: "waiting" }
        : { text: "Done", state: "done" };
    }
    return { text: `Waiting for ${stage}`, state: "waiting" };
  };

  const counts = useMemo(() => {
    const c = { running: 0, waiting: 0, failed: 0, done: 0 };
    jobs.forEach((job) => {
      c[bucketOf(job)] += 1;
    });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  const groupSummary = (groupJobs: Job[]) => {
    const c = { running: 0, waiting: 0, failed: 0, done: 0 };
    groupJobs.forEach((job) => {
      c[bucketOf(job)] += 1;
    });
    const parts: string[] = [];
    if (c.running) parts.push(`${c.running} running`);
    if (c.waiting) parts.push(`${c.waiting} waiting`);
    if (c.failed) parts.push(`${c.failed} failed`);
    if (c.done) parts.push(`${c.done} done`);
    return parts.join(", ");
  };

  const statusLine = isPaused
    ? "Paused. Nothing new starts until you resume."
    : jobs.length === 0
      ? "Idle"
      : [
          counts.running && `${counts.running} running`,
          counts.waiting && `${counts.waiting} waiting`,
          counts.failed && `${counts.failed} failed`,
        ]
          .filter(Boolean)
          .join(", ") || "All done";

  const matchesFilter = (job: Job) =>
    filter === "all" ? true : bucketOf(job) === filter;

  const jobGroups = useMemo(() => {
    const result: {
      key: string;
      chapterPath: string | null;
      groupJobs: Job[];
    }[] = [];
    jobs.forEach((job) => {
      const parsed = getParsed(job);
      const { chapterPath } = renderJobLocation(parsed);
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

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: jobs.length },
    { key: "running", label: "Running", count: counts.running },
    { key: "waiting", label: "Waiting", count: counts.waiting },
    { key: "failed", label: "Failed", count: counts.failed },
  ];

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
        slotProps={{
          paper: {
            sx: {
              width: { xs: "100vw", sm: 460 },
              bgcolor: "background.paper",
              backgroundImage: "none",
            },
          },
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {/* Header: what the queue is doing, and the two queue-wide actions. */}
          <Box
            sx={{
              display: "flex",
              alignItems: "flex-start",
              gap: 1,
              px: 2.5,
              pt: 2,
              pb: 1.5,
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="h6"
                component="h2"
                sx={{ fontSize: "1.125rem" }}
              >
                Queue
              </Typography>
              <Typography
                variant="body2"
                sx={{ color: isPaused ? "warning.main" : "text.secondary" }}
              >
                {statusLine}
              </Typography>
            </Box>
            <Button
              size="small"
              variant="outlined"
              onClick={handlePauseResumeQueue}
              aria-label={isPaused ? "Resume Queue" : "Pause Queue"}
              sx={{
                minWidth: { xs: 36, sm: 64 },
                "& .MuiButton-startIcon": {
                  mr: { xs: 0, sm: 1 },
                  ml: { xs: 0, sm: -0.5 },
                },
              }}
              startIcon={
                isPaused ? (
                  <PlayArrowIcon fontSize="small" />
                ) : (
                  <PauseIcon fontSize="small" />
                )
              }
            >
              <Box
                component="span"
                sx={{ display: { xs: "none", sm: "inline" } }}
              >
                {isPaused ? "Resume" : "Pause all"}
              </Box>
            </Button>
            <IconButton
              size="small"
              aria-label="Queue actions"
              aria-haspopup="true"
              onClick={(e) => setMenuAnchor(e.currentTarget)}
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
            <Menu
              anchorEl={menuAnchor}
              open={Boolean(menuAnchor)}
              onClose={() => setMenuAnchor(null)}
            >
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  handleClearQueue();
                }}
              >
                Clear waiting and failed jobs
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  handleForceClearQueue();
                }}
                sx={{ color: "error.main" }}
              >
                Clear everything, including running jobs
              </MenuItem>
            </Menu>
            <IconButton
              size="small"
              onClick={onClose}
              aria-label="Close queue"
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>

          {/* Filters: the counts double as the summary. */}
          <Box
            role="tablist"
            aria-label="Filter jobs"
            sx={{
              display: "flex",
              gap: 0.5,
              px: 2,
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            {filters.map((f) => {
              const active = filter === f.key;
              return (
                <Box
                  key={f.key}
                  component="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={`${f.label} ${f.count}`}
                  onClick={() => setFilter(f.key)}
                  sx={{
                    all: "unset",
                    cursor: "pointer",
                    px: 1,
                    py: 1,
                    fontSize: "0.8125rem",
                    fontWeight: 600,
                    color: active ? "text.primary" : "text.secondary",
                    borderBottom: "2px solid",
                    borderColor: active ? "primary.main" : "transparent",
                    "&:focus-visible": {
                      outline: "2px solid",
                      outlineColor: "primary.main",
                      outlineOffset: -2,
                    },
                  }}
                >
                  {f.label}
                  <Box
                    component="span"
                    sx={{
                      ml: 0.75,
                      color:
                        f.key === "failed" && f.count > 0
                          ? "error.main"
                          : "text.secondary",
                      fontWeight: 500,
                    }}
                  >
                    {f.count}
                  </Box>
                </Box>
              );
            })}
          </Box>

          <Box sx={{ flex: 1, overflowY: "auto" }}>
            {jobs.length === 0 ? (
              <Box sx={{ px: 3, py: 6, textAlign: "center" }}>
                <Typography sx={{ fontWeight: 600 }}>
                  Nothing in the queue
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ color: "text.secondary", mt: 0.5 }}
                >
                  Jobs appear here as soon as you upload pages.
                </Typography>
              </Box>
            ) : (
              jobGroups.map((group) => {
                const visibleJobs = group.groupJobs.filter(matchesFilter);
                if (visibleJobs.length === 0) return null;
                const isCollapsed = group.chapterPath
                  ? collapsedChapters.has(group.key)
                  : false;
                return (
                  <Box
                    key={group.key}
                    component="section"
                  >
                    {group.chapterPath && (
                      <Box
                        component="button"
                        onClick={() => toggleChapterCollapse(group.key)}
                        aria-expanded={!isCollapsed}
                        sx={{
                          all: "unset",
                          boxSizing: "border-box",
                          cursor: "pointer",
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 1,
                          px: 2,
                          py: 1,
                          position: "sticky",
                          top: 0,
                          zIndex: 1,
                          bgcolor: "background.paper",
                          borderBottom: 1,
                          borderColor: "divider",
                          "&:hover": { bgcolor: "action.hover" },
                          "&:focus-visible": {
                            outline: "2px solid",
                            outlineColor: "primary.main",
                            outlineOffset: -2,
                          },
                        }}
                      >
                        <ExpandMoreIcon
                          sx={{
                            fontSize: 18,
                            color: "text.secondary",
                            transition: "transform 0.15s ease",
                            transform: isCollapsed ? "rotate(-90deg)" : "none",
                          }}
                        />
                        <Typography
                          sx={{
                            fontSize: "0.875rem",
                            fontWeight: 600,
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {group.chapterPath}
                        </Typography>
                        <Typography
                          variant="body2"
                          sx={{
                            color: "text.secondary",
                            flexShrink: 0,
                            fontSize: "0.8125rem",
                          }}
                        >
                          {groupSummary(group.groupJobs)}
                        </Typography>
                      </Box>
                    )}
                    {!isCollapsed && (
                      <Box role="list">
                        {visibleJobs.map((job) => {
                          const parsed = getParsed(job);
                          const { pageLabel } = renderJobLocation(parsed);
                          const providerModel = renderProviderModel(
                            job,
                            parsed,
                          );
                          const { text, state } = describe(job);
                          const elapsed =
                            job.status === "PROCESSING" && job.updatedAt
                              ? formatElapsed(job.updatedAt, now)
                              : null;
                          const canPause =
                            job.status === "PENDING" || job.status === "PAUSED";
                          const pauseHint = isPaused
                            ? "The whole queue is paused"
                            : canPause
                              ? job.status === "PAUSED"
                                ? "Resume"
                                : "Pause"
                              : "Only pages waiting to start can be paused";
                          return (
                            <Box
                              key={job.id}
                              role="listitem"
                              aria-label={`${pageLabel ?? formatJobType(job.type)}: ${text}`}
                              sx={{
                                display: "grid",
                                // Fixed tracks: the right column holds three button slots, and
                                // every row has the same three lines (title, stages, details),
                                // so no row is wider or taller than another (review, 2026-10-05).
                                gridTemplateColumns: `1fr ${ROW_TOOLS_WIDTH}px`,
                                gridTemplateRows: "20px 6px 16px",
                                columnGap: 1.5,
                                rowGap: 0.75,
                                alignItems: "center",
                                px: 2.5,
                                py: 1.25,
                                borderBottom: 1,
                                borderColor: "divider",
                              }}
                            >
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "baseline",
                                  gap: 1,
                                  minWidth: 0,
                                }}
                              >
                                <Typography
                                  sx={{
                                    fontSize: "0.875rem",
                                    fontWeight: 600,
                                    flexShrink: 0,
                                  }}
                                >
                                  {pageLabel ?? formatJobType(job.type)}
                                </Typography>
                                <Typography
                                  variant="body2"
                                  sx={{
                                    flex: 1,
                                    minWidth: 0,
                                    color:
                                      state === "failed"
                                        ? "error.main"
                                        : state === "running"
                                          ? "text.primary"
                                          : "text.secondary",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {text}
                                  {isRetryLoopType(job.type) &&
                                    state !== "done" &&
                                    ", retry after QA"}
                                </Typography>
                                {elapsed && (
                                  <Typography
                                    variant="body2"
                                    sx={{
                                      flexShrink: 0,
                                      color: "text.secondary",
                                      whiteSpace: "nowrap",
                                      fontVariantNumeric: "tabular-nums",
                                    }}
                                  >
                                    {elapsed}
                                  </Typography>
                                )}
                              </Box>

                              {/* Three fixed slots, always in place: Retry, Pause/Resume,
                                  Remove. A slot that does not apply stays empty but keeps its
                                  space, so the buttons never move between rows. */}
                              <Box
                                sx={{
                                  gridColumn: 2,
                                  gridRow: "1 / span 3",
                                  display: "grid",
                                  gridTemplateColumns: "repeat(3, 28px)",
                                  justifyContent: "end",
                                  alignItems: "center",
                                }}
                              >
                                <Box>
                                  {job.status === "FAILED" && (
                                    <Tooltip
                                      title="Retry"
                                      describeChild
                                    >
                                      <IconButton
                                        size="small"
                                        aria-label="Retry"
                                        onClick={() => handleRetryJob(job.id)}
                                      >
                                        <RestartAltIcon fontSize="small" />
                                      </IconButton>
                                    </Tooltip>
                                  )}
                                </Box>
                                <Box>
                                  {/* Shown on every page still in the pipeline. A running page,
                                      or one between stages, shows it disabled: the backend can
                                      only pause a job that has not started (#225). */}
                                  {state !== "done" &&
                                    job.status !== "FAILED" && (
                                      <Tooltip
                                        describeChild
                                        title={pauseHint}
                                      >
                                        <span>
                                          <IconButton
                                            size="small"
                                            aria-label={
                                              job.status === "PAUSED"
                                                ? "Resume"
                                                : "Pause"
                                            }
                                            onClick={() =>
                                              handleToggleJobPause(job)
                                            }
                                            disabled={isPaused || !canPause}
                                          >
                                            {job.status === "PAUSED" ? (
                                              <PlayArrowIcon fontSize="small" />
                                            ) : (
                                              <PauseIcon fontSize="small" />
                                            )}
                                          </IconButton>
                                        </span>
                                      </Tooltip>
                                    )}
                                </Box>
                                <Box>
                                  {job.status !== "PROCESSING" && (
                                    <Tooltip
                                      title="Remove from queue"
                                      describeChild
                                    >
                                      <IconButton
                                        size="small"
                                        aria-label="Delete"
                                        onClick={() => handleDeleteJob(job.id)}
                                        sx={{ color: "text.secondary" }}
                                      >
                                        <ClearIcon fontSize="small" />
                                      </IconButton>
                                    </Tooltip>
                                  )}
                                </Box>
                              </Box>

                              <PipelineStrip
                                jobType={job.type}
                                state={state}
                                allDone={state === "done"}
                                retry={isRetryLoopType(job.type)}
                                animate={jobs.length < STRIP_ANIMATION_LIMIT}
                              />

                              {/* One line of details on every row, empty when there are none;
                                  a long error is cut short here and shown whole on hover. */}
                              <Box
                                title={job.error || undefined}
                                sx={{
                                  minWidth: 0,
                                  fontSize: "0.75rem",
                                  lineHeight: "16px",
                                  color: "text.secondary",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  "& > span + span": { ml: 1.5 },
                                }}
                              >
                                {providerModel && <span>{providerModel}</span>}
                                {job.attempt > 1 && (
                                  <span>
                                    Attempt {job.attempt} of {job.maxAttempts}
                                  </span>
                                )}
                                {job.error && (
                                  <Box
                                    component="span"
                                    sx={{ color: "error.main" }}
                                  >
                                    {formatErrorMessage(job.error)}
                                  </Box>
                                )}
                              </Box>
                            </Box>
                          );
                        })}
                      </Box>
                    )}
                  </Box>
                );
              })
            )}
          </Box>

          {/* Legend: what the strip's colours mean. Small, but the strip is new. */}
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 2,
              px: 2.5,
              py: 1.25,
              borderTop: 1,
              borderColor: "divider",
              fontSize: "0.75rem",
              color: "text.secondary",
            }}
          >
            {[
              [
                "Done",
                "color-mix(in srgb, var(--text-muted) 55%, transparent)",
              ],
              ["Running", "var(--primary)"],
              ["Failed", "var(--error)"],
              ["Not started", "var(--bg-chip)"],
            ].map(([label, color]) => (
              <Box
                key={label}
                sx={{ display: "flex", alignItems: "center", gap: 0.75 }}
              >
                <Box
                  sx={{
                    width: 14,
                    height: 6,
                    borderRadius: "2px",
                    bgcolor: color,
                  }}
                />
                {label}
              </Box>
            ))}
            <Box component="span">
              Panels, OCR, cleanup, translation, render, QA
            </Box>
          </Box>
        </Box>
      </Drawer>
    </>
  );
};

export default QueueManager;
