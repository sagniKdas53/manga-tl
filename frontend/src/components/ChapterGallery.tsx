import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import type { User, Series, Chapter, Page } from "../types";
import { safeFetch, toSlug, getContextPath } from "../utils";
import CreateChapterDialog from "./CreateChapterDialog";
import ConfirmModal from "./ConfirmModal";
import ChapterHeader from "./ChapterHeader";
import ChapterPageGrid from "./ChapterPageGrid";
import ChapterDragOverlay from "./ChapterDragOverlay";
import { useToast } from "./ToastContext";
import { useUploadQueue, type UploadQueueItem } from "./UploadContext";

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
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh", flexDirection: "column", gap: 2 }}>
        <CircularProgress />
        <Typography>Loading chapter details...</Typography>
      </Box>
    );
  }

  const handleDeletePage = (pageId: string) => {
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
    <Box sx={{ maxWidth: 1200, mx: "auto", width: "100%", px: { xs: 2, sm: 3 }, py: 3 }}>
      <ChapterHeader
        selectedSeries={selectedSeries}
        selectedChapter={selectedChapter}
        onBack={() => {
          setSelectedChapter(null);
          navigate(
            `/series/${selectedSeries.id}/${toSlug(selectedSeries.title)}`,
          );
        }}
        onEditClick={() => {
          setShowEditModal(true);
          setEditCounter((c) => c + 1);
        }}
        onImportClick={() =>
          document.getElementById("project-import-upload")?.click()
        }
        onExportClick={handleExportChapterZip}
        onUploadClick={() => document.getElementById("file-upload")?.click()}
        isImporting={isImportingProject}
        mode={mode}
      />

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

      <ChapterPageGrid
        pages={pages}
        token={user.token}
        onDeletePage={handleDeletePage}
        onMovePage={handleMovePage}
        onSelectPage={(p) => {
          onSelectPage(p);
          navigate(
            `/chapters/${selectedChapter.id}/${toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`)}/reader/${p.pageNumber}`,
          );
        }}
        onNavigate={navigate}
      />

      <ChapterDragOverlay
        visible={dragCounter > 0}
        chapterNumber={selectedChapter.chapterNumber}
      />

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
    </Box>
  );
};

export default React.memo(ChapterGallery);
