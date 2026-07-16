import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import ImageList from "@mui/material/ImageList";
import ImageListItem from "@mui/material/ImageListItem";
import ImageListItemBar from "@mui/material/ImageListItemBar";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import ArrowBackIosNewIcon from "@mui/icons-material/ArrowBackIosNew";
import ArrowForwardIosIcon from "@mui/icons-material/ArrowForwardIos";
import FileUploadIcon from "@mui/icons-material/FileUpload";

import type { User, Series, Chapter, Page, SystemSettingsDto } from "../types";
import { safeFetch, toSlug, getContextPath } from "../utils";
import ConfirmModal from "./ConfirmModal";
import ChapterDialog from "./ChapterDialog";
import { useToast } from "./ToastContext";

import { useUploadStore } from "../store/useUploadStore";
import type { UploadQueueItem } from "../store/useUploadStore";

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

  // Upload queue and feedback states from Zustand
  const { addItems, setItemStatus, updateItemProgress } = useUploadStore();
  const [isImportingProject, setIsImportingProject] = useState(false);

  const { showToast, showError } = useToast();

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
  const [editError, setEditError] = useState("");
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);

  React.useEffect(() => {
    if (showEditModal && !settings) {
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => setSettings(data))
        .catch(console.error);
    }
  }, [showEditModal, settings, user.token]);

  const handleEditClick = () => {
    if (selectedChapter) {
      setEditError("");
      setShowEditModal(true);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleEditSubmit = async (data: any) => {
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
          body: JSON.stringify(data),
        },
      );
      if (res.ok) {
        const updated: Chapter = await res.json();
        setSelectedChapter(updated);
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

        setItemStatus(queueItemId, "uploading");

        try {
          const res = await uploadFileWithProgress(
            file,
            selectedChapter.id,
            nextNum,
            (progress) => {
              updateItemProgress(queueItemId, progress);
            },
          );

          if (res.ok) {
            nextNum++;
            successCount++;
            setItemStatus(queueItemId, "completed");
          } else {
            throw new Error(`Upload returned status ${res.status}`);
          }
        } catch (err) {
          console.error("Failed to upload page:", err);
          failCount++;
          setItemStatus(
            queueItemId,
            "failed",
            err instanceof Error ? err.message : String(err),
          );
          showError(`Failed to upload ${file.name}`);
        }
      }

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
            showError(`Failed to upload ${failCount} page(s)`);
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
      showError,
      addItems,
      setItemStatus,
      updateItemProgress,
    ],
  );

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
        showError(errData.message || "Failed to import project");
      }
    } catch (err) {
      console.error(err);
      showError(err instanceof Error ? err.message : "Error importing project");
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
      showError("Error exporting chapter");
    }
  }, [selectedChapter, user.token, showToast, showError]);

  if (isLoadingDetails || !selectedSeries || !selectedChapter) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          mt: 8,
        }}
      >
        <CircularProgress />
        <Typography
          sx={{ mt: 2 }}
          color="text.secondary"
        >
          Loading chapter details...
        </Typography>
      </Box>
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
            setPages((prev) => prev.filter((p) => p.id !== pageId));
            showToast("Page deleted successfully", "success");
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
            showError("You don't have permission to delete this page.");
          } else {
            showError("Failed to delete page");
          }
        } catch (err) {
          console.error("Error deleting page:", err);
          showError("Error deleting page");
        }
      },
    });
  };

  const handleMovePage = async (index: number, direction: "left" | "right") => {
    if (!selectedChapter) return;
    const newIndex = direction === "left" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= pages.length) return;

    const updatedPages = [...pages];
    const [moved] = updatedPages.splice(index, 1);
    updatedPages.splice(newIndex, 0, moved);

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
    <Container
      maxWidth="xl"
      sx={{ py: 4 }}
    >
      <Box sx={{ mb: 4 }}>
        <Button
          variant="outlined"
          startIcon={<ArrowBackIcon />}
          onClick={() => {
            setSelectedChapter(null);
            navigate(
              `/series/${selectedSeries.id}/${toSlug(selectedSeries.title)}`,
            );
          }}
          sx={{ mb: 3 }}
        >
          Back to Series
        </Button>

        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: 2,
          }}
        >
          <Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography
                variant="h4"
                component="h1"
                fontWeight="bold"
              >
                Chapter {selectedChapter.chapterNumber}
              </Typography>
              <Tooltip title="Edit Chapter">
                <IconButton
                  onClick={handleEditClick}
                  size="small"
                  color="inherit"
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
            <Typography
              variant="body1"
              color="text.secondary"
              sx={{ mt: 0.5 }}
            >
              {selectedSeries.title} / {selectedChapter.title || "Untitled"}
            </Typography>
          </Box>

          <Stack
            direction="row"
            spacing={2}
            flexWrap="wrap"
            useFlexGap
          >
            <Button
              variant="outlined"
              startIcon={<FileUploadIcon />}
              onClick={() =>
                document.getElementById("project-import-upload")?.click()
              }
              disabled={isImportingProject}
            >
              {isImportingProject ? "Importing..." : "Import Project"}
            </Button>
            <Button
              variant="outlined"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportChapterZip}
            >
              Export Chapter
            </Button>
            <Button
              variant="contained"
              startIcon={<UploadFileIcon />}
              onClick={() => document.getElementById("file-upload")?.click()}
            >
              Upload Page
            </Button>
          </Stack>
        </Box>
      </Box>

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
        fontWeight="bold"
        gutterBottom
        sx={{ mb: 3 }}
      >
        Uploaded Pages ({pages.length})
      </Typography>

      <ImageList
        cols={4}
        gap={16}
        sx={{
          mb: 8,
          gridTemplateColumns: {
            xs: "repeat(2, 1fr)",
            sm: "repeat(3, 1fr)",
            md: "repeat(4, 1fr)",
            lg: "repeat(5, 1fr)",
          },
        }}
      >
        {pages.map((p, idx) => (
          <ImageListItem
            key={p.id}
            sx={{
              cursor: "pointer",
              borderRadius: 2,
              overflow: "hidden",
              boxShadow: 2,
              position: "relative",
              "&:hover .actions": {
                opacity: 1,
              },
              "&:hover img": {
                transform: "scale(1.02)",
              },
            }}
            onClick={() => {
              onSelectPage(p);
              navigate(
                `/chapters/${selectedChapter.id}/${toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`)}/reader/${p.pageNumber}`,
              );
            }}
          >
            <img
              src={p.thumbnailUrl || `${p.url}?token=${user.token}`}
              alt={`Page ${p.pageNumber}`}
              loading="lazy"
              style={{
                aspectRatio: "2/3",
                objectFit: "cover",
                transition: "transform 0.2s ease-in-out",
              }}
            />
            <ImageListItemBar
              title={`Page ${p.pageNumber}`}
              position="bottom"
              sx={{ background: "rgba(0,0,0,0.6)" }}
            />

            <Box
              className="actions"
              sx={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(0,0,0,0.3)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                opacity: 0,
                transition: "opacity 0.2s ease-in-out",
                p: 1,
              }}
            >
              <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
                <Tooltip title="Delete Page">
                  <IconButton
                    size="small"
                    color="error"
                    onClick={(e) => handleDeletePage(p.id, e)}
                    sx={{
                      backgroundColor: "rgba(0,0,0,0.6)",
                      "&:hover": { backgroundColor: "error.main" },
                    }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>

              <Box
                sx={{ display: "flex", justifyContent: "space-between", mb: 4 }}
                onClick={(e) => e.stopPropagation()}
              >
                <Tooltip title="Move Left">
                  <span>
                    <IconButton
                      size="small"
                      disabled={idx === 0}
                      onClick={() => handleMovePage(idx, "left")}
                      sx={{
                        color: "white",
                        backgroundColor: "rgba(0,0,0,0.6)",
                        "&:hover": { backgroundColor: "primary.main" },
                      }}
                    >
                      <ArrowBackIosNewIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>

                <Tooltip title="Move Right">
                  <span>
                    <IconButton
                      size="small"
                      disabled={idx === pages.length - 1}
                      onClick={() => handleMovePage(idx, "right")}
                      sx={{
                        color: "white",
                        backgroundColor: "rgba(0,0,0,0.6)",
                        "&:hover": { backgroundColor: "primary.main" },
                      }}
                    >
                      <ArrowForwardIosIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </Box>
          </ImageListItem>
        ))}
      </ImageList>

      {/* Fullscreen Drag Overlay */}
      {dragCounter > 0 && (
        <Box
          sx={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.7)",
            backdropFilter: "blur(4px)",
            border: "4px dashed",
            borderColor: "primary.main",
            pointerEvents: "none",
          }}
        >
          <Box
            sx={{
              backgroundColor: "background.paper",
              borderRadius: 4,
              p: 6,
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              boxShadow: 24,
            }}
          >
            <UploadFileIcon sx={{ fontSize: 64, color: "primary.main" }} />
            <Typography
              variant="h4"
              fontWeight="bold"
            >
              Drop Manga Pages Anywhere
            </Typography>
            <Typography
              variant="subtitle1"
              color="text.secondary"
            >
              Release to add files to Chapter {selectedChapter.chapterNumber}
            </Typography>
          </Box>
        </Box>
      )}

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        isDangerous={confirmModal.isDangerous}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirmModal}
      />

      <ChapterDialog
        isOpen={showEditModal}
        onClose={() => {
          setShowEditModal(false);
          setEditError("");
        }}
        onSave={handleEditSubmit}
        initialData={selectedChapter}
        defaultChapterNumber={selectedChapter.chapterNumber}
        settings={settings}
        error={editError}
      />
    </Container>
  );
};

export default React.memo(ChapterGallery);
