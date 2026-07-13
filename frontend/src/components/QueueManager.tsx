import React, { useState, useRef, useEffect, useCallback } from "react";
import { safeFetch } from "../utils";

interface Job {
  id: string;
  type: string;
  imageId: string;
  status: "PENDING" | "PROCESSING" | "FAILED" | "PAUSED";
  payload: string | null;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

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

  const fetchJobs = useCallback(async () => {
    if (!token) return;
    try {
      const res = await safeFetch("/api/jobs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        // Move failed jobs to bottom
        data.sort((a: Job, b: Job) => {
          if (a.status === "FAILED" && b.status !== "FAILED") return 1;
          if (a.status !== "FAILED" && b.status === "FAILED") return -1;
          return (
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        });
        setJobs(data);
      }

      const statusRes = await safeFetch("/api/jobs/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setIsPaused(statusData.isPaused);
      }
    } catch (err) {
      console.error("Failed to fetch jobs", err);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;

    // Initial fetch via setTimeout to avoid calling state updates synchronously inside effect
    const timeout = setTimeout(() => {
      fetchJobs();
    }, 0);

    // Setup interval for continuous polling
    const interval = setInterval(fetchJobs, 3000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [token, fetchJobs]);

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

  const handlePauseResumeQueue = async () => {
    if (!token) return;
    try {
      const endpoint = isPaused ? "/api/jobs/resume" : "/api/jobs/pause";
      await safeFetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setIsPaused(!isPaused);
      fetchJobs();
    } catch (err) {
      console.error("Failed to toggle queue state", err);
    }
  };

  const handleClearQueue = async () => {
    if (!token) return;
    if (
      !window.confirm(
        "Are you sure you want to clear the queue? This will delete all pending and paused jobs.",
      )
    )
      return;

    try {
      await safeFetch("/api/jobs/clear", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchJobs();
    } catch (err) {
      console.error("Failed to clear queue", err);
    }
  };

  const handleRetryJob = async (jobId: string) => {
    if (!token) return;
    try {
      await safeFetch(`/api/jobs/${jobId}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchJobs();
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
      await safeFetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchJobs();
    } catch (err) {
      console.error("Failed to toggle job pause", err);
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    if (!token) return;
    try {
      await safeFetch(`/api/jobs/${jobId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchJobs();
    } catch (err) {
      console.error("Failed to delete job", err);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "FAILED":
        return "#f44336";
      case "PROCESSING":
        return "#2196f3";
      case "PAUSED":
        return "#9e9e9e";
      default:
        return "#4caf50";
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
          <line
            x1="8"
            y1="6"
            x2="21"
            y2="6"
          ></line>
          <line
            x1="8"
            y1="12"
            x2="21"
            y2="12"
          ></line>
          <line
            x1="8"
            y1="18"
            x2="21"
            y2="18"
          ></line>
          <line
            x1="3"
            y1="6"
            x2="3.01"
            y2="6"
          ></line>
          <line
            x1="3"
            y1="12"
            x2="3.01"
            y2="12"
          ></line>
          <line
            x1="3"
            y1="18"
            x2="3.01"
            y2="18"
          ></line>
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
                {isPaused ? "Resume Queue" : "Pause Queue"}
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
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      backgroundColor: getStatusColor(job.status),
                      marginTop: "6px",
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontWeight: "bold",
                        fontSize: "14px",
                        marginBottom: "2px",
                        color: "var(--text-main)",
                      }}
                    >
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
                    </div>
                    {renderJobDetails(job)}
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        marginTop: "4px",
                        marginBottom: "4px",
                      }}
                    >
                      Status: {job.status} | Attempt: {job.attempt}/
                      {job.maxAttempts}
                      {job.type === "qa" && (() => {
                        try {
                          const payload = JSON.parse(job.payload || "{}");
                          if (payload.qaPass) {
                            return ` | Pass: ${payload.qaPass}/3`;
                          }
                        } catch {}
                        return "";
                      })()}
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
                      style={{
                        fontSize: "10px",
                        color: "var(--text-dim)",
                        marginBottom: "4px",
                      }}
                    >
                      Created: {new Date(job.createdAt).toLocaleTimeString()}
                    </div>
                    <div
                      style={{ display: "flex", gap: "8px", marginTop: "8px" }}
                    >
                      {job.status === "FAILED" && (
                        <>
                          <button
                            onClick={() => handleRetryJob(job.id)}
                            className="btn btn-primary"
                            style={{ fontSize: "11px", padding: "4px 8px" }}
                          >
                            Retry
                          </button>
                          <button
                            onClick={() => handleDeleteJob(job.id)}
                            className="btn btn-secondary"
                            style={{
                              fontSize: "11px",
                              padding: "4px 8px",
                              borderColor: "#f44336",
                              color: "#f44336",
                            }}
                          >
                            Dismiss
                          </button>
                        </>
                      )}
                      {(job.status === "PENDING" ||
                        job.status === "PAUSED") && (
                        <>
                          <button
                            onClick={() => handleToggleJobPause(job)}
                            className="btn btn-secondary"
                            style={{ fontSize: "11px", padding: "4px 8px" }}
                          >
                            {job.status === "PAUSED" ? "Resume" : "Pause"}
                          </button>
                          <button
                            onClick={() => handleDeleteJob(job.id)}
                            className="btn btn-secondary"
                            style={{
                              fontSize: "11px",
                              padding: "4px 8px",
                              borderColor: "#f44336",
                              color: "#f44336",
                            }}
                          >
                            Cancel
                          </button>
                        </>
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
