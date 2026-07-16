import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { User, Series, Chapter, Page } from "../types";
import { safeFetch, toSlug, getContextPath } from "../utils";
import ConfirmModal from "./ConfirmModal";
import ChapterDialog from "./ChapterDialog";
import { useToast } from "./ToastContext";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import ImageList from "@mui/material/ImageList";
import ImageListItem from "@mui/material/ImageListItem";
import ImageListItemBar from "@mui/material/ImageListItemBar";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import Backdrop from "@mui/material/Backdrop";
import Tooltip from "@mui/material/Tooltip";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import UploadIcon from "@mui/icons-material/Upload";
import ArrowLeftIcon from "@mui/icons-material/ArrowLeft";
import ArrowRightIcon from "@mui/icons-material/ArrowRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import CloseIcon from "@mui/icons-material/Close";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import ArchiveIcon from "@mui/icons-material/Archive";

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
  const { showToast } = useToast();

  const [dragCounter, setDragCounter] = useState(0);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [showQueuePanel, setShowQueuePanel] = useState(false);
  const [isQueueExpanded, setIsQueueExpanded] = useState(true);
  const [isImportingProject, setIsImportingProject] = useState(false);

  const [showEditModal, setShowEditModal] = useState(false);

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

      try {
        const r = await safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
          headers: { Authorization: `Bearer ${user.token}` },
        });
        if (r.ok) {
          const data: Page[] = await r.json();
          setPages(data);
          if (successCount > 0) {
            showToast(`Successfully uploaded ${successCount} page(s)`, "success");
          }
          if (failCount > 0) {
            showToast(`Failed to upload ${failCount} page(s)`, "error");
          }
        }
      } catch (err) {
        console.error("Error refreshing pages:", err);
      }
    },
    [selectedChapter, pages.length, user.token, setPages, uploadFileWithProgress, showToast],
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

  const handleProjectImportUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
          headers: { Authorization: `Bearer ${user.token}` },
          body: formData,
        },
      );

      if (res.ok) {
        showToast("Project imported successfully!", "success");
        const pagesRes = await safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
          headers: { Authorization: `Bearer ${user.token}` },
        });
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
      showToast(err instanceof Error ? err.message : "Error importing project", "error");
    } finally {
      setIsImportingProject(false);
    }
  };

  const handleExportChapterZip = useCallback(async () => {
    if (!selectedChapter) return;
    try {
      const res = await safeFetch(
        `/api/series/chapters/${selectedChapter.id}/export?format=zip`,
        { headers: { Authorization: `Bearer ${user.token}` } },
      );
      if (!res.ok) throw new Error("Failed to export chapter zip");

      const contentType = res.headers.get("content-type");
      if (res.status === 202 || (contentType && contentType.includes("application/json"))) {
        const data = await res.json();
        showToast(data.message || "Export started in the background. You will be notified when it is ready.", "info");
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

  const handleDeletePage = (pageId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmModal({
      isOpen: true,
      title: "Delete Page",
      message: "Are you sure you want to delete this page? This will also delete all associated panels, OCR regions, and translations.",
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
              const r = await safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
                headers: { Authorization: `Bearer ${user.token}` },
              });
              if (r.ok) {
                const data: Page[] = await r.json();
                setPages(data);
              }
            }
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

    const updatedPages = [...pages];
    const [moved] = updatedPages.splice(index, 1);
    updatedPages.splice(newIndex, 0, moved);

    const finalPages = updatedPages.map((p, idx) => ({
      ...p,
      pageNumber: idx + 1,
    }));
    setPages(finalPages);

    try {
      const res = await safeFetch(`/api/chapters/${selectedChapter.id}/pages/reorder`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify(finalPages.map((p) => p.id)),
      });
      if (!res.ok) throw new Error("Failed to save reorder on backend");
    } catch (err) {
      console.error("Error saving page order:", err);
      if (selectedChapter) {
        safeFetch(`/api/chapters/${selectedChapter.id}/pages`, {
          headers: { Authorization: `Bearer ${user.token}` },
        })
          .then((r) => r.json())
          .then((data) => setPages(data))
          .catch(console.error);
      }
    }
  };

  if (isLoadingDetails || !selectedSeries || !selectedChapter) {
    return (
      <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" minHeight="50vh" gap={2}>
        <CircularProgress />
        <Typography color="text.secondary">Loading chapter details...</Typography>
      </Box>
    );
  }

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box mb={4}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => {
            setSelectedChapter(null);
            navigate(`/series/${selectedSeries.id}/${toSlug(selectedSeries.title)}`);
          }}
          color="inherit"
        >
          Back to Series
        </Button>
      </Box>

      <Paper elevation={0} sx={{ p: 4, mb: 4, borderRadius: 4, bgcolor: 'background.paper' }}>
        <Box display="flex" flexDirection={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems="center" gap={3}>
          <Box>
            <Stack direction="row" alignItems="center" spacing={2} mb={1}>
              <Typography variant="h3" component="h1" sx={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
                Chapter {selectedChapter.chapterNumber}
              </Typography>
              <Tooltip title="Edit Chapter">
                <IconButton onClick={() => setShowEditModal(true)} size="small" sx={{ bgcolor: 'action.hover' }}>
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            <Typography variant="body1" color="text.secondary">
              {selectedSeries.title} / {selectedChapter.title || "Untitled"}
            </Typography>
          </Box>
          <Box display="flex" gap={2} flexWrap="wrap">
            <Button
              variant="outlined"
              startIcon={<ArchiveIcon />}
              onClick={() => document.getElementById("project-import-upload")?.click()}
              disabled={isImportingProject}
            >
              {isImportingProject ? "Importing..." : "Import Project (ZIP)"}
            </Button>
            <Button variant="outlined" startIcon={<ArchiveIcon />} onClick={handleExportChapterZip}>
              Export Chapter (ZIP)
            </Button>
            <Button variant="contained" startIcon={<UploadIcon />} onClick={() => document.getElementById("file-upload")?.click()}>
              Upload Pages
            </Button>
          </Box>
        </Box>
      </Paper>

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

      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>
        Uploaded Pages ({pages.length})
      </Typography>

      <ImageList cols={4} gap={16} sx={{ mb: 4, gridTemplateColumns: { xs: 'repeat(1, 1fr)', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)', lg: 'repeat(4, 1fr)' } }}>
        {pages.map((p, idx) => (
          <ImageListItem key={p.id} sx={{ cursor: 'pointer', borderRadius: 2, overflow: 'hidden', boxShadow: 2, '&:hover .MuiImageListItemBar-root': { opacity: 1 } }}>
            <Box
              component="img"
              src={p.thumbnailUrl || `${p.url}?token=${user.token}`}
              alt={`Page ${p.pageNumber}`}
              loading="lazy"
              onClick={() => {
                onSelectPage(p);
                navigate(
                  `/chapters/${selectedChapter.id}/${toSlug(selectedChapter.title || `chapter-${selectedChapter.chapterNumber}`)}/reader/${p.pageNumber}`
                );
              }}
              sx={{ width: '100%', height: 400, objectFit: 'cover' }}
            />
            <ImageListItemBar
              title={`Page ${p.pageNumber}`}
              sx={{ opacity: 0.9, transition: 'opacity 0.2s' }}
              actionIcon={
                <Stack direction="row" spacing={0.5} mr={1}>
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleMovePage(idx, "left");
                    }}
                    disabled={idx === 0}
                    sx={{ color: 'white', bgcolor: 'rgba(0,0,0,0.5)', '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' } }}
                  >
                    <ArrowLeftIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleMovePage(idx, "right");
                    }}
                    disabled={idx === pages.length - 1}
                    sx={{ color: 'white', bgcolor: 'rgba(0,0,0,0.5)', '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' } }}
                  >
                    <ArrowRightIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={(e) => handleDeletePage(p.id, e)}
                    sx={{ color: 'error.main', bgcolor: 'rgba(0,0,0,0.5)', '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' } }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              }
            />
          </ImageListItem>
        ))}
      </ImageList>

      <Backdrop
        open={dragCounter > 0}
        sx={{
          color: '#fff',
          zIndex: (theme) => theme.zIndex.drawer + 1,
          flexDirection: 'column',
          backdropFilter: 'blur(8px)',
        }}
      >
        <Paper elevation={24} sx={{ p: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', borderRadius: 4, bgcolor: 'rgba(20, 20, 35, 0.9)', border: '2px dashed primary.main' }}>
          <FileUploadIcon sx={{ fontSize: 64, color: 'primary.main', mb: 2 }} />
          <Typography variant="h4" gutterBottom fontWeight={700}>Drop Manga Pages Anywhere</Typography>
          <Typography variant="body1" color="text.secondary">Release to add multiple files to Chapter {selectedChapter.chapterNumber}</Typography>
        </Paper>
      </Backdrop>

      {/* Upload Queue Panel */}
      {showQueuePanel && (
        <Paper
          elevation={12}
          sx={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            width: 360,
            zIndex: 1400,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            transition: 'max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            maxHeight: isQueueExpanded ? 400 : 50,
          }}
        >
          <Box
            sx={{
              p: 1.5,
              bgcolor: 'background.default',
              borderBottom: 1,
              borderColor: 'divider',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              cursor: 'pointer',
            }}
            onClick={() => setIsQueueExpanded(!isQueueExpanded)}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: uploadQueue.some((item) => item.status === "uploading" || item.status === "pending")
                    ? 'warning.main'
                    : 'success.main',
                }}
              />
              <Typography variant="subtitle2" fontWeight={600}>
                {uploadQueue.some((item) => item.status === "uploading" || item.status === "pending")
                  ? `Uploading ${uploadQueue.filter((item) => item.status === "uploading" || item.status === "pending").length} file(s)...`
                  : "Uploads Completed"}
              </Typography>
            </Stack>
            <Stack direction="row" alignItems="center" spacing={1}>
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); setIsQueueExpanded(!isQueueExpanded); }}>
                {isQueueExpanded ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
              </IconButton>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowQueuePanel(false);
                  setUploadQueue([]);
                }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
          </Box>
          
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {uploadQueue.map((item) => (
              <Box key={item.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="caption" noWrap sx={{ maxWidth: '75%', fontWeight: 500 }}>
                    {item.name}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 600,
                      color: item.status === "completed" ? 'success.main' : item.status === "failed" ? 'error.main' : 'text.secondary'
                    }}
                  >
                    {item.status === "uploading" ? `${item.progress}%` : item.status}
                  </Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={item.progress}
                  color={item.status === "completed" ? "success" : item.status === "failed" ? "error" : "primary"}
                  sx={{ height: 4, borderRadius: 2 }}
                />
              </Box>
            ))}
          </Box>
        </Paper>
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

      {selectedChapter && (
        <ChapterDialog
          isOpen={showEditModal}
          editingChapter={selectedChapter}
          series={selectedSeries}
          nextChapterNum={selectedChapter.chapterNumber}
          onClose={() => setShowEditModal(false)}
          onSuccess={(data) => {
            setSelectedChapter(data);
            setShowEditModal(false);
          }}
          token={user.token}
        />
      )}

    </Container>
  );
};

export default ChapterGallery;
