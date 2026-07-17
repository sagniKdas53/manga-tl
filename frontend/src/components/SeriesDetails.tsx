import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import ImportExportIcon from "@mui/icons-material/ImportExport";
import UploadIcon from "@mui/icons-material/Upload";
import { useToast } from "./ToastContext";
import type { User, Series, Chapter } from "../types";
import { safeFetch, toSlug } from "../utils";
import ConfirmModal from "./ConfirmModal";
import CreateChapterDialog from "./CreateChapterDialog";
import EditSeriesDialog from "./EditSeriesDialog";
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
      <div className="dashboard-content text-center">
        <div className="spinner"></div>
        <p>Loading series details...</p>
      </div>
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
    <div className="dashboard-content nhentai-style">
      <Button
        onClick={() => navigate("/")}
        variant="outlined"
        size="small"
        sx={{ mb: 2 }}
      >
        ← Back to Library
      </Button>

      <div className="series-details-container">
        <div className="series-cover-column">
          {selectedSeries.coverImageUrl ? (
            <img
              src={selectedSeries.coverImageUrl}
              className="series-large-cover"
              alt={selectedSeries.title}
            />
          ) : (
            <div className="series-large-cover-placeholder">
              <span>{selectedSeries.title}</span>
            </div>
          )}
        </div>

        <div className="series-info-column">
          <h1 className="series-title">{selectedSeries.title}</h1>

          <div className="nhentai-meta-table">
            <div className="meta-row">
              <span className="meta-label">Language:</span>
              <span className="meta-value">
                <span className="meta-badge-nhentai">
                  {selectedSeries.sourceLanguage ||
                    selectedSeries.originalLanguage ||
                    "ja"}{" "}
                  → {selectedSeries.targetLanguage || "en"}
                  {(selectedSeries.sourceLanguage ||
                    selectedSeries.originalLanguage ||
                    "ja") === (selectedSeries.targetLanguage || "en")
                    ? " (Reader Mode)"
                    : ""}
                </span>
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-label">Direction:</span>
              <span className="meta-value">
                <span className="meta-badge-nhentai">
                  {selectedSeries.readingDirection}
                </span>
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-label">Chapters:</span>
              <span className="meta-value">{chapters.length}</span>
            </div>
          </div>

          <div className="series-actions-row">
            <Stack
              direction="row"
              spacing={1}
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
                startIcon={<UploadIcon />}
                onClick={() => setShowImportModal(true)}
              >
                Import Chapter (ZIP)
              </Button>
              <Button
                variant="outlined"
                onClick={handleEditSeriesClick}
              >
                Edit Series
              </Button>
              <Button
                variant="outlined"
                color="error"
                onClick={handleDeleteSeries}
              >
                Delete Series
              </Button>
            </Stack>
          </div>
        </div>
      </div>

      <div
        className="chapters-section-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2>Chapters ({chapters.length})</h2>
        <Button
          variant="outlined"
          size="small"
          startIcon={<ImportExportIcon />}
          onClick={() => {
            const nextSort = !sortAsc;
            setSortAsc(nextSort);
            localStorage.setItem("chapters_sort_asc", String(nextSort));
          }}
        >
          Sort: {sortAsc ? "Ascending ↑" : "Descending ↓"}
        </Button>
      </div>

      <div className="chapters-grid">
        {[...chapters]
          .sort((a, b) =>
            sortAsc
              ? a.chapterNumber - b.chapterNumber
              : b.chapterNumber - a.chapterNumber,
          )
          .map((c) => (
            <div
              key={c.id}
              className="chapter-card-nhentai"
              onClick={() => {
                onSelectChapter(c);
                navigate(
                  `/chapters/${c.id}/${toSlug(c.title || `chapter-${c.chapterNumber}`)}`,
                );
              }}
            >
              <div className="chapter-cover-container-nhentai">
                {c.coverImageUrl ? (
                  <img
                    src={c.coverImageUrl}
                    className="chapter-cover-img-nhentai"
                    alt={c.title || `Chapter ${c.chapterNumber}`}
                  />
                ) : selectedSeries.coverImageUrl ? (
                  <img
                    src={selectedSeries.coverImageUrl}
                    className="chapter-cover-img-nhentai fallback"
                    alt="Fallback Cover"
                  />
                ) : (
                  <div className="chapter-cover-placeholder-nhentai">
                    <span>C{c.chapterNumber}</span>
                  </div>
                )}

                <div
                  className="chapter-actions-overlay"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="action-btn-small"
                    onClick={(e) => handleEditChapterClick(c, e)}
                    title="Edit Chapter"
                  >
                    <svg
                      width="12"
                      height="12"
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
                  <button
                    className="action-btn-small delete-btn"
                    onClick={(e) => handleDeleteChapter(c.id, e)}
                    title="Delete Chapter"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                  </button>
                </div>
              </div>

              <div className="chapter-card-info-nhentai">
                <div className="chapter-card-number-nhentai">
                  Chapter {c.chapterNumber}
                </div>
                <div
                  className="chapter-card-title-nhentai"
                  title={c.title || "Untitled"}
                >
                  {c.title || "Untitled"}
                </div>
                {(c.pageCount ||
                  c.useContextMemory !== undefined ||
                  c.resolvedOcr ||
                  c.resolvedTranslation) && (
                  <Box
                    sx={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 0.5,
                      mt: 0.75,
                    }}
                  >
                    {c.pageCount !== undefined && c.pageCount > 0 && (
                      <Chip
                        label={`${c.pageCount} pages`}
                        size="small"
                        variant="outlined"
                        title="Total pages in this chapter"
                      />
                    )}
                    {c.useContextMemory !== undefined && (
                      <Chip
                        label={c.useContextMemory ? "Context" : "No Context"}
                        size="small"
                        variant="outlined"
                        color={c.useContextMemory ? "primary" : "default"}
                        title={
                          c.useContextMemory
                            ? "Context memory enabled"
                            : "Context memory disabled"
                        }
                      />
                    )}
                    {(c.resolvedOcr || c.resolvedTranslation) && (
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          fontSize: "10px",
                          lineHeight: "20px",
                        }}
                      >
                        {c.resolvedOcr && c.resolvedOcr.source !== "global"
                          ? `OCR: ${c.resolvedOcr.provider}${c.resolvedOcr.model ? " / " + c.resolvedOcr.model : ""} (${c.resolvedOcr.source})`
                          : ""}
                        {c.resolvedOcr &&
                        c.resolvedOcr.source !== "global" &&
                        c.resolvedTranslation &&
                        c.resolvedTranslation.source !== "global"
                          ? " | "
                          : ""}
                        {c.resolvedTranslation &&
                        c.resolvedTranslation.source !== "global"
                          ? `TL: ${c.resolvedTranslation.provider}${c.resolvedTranslation.model ? " / " + c.resolvedTranslation.model : ""} (${c.resolvedTranslation.source})`
                          : ""}
                      </Typography>
                    )}
                  </Box>
                )}
              </div>
            </div>
          ))}
      </div>

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
    </div>
  );
};

export default React.memo(SeriesDetails);
