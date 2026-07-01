import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { User, Series, Chapter, Page } from "../types";
import { safeFetch, toSlug, getContextPath } from "../utils";
import ConfirmModal from "./ConfirmModal";
import { useToast } from "./ToastContext";

interface UploadQueueItem {
  id: string;
  name: string;
  progress: number;
  status: "pending" | "uploading" | "completed" | "failed";
  error?: string;
}

interface ChapterGalleryProps {
  user: User;
  selectedSeries: Series | null;
  selectedChapter: Chapter | null;
  setSelectedChapter: React.Dispatch<React.SetStateAction<Chapter | null>>;
  pages: Page[];
  setPages: React.Dispatch<React.SetStateAction<Page[]>>;
  onSelectPage: (page: Page) => void;
  isLoadingDetails: boolean;
}

export const ChapterGallery: React.FC<ChapterGalleryProps> = ({
  user,
  selectedSeries,
  selectedChapter,
  setSelectedChapter,
  pages,
  setPages,
  onSelectPage,
  isLoadingDetails,
}) => {
  const navigate = useNavigate();

  // Page-wide drag state
  const [dragCounter, setDragCounter] = useState(0);

  // Upload queue and feedback states
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [showQueuePanel, setShowQueuePanel] = useState(false);
  const [isQueueExpanded, setIsQueueExpanded] = useState(true);
  const [isImportingProject, setIsImportingProject] = useState(false);

  // Use global toast hook
  const { showToast } = useToast();

  // XHR upload wrapper to report progress percentages
  const uploadFileWithProgress = React.useCallback(
    (
      file: File,
      chapterId: string,
      pageNumber: number,
      onProgress: (progress: number) => void,
    ): Promise<Response> => {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const context = getContextPath();
        const targetUrl = context + "/api/images";

        xhr.open("POST", targetUrl);
        xhr.setRequestHeader("Authorization", `Bearer ${user.token}`);

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            onProgress(percent);
          }
        };

        xhr.onload = () => {
          const isOk = xhr.status >= 200 && xhr.status < 300;
          const response = {
            ok: isOk,
            status: xhr.status,
            statusText: xhr.statusText,
            text: () => Promise.resolve(xhr.responseText),
            json: () => {
              try {
                return Promise.resolve(JSON.parse(xhr.responseText || "{}"));
              } catch {
                return Promise.resolve({});
              }
            },
          } as unknown as Response;
          resolve(response);
        };

        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.onabort = () => reject(new Error("Upload aborted"));

        const formData = new FormData();
        formData.append("chapterId", chapterId);
        formData.append("pageNumber", pageNumber.toString());
        formData.append("file", file);

        xhr.send(formData);
      });
    },
    [user.token],
  );

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    isDangerous?: boolean;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: () => {},
  });

  const closeConfirmModal = () =>
    setConfirmModal((prev) => ({ ...prev, isOpen: false }));

  // Chapter editing modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editChapterNum, setEditChapterNum] = useState<number>(1.0);
  const [editChapterTitle, setEditChapterTitle] = useState("");
  const [editError, setEditError] = useState("");

  const handleEditClick = () => {
    if (selectedChapter) {
      setEditChapterNum(selectedChapter.chapterNumber);
      setEditChapterTitle(selectedChapter.title || "");
      setEditError("");
      setShowEditModal(true);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedChapter) return;
    setEditError("");
    try {
      const res = await safeFetch(
        `/api/series/chapters/${selectedChapter.id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user.token}`,
          },
          body: JSON.stringify({
            chapterNumber: editChapterNum,
            title: editChapterTitle,
          }),
        },
      );
      if (res.ok) {
        const data: Chapter = await res.json();
        setSelectedChapter(data);
        setShowEditModal(false);
        setEditError("");
      } else {
        let errMsg = "Failed to update chapter";
        try {
          const text = await res.text();
          if (text) {
            try {
              const parsed = JSON.parse(text);
              errMsg = parsed.message || parsed.error || errMsg;
            } catch {
              errMsg = text;
            }
          }
        } catch (readErr) {
          console.error(readErr);
        }
        setEditError(errMsg);
      }
    } catch (err) {
      console.error("Error updating chapter:", err);
      setEditError(err instanceof Error ? err.message : String(err));
    }
  };

  const processUploadedFiles = React.useCallback(
    async (files: FileList) => {
      if (!selectedChapter) return;

      // Build new queue items
      const newItems: UploadQueueItem[] = [];
      const now = Date.now();
      for (let i = 0; i < files.length; i++) {
        const file = files.item(i);
        if (file) {
          newItems.push({
            id: `${file.name}-${now}-${i}`,
            name: file.name,
            progress: 0,
            status: "pending",
          });
        }
      }

      if (newItems.length === 0) return;

      setUploadQueue((prev) => [...prev, ...newItems]);
      setShowQueuePanel(true);
      setIsQueueExpanded(true);

      let nextNum = pages.length + 1;
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files.item(i);
        if (!file) continue;

        const queueItem = newItems.at(i);
        if (!queueItem) continue;
        const queueItemId = queueItem.id;

        // Update status to uploading
        setUploadQueue((prev) =>
          prev.map((item) =>
            item.id === queueItemId ? { ...item, status: "uploading" } : item,
          ),
        );

        try {
          const res = await uploadFileWithProgress(
            file,
            selectedChapter.id,
            nextNum,
            (progress) => {
              setUploadQueue((prev) =>
                prev.map((item) =>
                  item.id === queueItemId ? { ...item, progress } : item,
                ),
              );
            },
          );

          if (res.ok) {
            nextNum++;
            successCount++;
            setUploadQueue((prev) =>
              prev.map((item) =>
                item.id === queueItemId
                  ? { ...item, status: "completed", progress: 100 }
                  : item,
              ),
            );
          } else {
            throw new Error(`Upload returned status ${res.status}`);
          }
        } catch (err) {
          console.error("Failed to upload page:", err);
          failCount++;
          setUploadQueue((prev) =>
            prev.map((item) =>
              item.id === queueItemId
                ? {
                    ...item,
                    status: "failed",
                    error: err instanceof Error ? err.message : String(err),
                  }
                : item,
            ),
          );
          showToast(`Failed to upload ${file.name}`, "error");
        }
      }

      // Refresh pages list automatically at the end
      try {
        const r = await safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
          headers: { Authorization: `Bearer ${user.token}` },
        });
        if (r.ok) {
          const data: Page[] = await r.json();
          setPages(data);
          if (successCount > 0) {
            showToast(
              `Successfully uploaded ${successCount} page(s)`,
              "success",
            );
          }
          if (failCount > 0) {
            showToast(`Failed to upload ${failCount} page(s)`, "error");
          }
        }
      } catch (err) {
        console.error("Error refreshing pages:", err);
      }
    },
    [
      selectedChapter,
      pages.length,
      user.token,
      setPages,
      uploadFileWithProgress,
      showToast,
    ],
  );

  // Bind window-wide drag and drop events
  const processUploadedFilesRef = useRef(processUploadedFiles);
  useEffect(() => {
    processUploadedFilesRef.current = processUploadedFiles;
  }, [processUploadedFiles]);

  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragCounter((prev) => prev + 1);
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragCounter((prev) => Math.max(0, prev - 1));
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragCounter(0);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        processUploadedFilesRef.current(files);
      }
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) processUploadedFiles(files);
  };

  const handleProjectImportUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file || !selectedChapter) return;

    // Reset input value so onChange triggers again for same file if needed
    e.target.value = "";

    setIsImportingProject(true);
    showToast("Importing project layers...", "info");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await safeFetch(
        `/api/chapters/${selectedChapter.id}/import-project`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${user.token}`,
          },
          body: formData,
        },
      );

      if (res.ok) {
        showToast("Project imported successfully!", "success");
        // Refresh pages list
        const pagesRes = await safeFetch(
          `/api/chapters/${selectedChapter.id}/pages`,
          {
            headers: { Authorization: `Bearer ${user.token}` },
          },
        );
        if (pagesRes.ok) {
          const data: Page[] = await pagesRes.json();
          setPages(data);
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        showToast(errData.message || "Failed to import project", "error");
      }
    } catch (err) {
      console.error(err);
      showToast(
        err instanceof Error ? err.message : "Error importing project",
        "error",
      );
    } finally {
      setIsImportingProject(false);
    }
  };

  const handleExportChapterZip = useCallback(async () => {
    if (!selectedChapter) return;
    try {
      showToast("Preparing chapter export...", "info");
      const res = await safeFetch(`/api/series/chapters/${selectedChapter.id}/export?format=zip`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      
      if (!res.ok) {
        throw new Error("Failed to export chapter zip");
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chapter-${selectedChapter.chapterNumber}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      showToast("Error exporting chapter", "error");
    }
  }, [selectedChapter, user.token, showToast]);

  if (isLoadingDetails || !selectedSeries || !selectedChapter) {
    return (
      <div className="dashboard-content text-center">
        <div className="spinner"></div>
        <p>Loading chapter details...</p>
      </div>
    );
  }

  const handleDeletePage = (pageId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmModal({
      isOpen: true,
      title: "Delete Page",
      message:
        "Are you sure you want to delete this page? This will also delete all associated panels, OCR regions, and translations.",
      confirmText: "Delete Page",
      isDangerous: true,
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await safeFetch(`/api/pages/${pageId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${user.token}` },
          });
          if (res.ok) {
            // Filter locally
            setPages((prev) => prev.filter((p) => p.id !== pageId));
            // Re-fetch pages list to verify orders
            if (selectedChapter) {
              const r = await safeFetch(
                `/api/chapters/${selectedChapter.id}/pages`,
                {
                  headers: { Authorization: `Bearer ${user.token}` },
                },
              );
              if (r.ok) {
                const data: Page[] = await r.json();
                setPages(data);
              }
            }
          } else {
            alert("Failed to delete page");
          }
        } catch (err) {
          console.error("Error deleting page:", err);
        }
      },
    });
  };

  const handleMovePage = async (index: number, direction: "left" | "right") => {
    if (!selectedChapter) return;
    const newIndex = direction === "left" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= pages.length) return;

    // Swap locally for instant feedback using splice to avoid dynamic bracket notation lint warning
    const updatedPages = [...pages];
    const [moved] = updatedPages.splice(index, 1);
    updatedPages.splice(newIndex, 0, moved);

    // Adjust pageNumbers in the updated array
    const finalPages = updatedPages.map((p, idx) => ({
      ...p,
      pageNumber: idx + 1,
    }));
    setPages(finalPages);

    try {
      const res = await safeFetch(
        `/api/chapters/${selectedChapter.id}/pages/reorder`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user.token}`,
          },
          body: JSON.stringify(finalPages.map((p) => p.id)),
        },
      );
      if (!res.ok) {
        throw new Error("Failed to save reorder on backend");
      }
    } catch (err) {
      console.error("Error saving page order:", err);
      // Revert if error
      if (selectedChapter) {
        safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
          headers: { Authorization: `Bearer ${user.token}` },
        })
          .then((r) => r.json())
          .then((data) => setPages(data))
          .catch((fetchErr) =>
            console.error("Error reverting page order:", fetchErr),
          );
      }
    }
  };

  return (
    <div className="dashboard-content">
      <div className="mb-8">
        <button
          className="btn btn-secondary"
          onClick={() => {
            setSelectedChapter(null);
            navigate(
              `/series/${selectedSeries.id}/${toSlug(selectedSeries.title)}`,
            );
          }}
          style={{ padding: "8px 16px", marginBottom: "16px" }}
        >
          &larr; Back to Series
        </button>
        <div className="page-header">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <h1>Chapter {selectedChapter.chapterNumber}</h1>
              <button
                className="action-btn-small"
                onClick={handleEditClick}
                title="Edit Chapter Name & Number"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "6px",
                  padding: "6px",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "#fff";
                  e.currentTarget.style.background = "rgba(255,255,255,0.1)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.background = "rgba(255,255,255,0.05)";
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
            </div>
            <p style={{ color: "var(--text-muted)", margin: "8px 0 0" }}>
              {selectedSeries.title} / {selectedChapter.title || "Untitled"}
            </p>
          </div>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              className="btn btn-secondary"
              onClick={() => {
                safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
                  headers: { Authorization: `Bearer ${user.token}` },
                })
                  .then((r) => r.json())
                  .then((data) => setPages(data));
              }}
            >
              Refresh Gallery
            </button>
            <button
              className="btn btn-secondary"
              onClick={() =>
                document.getElementById("project-import-upload")?.click()
              }
              disabled={isImportingProject}
            >
              {isImportingProject ? "Importing..." : "Import Project (ZIP)"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleExportChapterZip}
            >
              Export Chapter (ZIP)
            </button>
            <button
              className="btn btn-primary"
              onClick={() => document.getElementById("file-upload")?.click()}
            >
              Upload Page
            </button>
          </div>
        </div>
      </div>

      {/* Hidden file input for browsing */}
      <input
        id="file-upload"
        type="file"
        multiple
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileUpload}
      />
      <input
        id="project-import-upload"
        type="file"
        accept=".zip"
        style={{ display: "none" }}
        onChange={handleProjectImportUpload}
      />

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: "22px" }}>
        Uploaded Pages ({pages.length})
      </h2>
      <div className="pages-grid">
        {pages.map((p, idx) => (
          <div
            key={p.id}
            className="page-thumbnail-container glass"
            onClick={() => {
              onSelectPage(p);
              navigate(
                `/chapters/${selectedChapter.id}/${toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`)}/reader/${p.pageNumber}`,
              );
            }}
            style={{ position: "relative" }}
          >
            <img
              src={p.thumbnailUrl || p.url}
              className="page-thumbnail"
              alt={`Page ${p.pageNumber}`}
            />
            <span className="page-num-tag">Page {p.pageNumber}</span>

            <button
              className="delete-page-btn"
              onClick={(e) => handleDeletePage(p.id, e)}
              title="Delete page"
            >
              &times;
            </button>

            <div
              className="reorder-controls"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="reorder-btn"
                onClick={() => handleMovePage(idx, "left")}
                disabled={idx === 0}
                title="Move page left"
              >
                &larr;
              </button>
              <button
                className="reorder-btn"
                onClick={() => handleMovePage(idx, "right")}
                disabled={idx === pages.length - 1}
                title="Move page right"
              >
                &rarr;
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Fullscreen Drag Overlay */}
      {dragCounter > 0 && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(15, 15, 25, 0.85)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "4px dashed rgba(99, 102, 241, 0.6)",
            borderRadius: "16px",
            margin: "16px",
            pointerEvents: "none",
            animation: "fadeIn 0.15s ease-out",
          }}
        >
          <div
            style={{
              background:
                "linear-gradient(145deg, rgba(30,30,50,0.95) 0%, rgba(20,20,38,0.95) 100%)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "20px",
              boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
              padding: "40px 60px",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "16px",
            }}
          >
            <div
              style={{
                width: "60px",
                height: "60px",
                borderRadius: "16px",
                background: "rgba(99, 102, 241, 0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                animation: "pulse 2s infinite",
              }}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#818cf8"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line
                  x1="12"
                  y1="3"
                  x2="12"
                  y2="15"
                />
              </svg>
            </div>
            <h2
              style={{
                color: "#fff",
                fontSize: "20px",
                fontWeight: 700,
                margin: 0,
              }}
            >
              Drop Manga Pages Anywhere
            </h2>
            <p
              style={{
                color: "rgba(226,232,240,0.7)",
                fontSize: "14px",
                margin: 0,
              }}
            >
              Release to add multiple files to Chapter{" "}
              {selectedChapter.chapterNumber}
            </p>
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        isDangerous={confirmModal.isDangerous}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirmModal}
      />

      {/* Edit Chapter Modal */}
      {showEditModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.7)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            className="glass"
            style={{ padding: "32px", width: "100%", maxWidth: "400px" }}
          >
            <h2
              style={{
                fontFamily: "var(--font-display)",
                marginBottom: "24px",
              }}
            >
              Edit Chapter
            </h2>
            <form onSubmit={handleEditSubmit}>
              <div className="form-group">
                <label className="form-label">Chapter Number</label>
                <input
                  type="number"
                  step="any"
                  className="form-input"
                  value={editChapterNum}
                  onChange={(e) =>
                    setEditChapterNum(parseFloat(e.target.value) || 0)
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Chapter Title</label>
                <input
                  type="text"
                  className="form-input"
                  value={editChapterTitle}
                  onChange={(e) => setEditChapterTitle(e.target.value)}
                  placeholder="e.g. The Beginning"
                />
              </div>
              {editError && (
                <div
                  style={{
                    color: "var(--error, #ff4d4f)",
                    fontSize: "13px",
                    marginTop: "16px",
                    textAlign: "center",
                  }}
                >
                  {editError}
                </div>
              )}
              <div style={{ display: "flex", gap: "12px", marginTop: "24px" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setShowEditModal(false);
                    setEditError("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toasts rendered globally by ToastProvider in App.tsx */}

      {/* Floating Upload Queue Panel */}
      {showQueuePanel && (
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
                    (item) =>
                      item.status === "uploading" || item.status === "pending",
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
                  (item) =>
                    item.status === "uploading" || item.status === "pending",
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
                onClick={() => {
                  setShowQueuePanel(false);
                  setUploadQueue([]);
                }}
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
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.08); }
        }
      `}</style>
    </div>
  );
};

export default ChapterGallery;
