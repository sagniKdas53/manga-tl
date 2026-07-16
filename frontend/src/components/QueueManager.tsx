import React, { useState, useEffect, useCallback } from "react";
import { safeFetch } from "../utils";
import { useNotifications } from "./useNotifications";
import { useToast } from "./ToastContext";
import ConfirmModal from "./ConfirmModal";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import Popover from "@mui/material/Popover";
import Badge from "@mui/material/Badge";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import ButtonGroup from "@mui/material/ButtonGroup";

import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import ReplayIcon from "@mui/icons-material/Replay";
import DeleteIcon from "@mui/icons-material/Delete";
import FormatListBulletedIcon from "@mui/icons-material/FormatListBulleted";

interface Job {
  id: string; // Tracks the current job's ID
  traceId?: string;
  type: string;
  imageId: string;
  status: "PENDING" | "PROCESSING" | "FAILED" | "PAUSED" | "COMPLETED" | "DELETED";
  payload: string | null;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: string; // Pipeline start time
  jobCreatedAt: string; // Current job start time
  updatedAt: string;
}

const getPipelineProgress = (jobType: string) => {
  const stages = ["panel-detection", "ocr", "layout", "translation", "render", "qa"];
  let currentIndex = stages.indexOf(jobType);
  
  if (currentIndex === -1) {
    if (jobType === "qa-re-ocr") currentIndex = 1;
    else if (jobType === "region-redo") currentIndex = 1;
    else return null;
  }
  
  return (
    <Stack direction="row" spacing={0.5} mt={0.5} mb={0.5}>
      {stages.map((stage, i) => (
        <Box 
          key={i} 
          sx={{ 
            width: 6, 
            height: 6, 
            borderRadius: "50%", 
            bgcolor: i <= currentIndex ? "primary.main" : "divider",
            opacity: i === currentIndex ? 1 : i < currentIndex ? 0.7 : 0.3
          }} 
          title={stage}
        />
      ))}
    </Stack>
  );
};

const renderJobDetails = (job: Job) => {
  if (!job.payload) return null;
  try {
    const payload = JSON.parse(job.payload);
    let providerModel = "";
    let location = "";

    if (
      payload.chapterNumber !== undefined &&
      payload.pageNumber !== undefined
    ) {
      const seriesContext = payload.seriesTitle
        ? `${payload.seriesTitle} - `
        : "";
      const chapterContext = payload.chapterTitle
        ? `${payload.chapterTitle} (Ch.${payload.chapterNumber})`
        : `Ch.${payload.chapterNumber}`;
      location = `${seriesContext}${chapterContext} › Page ${payload.pageNumber}`;
    }

    if (job.type === "ocr") {
      if (payload.ocrProvider) {
        providerModel = `${payload.ocrProvider} / ${payload.ocrModel || "default"}`;
      }
    } else if (job.type === "translation") {
      if (payload.tlProvider) {
        providerModel = `${payload.tlProvider} / ${payload.tlModel || "default"}`;
      }
    } else if (job.type === "qa") {
      if (payload.qaMode === "none") {
        providerModel = `Skipped / none`;
      } else {
        const model =
          payload.qaMode === "vlm" ? payload.qaVlmModel : payload.qaLlmModel;
        if (payload.qaProvider) {
          providerModel = `${payload.qaProvider} / ${model || "default"}`;
        }
      }
    } else if (job.type === "qa-re-ocr") {
      if (payload.ocrProvider) {
        providerModel = `${payload.ocrProvider} / ${payload.ocrModel || "default"}`;
      }
    } else if (job.type === "region-redo") {
      providerModel = `Redo: ${payload.redoType || "manual"}`;
    }

    return (
      <Stack spacing={0.25} mt={0.25}>
        {location && (
          <Typography variant="caption" color="primary.main" fontWeight={500}>
            {location}
          </Typography>
        )}
        {providerModel && (
          <Typography variant="caption" color="text.secondary">
            Using:{" "}
            <Box component="strong" color="text.primary">
              {providerModel}
            </Box>
          </Typography>
        )}
      </Stack>
    );
  } catch {
    return null;
  }
};

