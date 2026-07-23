import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import { useToast } from "./ToastContext";
import type { User, Series, Chapter } from "../types";
import { safeFetch } from "../utils";
import ConfirmModal from "./ConfirmModal";
import CreateChapterDialog from "./CreateChapterDialog";
import EditSeriesDialog from "./EditSeriesDialog";
import ImportChapterDialog from "./ImportChapterDialog";
import SeriesHeader from "./SeriesHeader";
import ChapterCardGrid from "./ChapterCardGrid";

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
  const [chapterCreateCounter, setChapterCreateCounter] = useState(0);
  const { showToast } = useToast();

  const [showImportModal, setShowImportModal] = useState(false);

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
          justifyContent: "center",
          alignItems: "center",
          minHeight: "60vh",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <CircularProgress />
        <Typography>Loading series details...</Typography>
      </Box>
    );
  }

  // --- SERIES ACTIONS ---
  const handleEditSeriesClick = () => {
    setShowSeriesModal(true);
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
            showToast(
              "You don't have permission to delete this series.",
              "error",
            );
          } else {
            showToast("Failed to delete series", "error");
          }
        } catch (err) {
          console.error("Error deleting series:", err);
          showToast("Error deleting series", "error");
        }
      },
    });
  };

  // --- CHAPTER ACTIONS ---
  const handleEditChapterClick = (c: Chapter, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChapter(c);
    setShowChapterModal(true);
  };

  const handleNewChapterClick = () => {
    setEditingChapter(null);
    setChapterCreateCounter((c) => c + 1);
    setShowChapterModal(true);
  };

  const handleCancelChapterModal = () => {
    setShowChapterModal(false);
    setEditingChapter(null);
  };

  const handleChapterSuccess = (data: Chapter) => {
    if (editingChapter) {
      setChapters((prev) => prev.map((c) => (c.id === data.id ? data : c)));
    } else {
      setChapters((prev) => [...prev, data]);
    }
  };

  const handleChapterError = (msg: string) => {
    showToast(msg, "error");
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
            showToast(
              "You don't have permission to delete this chapter.",
              "error",
            );
          } else {
            showToast("Failed to delete chapter", "error");
          }
        } catch (err) {
          console.error("Error deleting chapter:", err);
          showToast("Error deleting chapter", "error");
        }
      },
    });
  };

  return (
    <Box
      sx={{
        maxWidth: 1200,
        mx: "auto",
        width: "100%",
        px: { xs: 2, sm: 3 },
        py: 3,
      }}
    >
      <Button
        onClick={() => navigate("/")}
        variant="outlined"
        size="small"
        sx={{ mb: 2 }}
      >
        ← Back to Library
      </Button>

      <SeriesHeader
        series={selectedSeries}
        chapterCount={chapters.length}
        user={user}
        onAddChapter={handleNewChapterClick}
        onImportChapter={() => setShowImportModal(true)}
        onEditSeries={handleEditSeriesClick}
        onDeleteSeries={handleDeleteSeries}
      />

      <ChapterCardGrid
        chapters={chapters}
        series={selectedSeries}
        sortAsc={sortAsc}
        onToggleSort={() => {
          const nextSort = !sortAsc;
          setSortAsc(nextSort);
          localStorage.setItem("chapters_sort_asc", String(nextSort));
        }}
        onSelectChapter={onSelectChapter}
        onEditChapter={handleEditChapterClick}
        onDeleteChapter={handleDeleteChapter}
        onNavigate={(path) => navigate(path)}
      />

      <EditSeriesDialog
        open={showSeriesModal}
        series={selectedSeries!}
        user={user}
        onClose={() => setShowSeriesModal(false)}
        onSuccess={(data) => setSelectedSeries(data)}
      />

      <CreateChapterDialog
        key={editingChapter?.id ?? `new-${chapterCreateCounter}`}
        open={showChapterModal}
        editingChapter={editingChapter}
        user={user}
        selectedSeries={selectedSeries}
        chapters={chapters}
        onClose={handleCancelChapterModal}
        onSuccess={handleChapterSuccess}
        onError={handleChapterError}
      />
      <ImportChapterDialog
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={(chapter) => {
          setChapters((prev) => [...prev, chapter]);
        }}
        user={user}
        series={selectedSeries!}
        nextNum={
          chapters.reduce(
            (max, c) => (c.chapterNumber > max ? c.chapterNumber : max),
            0,
          ) + 1
        }
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
    </Box>
  );
};

export default React.memo(SeriesDetails);
