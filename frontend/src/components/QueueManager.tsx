import React, { useState, useRef, useEffect, useCallback } from "react";
import { safeFetch } from "../utils";
import { useNotifications } from "./useNotifications";
import ConfirmModal from "./ConfirmModal";

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

const IconPlay = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const IconPause = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);

const IconRetry = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

const IconDelete = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const getPipelineProgress = (jobType: string) => {
  const stages = ["panel-detection", "ocr", "layout", "translation", "render", "qa"];
  let currentIndex = stages.indexOf(jobType);
  
  // If it's not a standard pipeline stage, don't show the dots (or map it loosely)
  if (currentIndex === -1) {
    if (jobType === "qa-re-ocr") currentIndex = 1;
    else if (jobType === "region-redo") currentIndex = 1;
    else return null;
  }
  
  return (
    <div style={{ display: "flex", gap: "3px", marginTop: "4px", marginBottom: "4px" }}>
      {stages.map((stage, i) => (
        <div 
          key={i} 
          style={{ 
            width: "6px", 
            height: "6px", 
            borderRadius: "50%", 
            backgroundColor: i <= currentIndex ? "var(--primary-color, #2196f3)" : "var(--border-color, #ccc)",
            opacity: i === currentIndex ? 1 : i < currentIndex ? 0.7 : 0.3
          }} 
          title={stage}
        />
      ))}
    </div>
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
      <div
        style={{
          fontSize: "11px",
          color: "var(--text-muted)",
          marginTop: "2px",
          display: "flex",
          flexDirection: "column",
          gap: "2px",
        }}
      >
        {location && (
          <span style={{ fontWeight: "500", color: "var(--primary, #ed2553)" }}>
            {location}
          </span>
        )}
        {providerModel && (
          <span>
            Using:{" "}
            <strong style={{ color: "var(--text-main)" }}>
              {providerModel}
            </strong>
          </span>
        )}
      </div>
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
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { subscribe } = useNotifications();

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
      COMPLETED: 1, // Keep completed items on the same level (transitioning between stages)
      PAUSED: 2,
      FAILED: 3,
    };
    return [...jobsList].sort((a, b) => {
      const orderA = statusOrder[a.status] || 99;
      const orderB = statusOrder[b.status] || 99;
      if (orderA !== orderB) return orderA - orderB;
      // Stable sort purely by pipeline creation time
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
          
          // Seed with existing to preserve pipeline-level createdAt
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
            // Filter out completed pipelines lingering in API response (> 10s old)
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

  // Initial fetch and 30s heartbeat
  useEffect(() => {
    if (!token) return;
    const timeout = setTimeout(() => {
      fetchJobs();
    }, 0);
    const interval = setInterval(fetchJobs, 30000); // Heartbeat
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [token, fetchJobs]);

  // Handle SSE events
  useEffect(() => {
    if (!token) return;
    
    return subscribe((event) => {
      if (event.type === "job_update") {
        try {
          const data = JSON.parse(event.data);
          setJobs((prev) => {
            const imageId = data.imageId;
            if (!imageId) return prev; // Ignore un-groupable jobs

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
                  createdAt: existing.createdAt // preserve pipeline creation time
                };
              }
            } else {
              // New pipeline tracking
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
          // If we receive the global processing complete notification, gracefully remove the pipeline from UI
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

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleDropdown = () => setIsOpen(!isOpen);

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
          await safeFetch("/api/jobs/clear", {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          // Optimistic UI update
          setJobs((prev) => prev.filter((j) => j.status === "PROCESSING"));
        } catch (err) {
          console.error("Failed to clear queue", err);
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
      // Optimistic update
      setIsPaused(!isPaused);
    } catch (err) {
      console.error("Failed to toggle queue state", err);
    }
  };

  const handleRetryJob = async (jobId: string) => {
    if (!token) return;
    try {
      // Optimistic update
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
      
      // Optimistic update
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
      // Optimistic update
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
      await safeFetch(`/api/jobs/${jobId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.error("Failed to delete job", err);
    }
  };

  const getDisplayStatus = (status: string) => {
    if (isPaused && status === "PENDING") return "PAUSED";
    if (status === "COMPLETED") return "TRANSITIONING...";
    return status;
  };

  const getStatusColor = (status: string) => {
    if (isPaused && status === "PENDING") return "#ffc107";
    switch (status) {
      case "PROCESSING":
        return "#4caf50";
      case "PENDING":
        return "#2196f3";
      case "COMPLETED":
        return "#2196f3"; // Visual consistency for transitioning pipelines
      case "FAILED":
        return "#f44336";
      case "PAUSED":
        return "#ffc107";
      default:
        return "#9e9e9e";
    }
  };

  return (
    <div
      className="queue-manager"
      ref={dropdownRef}
      style={{ position: "relative", display: "flex", alignItems: "center" }}
    >
      <button
        className="theme-toggle-btn"
        onClick={toggleDropdown}
        style={{ position: "relative" }}
        title="Queue Manager"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
        {jobs.length > 0 && (
          <span
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              backgroundColor: "#2196f3",
              color: "white",
              borderRadius: "50%",
              width: "14px",
              height: "14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "9px",
              fontWeight: "bold",
              lineHeight: 1,
            }}
          >
            {jobs.length}
          </span>
        )}
      </button>

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        isDangerous={confirmModal.isDangerous}
        onConfirm={confirmModal.action}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, isOpen: false }))}
      />

      {isOpen && (
        <div
          className="glass"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "12px",
            width: "360px",
            maxHeight: "450px",
            overflowY: "auto",
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            color: "var(--text-main)",
          }}
        >
          <div
            style={{
              padding: "12px",
              borderBottom: "1px solid var(--border-color)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <h3
              style={{ margin: 0, fontSize: "16px", color: "var(--text-main)" }}
            >
              Queue Manager
            </h3>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={handleClearQueue}
                className="btn btn-secondary"
                style={{
                  fontSize: "12px",
                  padding: "4px 8px",
                  borderColor: "#f44336",
                  color: "#f44336",
                }}
              >
                Clear Queue
              </button>
              <button
                onClick={handlePauseResumeQueue}
                className="btn btn-secondary"
                style={{ fontSize: "12px", padding: "4px 8px" }}
              >
                {isPaused ? <><IconPlay /> Resume</> : <><IconPause /> Pause</>}
              </button>
            </div>
          </div>

          {jobs.length === 0 ? (
            <div
              style={{
                padding: "24px",
                textAlign: "center",
                color: "var(--text-muted)",
              }}
            >
              No active jobs
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {jobs.map((job) => (
                <li
                  key={job.id}
                  style={{
                    padding: "12px",
                    borderBottom: "1px solid var(--border-color)",
                    backgroundColor: "transparent",
                    display: "flex",
                    gap: "12px",
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      width: "12px",
                      height: "12px",
                      borderRadius: "50%",
                      backgroundColor: getStatusColor(job.status),
                      marginTop: "4px",
                      boxShadow: `0 0 8px ${getStatusColor(job.status)}66`
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontWeight: "bold",
                        fontSize: "14px",
                        marginBottom: "2px",
                        color: "var(--text-main)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center"
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <span>
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
                        </span>
                        {getPipelineProgress(job.type)}
                      </div>
                      <span style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: "normal" }}>
                        Attempt {job.attempt}/{job.maxAttempts}
                      </span>
                    </div>
                    {renderJobDetails(job)}
                    <div
                      style={{
                        fontSize: "11px",
                        color: getStatusColor(job.status),
                        marginTop: "4px",
                        marginBottom: "4px",
                        fontWeight: "600"
                      }}
                    >
                      {getDisplayStatus(job.status)}
                    </div>
                    {job.error && (
                      <div
                        style={{
                          fontSize: "11px",
                          color: "#f44336",
                          marginBottom: "4px",
                          wordBreak: "break-all",
                        }}
                        title={job.error}
                      >
                        {formatErrorMessage(job.error, job.status)}
                      </div>
                    )}
                    <div
                      style={{ display: "flex", gap: "8px", marginTop: "8px", justifyContent: "flex-end" }}
                    >
                      {job.status === "FAILED" && (
                        <>
                          <button
                            onClick={() => handleRetryJob(job.id)}
                            className="btn btn-secondary"
                            style={{ fontSize: "11px", padding: "4px 8px", display: "flex", alignItems: "center", gap: "4px" }}
                            title="Retry"
                          >
                            <IconRetry />
                          </button>
                        </>
                      )}
                      {(job.status === "PENDING" || job.status === "PAUSED") && (
                        <>
                          <button
                            onClick={() => handleToggleJobPause(job)}
                            className="btn btn-secondary"
                            style={{ fontSize: "11px", padding: "4px 8px", display: "flex", alignItems: "center", gap: "4px" }}
                            title={job.status === "PAUSED" ? "Resume" : "Pause"}
                          >
                            {job.status === "PAUSED" ? <IconPlay /> : <IconPause />}
                          </button>
                        </>
                      )}
                      {job.status !== "PROCESSING" && (
                        <button
                          onClick={() => handleDeleteJob(job.id)}
                          className="btn btn-secondary"
                          style={{
                            fontSize: "11px",
                            padding: "4px 8px",
                            borderColor: "#f44336",
                            color: "#f44336",
                            display: "flex",
                            alignItems: "center",
                            gap: "4px"
                          }}
                          title="Delete"
                        >
                          <IconDelete />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
