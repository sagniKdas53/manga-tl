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
                animation: isCurrent
                  ? "queuePulse 1.3s ease-in-out infinite"
                  : "none",
                "@keyframes queuePulse": {
                  "0%, 100%": { opacity: 1 },
                  "50%": { opacity: 0.3 },
                },
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

const renderJobLocation = (job: Job): JobLocation => {
  if (!job.payload) return { chapterPath: null, pageLabel: null };
  try {
    const payload = JSON.parse(job.payload);
    const parts: string[] = [];
    if (payload.seriesTitle) parts.push(payload.seriesTitle);
    if (payload.chapterTitle) {
      parts.push(`${payload.chapterTitle} (Ch.${payload.chapterNumber})`);
    } else if (payload.chapterNumber !== undefined) {
      parts.push(`Ch.${payload.chapterNumber}`);
    }
    return {
      chapterPath: parts.length ? parts.join(" › ") : null,
      pageLabel:
        payload.pageNumber !== undefined ? `Page ${payload.pageNumber}` : null,
    };
  } catch {
    return { chapterPath: null, pageLabel: null };
  }
};

const renderProviderModel = (job: Job) => {
  if (!job.payload) return null;
  try {
    const payload = JSON.parse(job.payload);
    let providerModel = "";

    if (job.type === "ocr") {
      if (payload.ocrProvider) {
        providerModel = `${payload.ocrProvider} / ${payload.ocrModel || "default"}`;
      }
    } else if (job.type === "translation") {
      if (payload.tlProvider) {
        providerModel = `${payload.tlProvider} / ${payload.tlModel || "default"}`;
      }
    } else if (job.type === "qa") {
      const model =
        payload.qaMode === "vlm" ? payload.qaVlmModel : payload.qaLlmModel;
      if (payload.qaProvider) {
        providerModel = `${payload.qaProvider} / ${model || "default"}`;
      }
    } else if (job.type === "qa-re-ocr") {
      if (payload.ocrProvider) {
        providerModel = `${payload.ocrProvider} / ${payload.ocrModel || "default"}`;
      }
    } else if (job.type === "region-redo") {
      providerModel = `Redo: ${payload.redoType || "manual"}`;
    }

    return providerModel || null;
  } catch {
    return null;
  }
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

  const sortJobs = (jobsList: Job[]) => {
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
      const key = renderJobLocation(job).chapterPath || `__solo__${job.id}`;
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
      if (ra.bestStatus !== rb.bestStatus) return ra.bestStatus - rb.bestStatus;
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
  };

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
            if (
              !existing ||
              new Date(job.createdAt) >= new Date(existing.jobCreatedAt)
            ) {
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
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const timeout = setTimeout(() => fetchJobs(), 0);
    const interval = setInterval(fetchJobs, 30000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
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
        setJobs((prev) => prev.filter((j) => j.status === "PROCESSING"));
      }
    });
  }, [token, subscribe]);

  const handleClearQueue = () => {
    setConfirmModal({
      isOpen: true,
      title: "Clear Queue",
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

  const getDisplayStatus = (status: string) => {
    if (isPaused && status === "PENDING") return "PAUSED";
    if (status === "COMPLETED") return "TRANSITIONING...";
    return status;
  };

  const getJobStatusColor = (job: Job) => {
    if (isPaused && job.status === "PENDING") return statusColor.PAUSED;
    return statusColor[job.status] || "#9e9e9e";
  };

  const statusSummary = jobs.reduce(
    (acc, job) => {
      const label = getDisplayStatus(job.status).replace("...", "");
      const color = getJobStatusColor(job);
      const existing = acc.find((s) => s.label === label);
      if (existing) existing.count += 1;
      else acc.push({ label, color, count: 1 });
      return acc;
    },
    [] as { label: string; color: string; count: number }[],
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
      const { chapterPath } = renderJobLocation(job);
      const key = chapterPath || `__solo__${job.id}`;
      const last = result[result.length - 1];
      if (last && last.key === key) {
        last.groupJobs.push(job);
      } else {
        result.push({ key, chapterPath, groupJobs: [job] });
      }
    });
    return result;
  }, [jobs]);

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
              <Tooltip title="Clear Queue">
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
            >
              <TableHead>
                <TableRow>
                  <TableCell sx={{ px: 2 }}>Job</TableCell>
                  <TableCell sx={{ px: 2 }}>Model &amp; Status</TableCell>
                  <TableCell
                    sx={{ px: 2, width: 96 }}
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
                          const { pageLabel } = renderJobLocation(job);
                          const providerModel = renderProviderModel(job);
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
                                sx={{ px: 2, py: 1.25, verticalAlign: "top" }}
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
                                  maxWidth: 230,
                                  verticalAlign: "top",
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
                                    label={getDisplayStatus(job.status)}
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