const formatErrorMessage = (error: string, status: string) => {
  if (!error) return "";
  const prefix = status === "FAILED" ? "Job failed: " : "Error: ";

  if (
    error.includes("Max retries exceeded") ||
    error.includes("NameResolutionError") ||
    error.includes("Failed to resolve") ||
    error.includes("ConnectionError")
  ) {
    return prefix + "Could not connect to internal service (Network Error).";
  }
  if (
    error.includes("500 Server Error") ||
    error.includes("500 Internal Server Error")
  ) {
    return prefix + "Internal API returned 500 error.";
  }

  let cleanError = error;
  const match = error.match(/([a-zA-Z]+Error):\s*(.+)/);
  if (match) {
    cleanError = `${match[1]}: ${match[2]}`;
  }

  if (cleanError.length > 100) {
    cleanError = cleanError.substring(0, 100) + "...";
  }
  return cleanError;
};

export const QueueManager: React.FC<{ token: string | null }> = ({ token }) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const { subscribe } = useNotifications();
  const { showToast } = useToast();

  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);

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
          const newJobsList: Array<Omit<Job, 'jobCreatedAt'>> = data.jobs;
          const pipelinesMap = new Map<string, Job>();
          
          prevJobs.forEach(p => pipelinesMap.set(p.imageId, p));
          
          newJobsList.forEach(job => {
            const existing = pipelinesMap.get(job.imageId);
            if (!existing || new Date(job.createdAt) >= new Date(existing.jobCreatedAt)) {
              pipelinesMap.set(job.imageId, {
                ...job,
                jobCreatedAt: job.createdAt,
                createdAt: existing ? existing.createdAt : job.createdAt
              });
            }
          });
          
          const activeImageIds = new Set(newJobsList.map((j) => j.imageId));
          const now = Date.now();
          
          const finalPipelines = Array.from(pipelinesMap.values()).filter((p) => {
            if (!activeImageIds.has(p.imageId)) return false;
            if (p.status === "COMPLETED") {
              const updatedAt = new Date(p.updatedAt).getTime();
              if (now - updatedAt > 10000) return false;
            }
            return true;
          });
          
          return sortJobs(finalPipelines);
        });
      }
    } catch (err) {
      console.error("Failed to fetch jobs", err);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const timeout = setTimeout(() => {
      fetchJobs();
    }, 0);
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
              const isNewerJob = data.createdAt && new Date(data.createdAt) > new Date(existing.jobCreatedAt);
              const isSameJobButNewer = isSameJob && (!existing.updatedAt || !data.updatedAt || new Date(data.updatedAt) >= new Date(existing.updatedAt));

              if (isNewerJob || isSameJobButNewer) {
                updated[existingIndex] = {
                  ...existing,
                  ...data,
                  id: dataId,
                  jobCreatedAt: data.createdAt || existing.jobCreatedAt,
                  createdAt: existing.createdAt 
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
          if (data.type === "SUCCESS" && data.title === "Page Processing Complete" && data.imageId) {
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


  const toggleDropdown = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(anchorEl ? null : event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);
  const id = open ? "queue-popover" : undefined;

  const handleClearQueue = () => {
    setConfirmModal({
      isOpen: true,
      title: "Clear Queue",
      message: "Are you sure you want to clear the queue? This will delete all pending, paused, and failed jobs.",
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
      }
    });
  };

  const handlePauseResumeQueue = () => {
    if (isPaused) {
      performPauseResumeQueue();
    } else {
      setConfirmModal({
        isOpen: true,
        title: "Pause Queue",
        message: "Are you sure you want to pause the queue? All pending jobs will be paused.",
        isDangerous: true,
        action: () => {
          setConfirmModal((prev) => ({ ...prev, isOpen: false }));
          performPauseResumeQueue();
        }
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
            j.id === jobId ? { ...j, status: "PENDING", attempt: 1 } : j
          )
        )
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
      const endpoint = job.status === "PAUSED" ? `/api/jobs/${job.id}/resume` : `/api/jobs/${job.id}/pause`;
      const newStatus: Job["status"] = job.status === "PAUSED" ? "PENDING" : "PAUSED";
      
      setJobs((prev) =>
        sortJobs(prev.map((j) => (j.id === job.id ? { ...j, status: newStatus } : j)))
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

  const getStatusColor = (status: string) => {
    if (isPaused && status === "PENDING") return "warning";
    switch (status) {
      case "PROCESSING":
        return "success";
      case "PENDING":
        return "info";
      case "COMPLETED":
        return "info"; 
      case "FAILED":
        return "error";
      case "PAUSED":
        return "warning";
      default:
        return "default";
    }
  };

  return (
    <Box display="flex" alignItems="center">
      <IconButton
        aria-describedby={id}
        onClick={toggleDropdown}
        color="inherit"
        title="Queue Manager"
      >
        <Badge badgeContent={jobs.length} color="primary">
          <FormatListBulletedIcon />
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

      <Popover
        id={id}
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "right",
        }}
        transformOrigin={{
          vertical: "top",
          horizontal: "right",
        }}
        slotProps={{
          paper: {
            sx: {
              width: 380,
              maxHeight: 500,
              display: "flex",
              flexDirection: "column",
            },
          },
        }}
      >
        <Box
          sx={{
            p: 2,
            borderBottom: 1,
            borderColor: "divider",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            bgcolor: "background.paper",
          }}
        >
          <Typography variant="h6" component="h3">
            Queue Manager
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              color="error"
              onClick={handleClearQueue}
            >
              Clear
            </Button>
            <Button
              size="small"
              onClick={handlePauseResumeQueue}
              startIcon={isPaused ? <PlayArrowIcon /> : <PauseIcon />}
            >
              {isPaused ? "Resume" : "Pause"}
            </Button>
          </Stack>
        </Box>

        {jobs.length === 0 ? (
          <Box p={4} textAlign="center">
            <Typography color="text.secondary">No active jobs</Typography>
          </Box>
        ) : (
          <List sx={{ p: 0, flex: 1, overflowY: "auto" }}>
            {jobs.map((job) => (
              <React.Fragment key={job.id}>
                <ListItem sx={{ flexDirection: "column", alignItems: "stretch", py: 2 }}>
                  <Box display="flex" gap={2} alignItems="flex-start">
                    <Box mt={0.5}>
                      <Badge
                        variant="dot"
                        color={getStatusColor(job.status) as any}
                        sx={{
                          '& .MuiBadge-badge': {
                            transform: 'scale(1.2) translate(50%, -50%)',
                            boxShadow: `0 0 8px currentColor`
                          }
                        }}
                      />
                    </Box>
                    <Box flex={1}>
                      <Box display="flex" justifyContent="space-between" alignItems="center" mb={0.5}>
                        <Box>
                          <Typography variant="subtitle2" fontWeight={600}>
                            {job.type === "panel-detection"
                              ? "Panel Detection"
                              : job.type === "ocr"
                                ? "OCR Processing"
                                : job.type === "translation"
                                  ? "Translation"
                                  : job.type === "qa"
                                    ? "Quality Assurance"
                                    : job.type === "qa-re-ocr"
                                      ? "QA Re-OCR"
                                      : job.type === "region-redo"
                                        ? "Region Redo"
                                        : job.type.toUpperCase()}
                          </Typography>
                          {getPipelineProgress(job.type)}
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                          Attempt {job.attempt}/{job.maxAttempts}
                        </Typography>
                      </Box>
                      
                      {renderJobDetails(job)}
                      
                      <Box mt={1}>
                        <Chip
                          label={getDisplayStatus(job.status)}
                          color={getStatusColor(job.status) as any}
                          size="small"
                          sx={{ height: 20, fontSize: '0.65rem', fontWeight: 600 }}
                        />
                      </Box>

                      {job.error && (
                        <Typography variant="caption" color="error.main" display="block" mt={0.5} sx={{ wordBreak: 'break-word' }}>
                          {formatErrorMessage(job.error, job.status)}
                        </Typography>
                      )}

                      <Box display="flex" justifyContent="flex-end" gap={1} mt={1}>
                        {job.status === "FAILED" && (
                          <Tooltip title="Retry">
                            <IconButton size="small" onClick={() => handleRetryJob(job.id)}>
                              <ReplayIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                        {(job.status === "PENDING" || job.status === "PAUSED") && (
                          <Tooltip title={isPaused ? "Queue is globally paused" : (job.status === "PAUSED" ? "Resume" : "Pause")}>
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => handleToggleJobPause(job)}
                                disabled={isPaused}
                              >
                                {(job.status === "PAUSED" || isPaused) ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
                              </IconButton>
                            </span>
                          </Tooltip>
                        )}
                        {job.status !== "PROCESSING" && (
                          <Tooltip title="Delete">
                            <IconButton size="small" color="error" onClick={() => handleDeleteJob(job.id)}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Box>
                    </Box>
                  </Box>
                </ListItem>
                <Divider component="li" />
              </React.Fragment>
            ))}
          </List>
        )}
      </Popover>
    </Box>
  );
};
