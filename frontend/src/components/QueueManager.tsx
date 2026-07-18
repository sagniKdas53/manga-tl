import React, { useState, useEffect, useCallback } from "react";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
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
import { safeFetch } from "../utils";
import { useNotifications } from "./useNotifications";
import { useToast } from "./ToastContext";
import ConfirmModal from "./ConfirmModal";

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

const getPipelineProgress = (jobType: string) => {
  let currentIndex = pipelineStages.indexOf(jobType);
  if (currentIndex === -1) {
    if (jobType === "qa-re-ocr") currentIndex = 1;
    else if (jobType === "region-redo") currentIndex = 1;
    else return null;
  }
  return (
    <Box sx={{ display: "flex", gap: "3px", mt: 0.5, mb: 0.5 }}>
      {pipelineStages.map((stage, i) => (
        <Box
          key={i}
          sx={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: i <= currentIndex ? "primary.main" : "divider",
            opacity: i === currentIndex ? 1 : i < currentIndex ? 0.7 : 0.3,
          }}
          title={stage}
        />
      ))}
    </Box>
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

const renderJobLocation = (job: Job) => {
  if (!job.payload) return null;
  try {
    const payload = JSON.parse(job.payload);
    const parts: string[] = [];
    if (payload.seriesTitle) parts.push(payload.seriesTitle);
    if (payload.chapterTitle) {
      parts.push(`${payload.chapterTitle} (Ch.${payload.chapterNumber})`);
    } else if (payload.chapterNumber !== undefined) {
      parts.push(`Ch.${payload.chapterNumber}`);
    }
    if (payload.pageNumber !== undefined)
      parts.push(`Page ${payload.pageNumber}`);
    return parts.length ? parts.join(" › ") : null;
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
    action: () => { },
  });

  const sortJobs = (jobsList: Job[]) => {
    const statusOrder: Record<string, number> = {
      PROCESSING: 1,
      PENDING: 1,
      COMPLETED: 1,
      PAUSED: 2,
      FAILED: 3,
    };
    return [...jobsList].sort((a, b) => {
      const orderA = statusOrder[a.status] || 99;
      const orderB = statusOrder[b.status] || 99;
      if (orderA !== orderB) return orderA - orderB;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
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

  return (
    <>
      <Badge
        badgeContent={jobs.length}
        color="primary"
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'left',
        }}
        invisible={jobs.length === 0}
      >
        <IconButton
          onClick={onRequestOpen}
          color="inherit"
          size="small"
          title="Queue Manager"
        >
          <ChecklistIcon />
        </IconButton>
      </Badge>

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
            <Typography
              variant="h6"
              sx={{ fontSize: "16px", fontWeight: 600 }}
            >
              Queue Manager
            </Typography>
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
                  <TableCell sx={{ px: 2 }}>Context</TableCell>
                  <TableCell
                    sx={{ px: 2 }}
                    align="center"
                  >
                    Status
                  </TableCell>
                  <TableCell
                    sx={{ px: 2 }}
                    align="right"
                  >
                    Actions
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {jobs.map((job) => {
                  const color = getJobStatusColor(job);
                  const location = renderJobLocation(job);
                  return (
                    <TableRow
                      key={job.id}
                      sx={{
                        "&:last-child td, &:last-child th": { borderBottom: 0 },
                      }}
                    >
                      <TableCell sx={{ px: 2 }}>
                        <Box
                          sx={{ display: "flex", alignItems: "center", gap: 1 }}
                        >
                          <Box
                            sx={{
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              backgroundColor: color,
                              boxShadow: `0 0 6px ${color}66`,
                              flexShrink: 0,
                            }}
                          />
                          <Box>
                            <Typography
                              variant="body2"
                              sx={{ fontWeight: 600, fontSize: "13px" }}
                            >
                              {formatJobType(job.type)}
                            </Typography>
                            {getPipelineProgress(job.type)}
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell sx={{ px: 2 }}>
                        {location && (
                          <Typography
                            variant="caption"
                            sx={{
                              display: "block",
                              color: "text.secondary",
                              fontSize: "11px",
                            }}
                          >
                            {location}
                          </Typography>
                        )}
                        <Typography
                          variant="caption"
                          sx={{ color: "text.disabled", fontSize: "10px" }}
                        >
                          Attempt {job.attempt}/{job.maxAttempts}
                        </Typography>
                      </TableCell>
                      <TableCell
                        sx={{ px: 2 }}
                        align="center"
                      >
                        <Typography
                          variant="caption"
                          sx={{
                            color,
                            fontWeight: 600,
                            fontSize: "11px",
                            textTransform: "uppercase",
                          }}
                        >
                          {getDisplayStatus(job.status)}
                        </Typography>
                        {job.error && (
                          <Tooltip title={job.error}>
                            <Typography
                              variant="caption"
                              sx={{
                                display: "block",
                                color: "error.main",
                                fontSize: "10px",
                                mt: 0.25,
                              }}
                            >
                              {formatErrorMessage(job.error)}
                            </Typography>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell
                        sx={{ px: 2 }}
                        align="right"
                      >
                        <Box
                          sx={{
                            display: "flex",
                            gap: 0.5,
                            justifyContent: "flex-end",
                          }}
                        >
                          {job.status === "FAILED" && (
                            <Tooltip title="Retry">
                              <IconButton
                                size="small"
                                onClick={() => handleRetryJob(job.id)}
                              >
                                <RestartAltIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          )}
                          {(job.status === "PENDING" ||
                            job.status === "PAUSED") && (
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
                                  onClick={() => handleToggleJobPause(job)}
                                  disabled={isPaused}
                                >
                                  {job.status === "PAUSED" || isPaused ? (
                                    <PlayArrowIcon fontSize="small" />
                                  ) : (
                                    <PauseIcon fontSize="small" />
                                  )}
                                </IconButton>
                              </Tooltip>
                            )}
                          {job.status !== "PROCESSING" && (
                            <Tooltip title="Delete">
                              <IconButton
                                size="small"
                                color="error"
                                onClick={() => handleDeleteJob(job.id)}
                              >
                                <ClearIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          )}
                        </Box>
                      </TableCell>
                    </TableRow>
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
