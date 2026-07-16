import React from "react";
import { useUploadStore } from "../store/useUploadStore";

export const UploadProgressWidget: React.FC = () => {
  const {
    uploadQueue,
    showQueuePanel,
    isQueueExpanded,
    setIsQueueExpanded,
    clearQueue,
  } = useUploadStore();

  if (!showQueuePanel) return null;

  return (
    <div
      className="glass"
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        width: "360px",
        zIndex: 10000,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        maxHeight: isQueueExpanded ? "400px" : "50px",
        transition: "max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-color)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.3)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          background: "rgba(0, 0, 0, 0.1)",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setIsQueueExpanded(!isQueueExpanded)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: uploadQueue.some(
                (item) => item.status === "uploading" || item.status === "pending",
              )
                ? "var(--warning)"
                : "var(--success)",
              display: "inline-block",
            }}
          ></span>
          <span
            style={{
              fontWeight: 600,
              fontSize: "14px",
              fontFamily: "var(--font-display)",
            }}
          >
            {uploadQueue.some(
              (item) => item.status === "uploading" || item.status === "pending",
            )
              ? `Uploading ${uploadQueue.filter((item) => item.status === "uploading" || item.status === "pending").length} file(s)...`
              : "Uploads Completed"}
          </span>
        </div>
        <div
          style={{ display: "flex", alignItems: "center", gap: "12px" }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => setIsQueueExpanded(!isQueueExpanded)}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "4px",
              display: "flex",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              style={{
                transform: isQueueExpanded ? "rotate(180deg)" : "none",
                transition: "transform 0.2s",
              }}
            >
              <polyline points="18 15 12 9 6 15"></polyline>
            </svg>
          </button>
          <button
            onClick={() => clearQueue()}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "4px",
              fontSize: "18px",
              display: "flex",
              alignItems: "center",
              lineHeight: 1,
            }}
          >
            &times;
          </button>
        </div>
      </div>

      {/* Queue Items List */}
      {isQueueExpanded && (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 16px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            maxHeight: "340px",
          }}
        >
          {uploadQueue.map((item) => (
            <div
              key={item.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "12px",
                }}
              >
                <span
                  style={{
                    textOverflow: "ellipsis",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    maxWidth: "75%",
                    color: "var(--text-main)",
                    fontWeight: 500,
                  }}
                  title={item.name}
                >
                  {item.name}
                </span>
                <span
                  style={{
                    color:
                      item.status === "completed"
                        ? "var(--success)"
                        : item.status === "failed"
                          ? "var(--error)"
                          : "var(--text-muted)",
                    fontWeight: 600,
                  }}
                >
                  {item.status === "uploading"
                    ? `${item.progress}%`
                    : item.status}
                </span>
              </div>
              <div
                style={{
                  width: "100%",
                  height: "4px",
                  backgroundColor: "rgba(255, 255, 255, 0.05)",
                  borderRadius: "2px",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${item.progress}%`,
                    height: "100%",
                    backgroundColor:
                      item.status === "failed"
                        ? "var(--error)"
                        : item.status === "completed"
                          ? "var(--success)"
                          : "var(--primary)",
                    transition: "width 0.1s ease-out",
                  }}
                ></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
