import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import EditIcon from "@mui/icons-material/Edit";
import type { User, Series, Chapter, Page } from "../types";
import { safeFetch, toSlug, getContextPath } from "../utils";
import CreateChapterDialog from "./CreateChapterDialog";
import ConfirmModal from "./ConfirmModal";
import { useToast } from "./ToastContext";
import { useUploadQueue, type UploadQueueItem } from "./UploadContext";
import Typography from "@mui/material/Typography";

interface ChapterGalleryProps {
  user: User;
  selectedSeries: Series | null;
  selectedChapter: Chapter | null;
  setSelectedChapter: React.Dispatch<React.SetStateAction<Chapter | null>>;
  pages: Page[];
  setPages: React.Dispatch<React.SetStateAction<Page[]>>;
  onSelectPage: (page: Page) => void;
  isLoadingDetails: boolean;
  mode: "light" | "dark";
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
  mode
}) => {
  const navigate = useNavigate();

  // Page-wide drag state
  const [dragCounter, setDragCounter] = useState(0);

  // Upload state from app-level context (survives route changes)
  const { addItems, updateItem } = useUploadQueue();
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
    onConfirm: () => { },
  });

  const closeConfirmModal = () =>
    setConfirmModal((prev) => ({ ...prev, isOpen: false }));

  // Chapter editing modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [editCounter, setEditCounter] = useState(0);

  const processUploadedFiles = React.useCallback(
    async (files: FileList) => {
      if (!selectedChapter) return;

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

      addItems(newItems);

      let nextNum = pages.length + 1;
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files.item(i);
        if (!file) continue;

        const queueItem = newItems.at(i);
        if (!queueItem) continue;
        const queueItemId = queueItem.id;

        updateItem(queueItemId, { status: "uploading" });

        try {
          const res = await uploadFileWithProgress(
            file,
            selectedChapter.id,
            nextNum,
            (progress) => {
              updateItem(queueItemId, { progress });
            },
          );

          if (res.ok) {
            nextNum++;
            successCount++;
            updateItem(queueItemId, { status: "completed", progress: 100 });
          } else {
            throw new Error(`Upload returned status ${res.status}`);
          }
        } catch (err) {
          console.error("Failed to upload page:", err);
          failCount++;
          updateItem(queueItemId, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
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
      addItems,
      updateItem,
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
    if (!file || !selectedChapter || !user) return;

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
        } as RequestInit,
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
      const res = await safeFetch(
        `/api/series/chapters/${selectedChapter.id}/export?format=zip`,
        {
          headers: { Authorization: `Bearer ${user.token}` },
        },
      );

      if (!res.ok) {
        throw new Error("Failed to export chapter zip");
      }

      const contentType = res.headers.get("content-type");
      if (
        res.status === 202 ||
        (contentType && contentType.includes("application/json"))
      ) {
        const data = await res.json();
        showToast(
          data.message ||
          "Export started in the background. You will be notified when it is ready.",
          "info",
        );
        return;
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
            showToast("Page deleted successfully", "success");
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
          } else if (res.status === 403) {
            showToast(
              "You don't have permission to delete this page.",
              "error",
            );
          } else {
            showToast("Failed to delete page", "error");
          }
        } catch (err) {
          console.error("Error deleting page:", err);
          showToast("Error deleting page", "error");
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
      <div>
        <Button
          variant="outlined"
          size="small"
          onClick={() => {
            setSelectedChapter(null);
            navigate(
              `/series/${selectedSeries.id}/${toSlug(selectedSeries.title)}`,
            );
          }}
          sx={{ mb: 2 }}
        >
          ← Back to Series
        </Button>
        <div className="page-header">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <Typography
                variant="h4"
                sx={{ fontFamily: '"Outfit", sans-serif', fontWeight: 600, color: mode === "dark" ? "white" : "black" }}
              >
                Chapter {selectedChapter.chapterNumber}
              </Typography>
              <IconButton
                onClick={() => {
                  setShowEditModal(true);
                  setEditCounter((c) => c + 1);
                }}
                title="Edit Chapter Name & Number"
                size="small"
              >
                <EditIcon fontSize="small" />
              </IconButton>
            </div>
            <p style={{ color: "var(--text-muted)", margin: "8px 0 0" }}>
              {selectedSeries.title} / {selectedChapter.title || "Untitled"}
            </p>
          </div>
          <Stack
            direction="row"
            spacing={1}
          >
            <Button
              variant="outlined"
              size="small"
              onClick={() =>
                document.getElementById("project-import-upload")?.click()
              }
              disabled={isImportingProject}
            >
              {isImportingProject ? "Importing..." : "Import Project (ZIP)"}
            </Button>
            <Button
              variant="outlined"
              size="small"
              onClick={handleExportChapterZip}
            >
              Export Chapter (ZIP)
            </Button>
            <Button
              variant="contained"
              size="small"
              onClick={() => document.getElementById("file-upload")?.click()}
            >
              Upload Page
            </Button>
          </Stack>
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

      <Typography
        variant="h5"
        sx={{ fontFamily: '"Outfit", sans-serif', fontWeight: 600, color: mode === "dark" ? "white" : "black" }}
      >
        Pages ({pages.length})
      </Typography>
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
              src={p.thumbnailUrl || `${p.url}?token=${user.token}`}
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

      <CreateChapterDialog
        key={selectedChapter?.id ?? `edit-${editCounter}`}
        open={showEditModal}
        editingChapter={selectedChapter}
        user={user}
        selectedSeries={selectedSeries}
        chapters={[]}
        onClose={() => {
          setShowEditModal(false);
        }}
        onSuccess={(data) => {
          setSelectedChapter(data);
        }}
        onError={(msg) => {
          showToast(msg, "error");
        }}
      />

      {/* Toasts rendered globally by ToastProvider in App.tsx */}

      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.08); }
        }
      `}</style>
    </div>
  );
};

export default React.memo(ChapterGallery);
