import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Grid from "@mui/material/Grid";
import Card from "@mui/material/Card";

import IconButton from "@mui/material/IconButton";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import SortIcon from "@mui/icons-material/Sort";

import { useToast } from "./ToastContext";
import type { User, Series, Chapter, SystemSettingsDto } from "../types";
import { safeFetch, toSlug } from "../utils";
import ConfirmModal from "./ConfirmModal";
import SeriesDialog from "./SeriesDialog";
import ChapterDialog from "./ChapterDialog";
import ImportChapterDialog from "./ImportChapterDialog";

interface SeriesDetailsProps {
  user: User;
  selectedSeries: Series | null;
  setSelectedSeries: React.Dispatch<React.SetStateAction<Series | null>>;
  chapters: Chapter[];
  setChapters: React.Dispatch<React.SetStateAction<Chapter[]>>;
  onSelectChapter: (chapter: Chapter) => void;
  isLoadingDetails: boolean;
}

export const SeriesDetails: React.FC<SeriesDetailsProps> = ({
  user,
  selectedSeries,
  setSelectedSeries,
  chapters,
  setChapters,
  onSelectChapter,
  isLoadingDetails,
}) => {
  const navigate = useNavigate();

  const [sortAsc, setSortAsc] = useState<boolean>(() => {
    const cached = localStorage.getItem("chapters_sort_asc");
    return cached === null ? true : cached === "true";
  });

  const [showSeriesModal, setShowSeriesModal] = useState(false);

  const [showChapterModal, setShowChapterModal] = useState(false);
  const [editingChapter, setEditingChapter] = useState<Chapter | null>(null);
  const [chapterError, setChapterError] = useState("");

  const { showToast, showError } = useToast();
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);

  const [showImportModal, setShowImportModal] = useState(false);
  const [importError, setImportError] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  React.useEffect(() => {
    if ((showSeriesModal || showChapterModal || showImportModal) && !settings) {
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => setSettings(data))
        .catch(console.error);
    }
  }, [
    showSeriesModal,
    showChapterModal,
    showImportModal,
    settings,
    user.token,
  ]);

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

  if (isLoadingDetails || !selectedSeries) {
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
          Loading series details...
        </Typography>
      </Box>
    );
  }

  // --- SERIES ACTIONS ---
  const handleEditSeriesClick = () => {
    setShowSeriesModal(true);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSaveSeries = async (data: any) => {
    try {
      const res = await safeFetch(`/api/series/${selectedSeries.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const updated: Series = await res.json();
        setSelectedSeries(updated);
        setShowSeriesModal(false);
      }
    } catch (err) {
      console.error("Error updating series:", err);
    }
  };

  const handleDeleteSeries = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmModal({
      isOpen: true,
      title: "Delete Series",
      message:
        "Are you sure you want to delete this series? This will delete all chapters and pages!",
      confirmText: "Delete Series",
      isDangerous: true,
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await safeFetch(`/api/series/${selectedSeries.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${user.token}` },
          });
          if (res.ok) {
            setSelectedSeries(null);
            navigate("/");
            showToast("Series deleted successfully", "success");
          } else if (res.status === 403) {
            showError("You don't have permission to delete this series.");
          } else {
            showError("Failed to delete series");
          }
        } catch (err) {
          console.error("Error deleting series:", err);
          showError("Error deleting series");
        }
      },
    });
  };

  // --- CHAPTER ACTIONS ---
  const handleEditChapterClick = (c: Chapter, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChapter(c);
    setChapterError("");
    setShowChapterModal(true);
  };

  const handleNewChapterClick = () => {
    setEditingChapter(null);
    setChapterError("");
    setShowChapterModal(true);
  };

  const handleImportChapterClick = () => {
    setImportError("");
    setIsImporting(false);
    setShowImportModal(true);
  };

  const handleImportSubmit = async (formData: FormData) => {
    if (!selectedSeries) return;
    setImportError("");
    setIsImporting(true);

    try {
      const res = await safeFetch(
        `/api/series/${selectedSeries.id}/chapters/import`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${user.token}`,
          },
          body: formData,
        },
      );

      if (res.ok) {
        const data: Chapter = await res.json();
        setChapters((prev) => [...prev, data]);
        setShowImportModal(false);
      } else {
        let errMsg = "Failed to import chapter";
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
        setImportError(errMsg);
      }
    } catch (err) {
      console.error("Error importing chapter:", err);
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsImporting(false);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSaveChapter = async (data: any) => {
    setChapterError("");
    try {
      const isEdit = !!editingChapter;
      const url = isEdit
        ? `/api/series/chapters/${editingChapter.id}`
        : `/api/series/${selectedSeries.id}/chapters`;
      const method = isEdit ? "PUT" : "POST";

      const res = await safeFetch(url, {
        method: method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const savedData: Chapter = await res.json();
        if (isEdit) {
          setChapters((prev) =>
            prev.map((c) => (c.id === savedData.id ? savedData : c)),
          );
        } else {
          setChapters((prev) => [...prev, savedData]);
        }
        setShowChapterModal(false);
        setEditingChapter(null);
        setChapterError("");
      } else {
        let errMsg = "Failed to save chapter";
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
        setChapterError(errMsg);
      }
    } catch (err) {
      console.error("Error saving chapter:", err);
      setChapterError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteChapter = (chapterId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmModal({
      isOpen: true,
      title: "Delete Chapter",
      message:
        "Are you sure you want to delete this chapter? This will delete all pages!",
      confirmText: "Delete Chapter",
      isDangerous: true,
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await safeFetch(`/api/series/chapters/${chapterId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${user.token}` },
          });
          if (res.ok) {
            setChapters((prev) => prev.filter((c) => c.id !== chapterId));
            showToast("Chapter deleted successfully", "success");
          } else if (res.status === 403) {
            showError("You don't have permission to delete this chapter.");
          } else {
            showError("Failed to delete chapter");
          }
        } catch (err) {
          console.error("Error deleting chapter:", err);
          showError("Error deleting chapter");
        }
      },
    });
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
          onClick={() => navigate("/")}
          sx={{ mb: 3 }}
        >
          Back to Library
        </Button>
      </Box>

      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", md: "row" },
          gap: 4,
          mb: 6,
        }}
      >
        <Box sx={{ width: { xs: "100%", md: "300px" }, flexShrink: 0 }}>
          {selectedSeries.coverImageUrl ? (
            <img
              src={selectedSeries.coverImageUrl}
              alt={selectedSeries.title}
              style={{
                width: "100%",
                borderRadius: "12px",
                boxShadow: "0 4px 20px rgba(0,0,0,0.1)",
              }}
            />
          ) : (
            <Box
              sx={{
                width: "100%",
                aspectRatio: "2/3",
                bgcolor: "action.hover",
                borderRadius: 2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Typography
                variant="h6"
                color="text.secondary"
                textAlign="center"
                px={2}
              >
                {selectedSeries.title}
              </Typography>
            </Box>
          )}
        </Box>

        <Box sx={{ flexGrow: 1 }}>
          <Typography
            variant="h3"
            component="h1"
            fontWeight="bold"
            gutterBottom
          >
            {selectedSeries.title}
          </Typography>

          <Stack
            spacing={2}
            sx={{ mb: 4, maxWidth: "400px" }}
          >
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                borderBottom: 1,
                borderColor: "divider",
                pb: 1,
              }}
            >
              <Typography
                color="text.secondary"
                fontWeight="bold"
              >
                Language:
              </Typography>
              <Chip
                size="small"
                color="primary"
                label={`${selectedSeries.sourceLanguage || selectedSeries.originalLanguage || "ja"} → ${selectedSeries.targetLanguage || "en"} ${(selectedSeries.sourceLanguage || selectedSeries.originalLanguage || "ja") === (selectedSeries.targetLanguage || "en") ? " (Reader Mode)" : ""}`}
              />
            </Box>
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                borderBottom: 1,
                borderColor: "divider",
                pb: 1,
              }}
            >
              <Typography
                color="text.secondary"
                fontWeight="bold"
              >
                Direction:
              </Typography>
              <Chip
                size="small"
                label={selectedSeries.readingDirection}
              />
            </Box>
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                borderBottom: 1,
                borderColor: "divider",
                pb: 1,
              }}
            >
              <Typography
                color="text.secondary"
                fontWeight="bold"
              >
                Chapters:
              </Typography>
              <Typography fontWeight="bold">{chapters.length}</Typography>
            </Box>
          </Stack>

          <Stack
            direction="row"
            spacing={2}
            flexWrap="wrap"
            useFlexGap
          >
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={handleNewChapterClick}
            >
              Add Chapter
            </Button>
            <Button
              variant="outlined"
              startIcon={<FileUploadIcon />}
              onClick={handleImportChapterClick}
            >
              Import Chapter
            </Button>
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<EditIcon />}
              onClick={handleEditSeriesClick}
            >
              Edit Series
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={handleDeleteSeries}
            >
              Delete
            </Button>
          </Stack>
        </Box>
      </Box>

      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 3,
        }}
      >
        <Typography
          variant="h5"
          component="h2"
          fontWeight="bold"
        >
          Chapters ({chapters.length})
        </Typography>
        <Button
          variant="outlined"
          color="inherit"
          startIcon={<SortIcon />}
          onClick={() => {
            const nextSort = !sortAsc;
            setSortAsc(nextSort);
            localStorage.setItem("chapters_sort_asc", String(nextSort));
          }}
          size="small"
        >
          Sort: {sortAsc ? "Ascending ↑" : "Descending ↓"}
        </Button>
      </Box>

      <Grid
        container
        spacing={2}
      >
        {[...chapters]
          .sort((a, b) =>
            sortAsc
              ? a.chapterNumber - b.chapterNumber
              : b.chapterNumber - a.chapterNumber,
          )
          .map((c) => (
            <Grid
              item
              xs={12}
              sm={6}
              md={4}
              lg={3}
              key={c.id}
            >
              <Card
                sx={{
                  display: "flex",
                  alignItems: "center",
                  p: 1.5,
                  cursor: "pointer",
                  transition: "background-color 0.2s",
                  "&:hover": { bgcolor: "action.hover" },
                }}
                onClick={() => {
                  onSelectChapter(c);
                  navigate(
                    `/chapters/${c.id}/${toSlug(c.title || `chapter-${c.chapterNumber}`)}`,
                  );
                }}
              >
                <Box
                  sx={{
                    position: "relative",
                    width: 60,
                    height: 80,
                    flexShrink: 0,
                    mr: 2,
                    borderRadius: 1,
                    overflow: "hidden",
                    bgcolor: "action.hover",
                  }}
                >
                  {c.coverImageUrl || selectedSeries.coverImageUrl ? (
                    <img
                      src={c.coverImageUrl || selectedSeries.coverImageUrl}
                      alt={c.title || `Chapter ${c.chapterNumber}`}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                  ) : (
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        height: "100%",
                      }}
                    >
                      <Typography
                        variant="caption"
                        fontWeight="bold"
                      >
                        C{c.chapterNumber}
                      </Typography>
                    </Box>
                  )}
                </Box>

                <Box sx={{ flexGrow: 1, overflow: "hidden" }}>
                  <Typography
                    variant="subtitle1"
                    fontWeight="bold"
                    noWrap
                  >
                    Chapter {c.chapterNumber}
                  </Typography>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    noWrap
                  >
                    {c.title || "Untitled"}
                  </Typography>
                </Box>

                <Box
                  sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
                >
                  <Tooltip title="Edit Chapter">
                    <IconButton
                      size="small"
                      onClick={(e) => handleEditChapterClick(c, e)}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete Chapter">
                    <IconButton
                      size="small"
                      color="error"
                      onClick={(e) => handleDeleteChapter(c.id, e)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Card>
            </Grid>
          ))}
      </Grid>

      <SeriesDialog
        isOpen={showSeriesModal}
        onClose={() => setShowSeriesModal(false)}
        onSave={handleSaveSeries}
        initialData={selectedSeries}
        settings={settings}
      />

      <ChapterDialog
        isOpen={showChapterModal}
        onClose={() => {
          setShowChapterModal(false);
          setEditingChapter(null);
          setChapterError("");
        }}
        onSave={handleSaveChapter}
        initialData={editingChapter}
        defaultChapterNumber={
          chapters.reduce(
            (max, c) => (c.chapterNumber > max ? c.chapterNumber : max),
            0,
          ) + 1
        }
        settings={settings}
        error={chapterError}
      />

      <ImportChapterDialog
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImport={handleImportSubmit}
        defaultChapterNumber={
          chapters.reduce(
            (max, c) => (c.chapterNumber > max ? c.chapterNumber : max),
            0,
          ) + 1
        }
        settings={settings}
        error={importError}
        isImporting={isImporting}
      />

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        isDangerous={confirmModal.isDangerous}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirmModal}
      />
    </Container>
  );
};

export default SeriesDetails;
