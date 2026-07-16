const fs = require('fs');
const file = 'frontend/src/components/SeriesDetails.tsx';

const content = `import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "./ToastContext";
import type { User, Series, Chapter, SystemSettingsDto } from "../types";
import { safeFetch, toSlug } from "../utils";
import ConfirmModal from "./ConfirmModal";
import SeriesDialog from "./SeriesDialog";
import ChapterDialog from "./ChapterDialog";
import ImportChapterDialog from "./ImportChapterDialog";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import CardMedia from "@mui/material/CardMedia";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import UploadIcon from "@mui/icons-material/Upload";
import CircularProgress from "@mui/material/CircularProgress";

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
  const { showToast } = useToast();

  const [sortAsc, setSortAsc] = useState<boolean>(() => {
    const cached = localStorage.getItem("chapters_sort_asc");
    return cached === null ? true : cached === "true";
  });

  const [showSeriesModal, setShowSeriesModal] = useState(false);
  const [showChapterModal, setShowChapterModal] = useState(false);
  const [editingChapter, setEditingChapter] = useState<Chapter | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);

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
      <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" minHeight="50vh" gap={2}>
        <CircularProgress />
        <Typography color="text.secondary">Loading series details...</Typography>
      </Box>
    );
  }

  const nextChapterNum = chapters.reduce(
    (max, c) => (c.chapterNumber > max ? c.chapterNumber : max),
    0,
  ) + 1;

  const handleEditSeriesClick = () => setShowSeriesModal(true);
  const handleSeriesSuccess = (data: Series) => {
    setSelectedSeries(data);
    setShowSeriesModal(false);
  };
  const handleDeleteSeries = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmModal({
      isOpen: true,
      title: "Delete Series",
      message: "Are you sure you want to delete this series? This will delete all chapters and pages!",
      confirmText: "Delete Series",
      isDangerous: true,
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await safeFetch(\`/api/series/\${selectedSeries.id}\`, {
            method: "DELETE",
            headers: { Authorization: \`Bearer \${user.token}\` },
          });
          if (res.ok) {
            setSelectedSeries(null);
            navigate("/");
            showToast("Series deleted successfully", "success");
          } else {
            showToast("Failed to delete series", "error");
          }
        } catch (err) {
          console.error(err);
          showToast("Error deleting series", "error");
        }
      },
    });
  };

  const handleEditChapterClick = (c: Chapter, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChapter(c);
    setShowChapterModal(true);
  };
  const handleNewChapterClick = () => {
    setEditingChapter(null);
    setShowChapterModal(true);
  };
  const handleImportChapterClick = () => setShowImportModal(true);

  const handleChapterSuccess = (data: Chapter, isEdit: boolean) => {
    if (isEdit) {
      setChapters((prev) => prev.map((c) => (c.id === data.id ? data : c)));
    } else {
      setChapters((prev) => [...prev, data]);
    }
    setShowChapterModal(false);
    setEditingChapter(null);
  };

  const handleImportSuccess = (data: Chapter) => {
    setChapters((prev) => [...prev, data]);
    setShowImportModal(false);
  };

  const handleDeleteChapter = (chapterId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmModal({
      isOpen: true,
      title: "Delete Chapter",
      message: "Are you sure you want to delete this chapter? This will delete all its pages and translation data!",
      confirmText: "Delete Chapter",
      isDangerous: true,
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await safeFetch(\`/api/series/chapters/\${chapterId}\`, {
            method: "DELETE",
            headers: { Authorization: \`Bearer \${user.token}\` },
          });
          if (res.ok) {
            setChapters((prev) => prev.filter((c) => c.id !== chapterId));
            showToast("Chapter deleted successfully", "success");
          } else {
            showToast("Failed to delete chapter", "error");
          }
        } catch (err) {
          console.error(err);
          showToast("Error deleting chapter", "error");
        }
      },
    });
  };

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box mb={4}>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate("/")} color="inherit">
          Back to Library
        </Button>
      </Box>

      <Paper elevation={0} sx={{ p: 4, mb: 6, borderRadius: 4, bgcolor: 'background.paper', display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 4 }}>
        <Box flexShrink={0}>
          {selectedSeries.coverImageUrl ? (
            <Box
              component="img"
              src={selectedSeries.coverImageUrl}
              alt={selectedSeries.title}
              sx={{ width: 240, height: 340, objectFit: 'cover', borderRadius: 2, boxShadow: 3 }}
            />
          ) : (
            <Box
              sx={{ width: 240, height: 340, bgcolor: 'action.hover', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2, textAlign: 'center' }}
            >
              <Typography variant="h6" color="text.secondary">{selectedSeries.title}</Typography>
            </Box>
          )}
        </Box>

        <Box display="flex" flexDirection="column" flexGrow={1} gap={3}>
          <Typography variant="h3" component="h1" sx={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
            {selectedSeries.title}
          </Typography>

          <Box display="grid" gridTemplateColumns="auto 1fr" gap={2} alignItems="center">
            <Typography color="text.secondary" fontWeight={600}>Language:</Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip label={\`\${selectedSeries.sourceLanguage || selectedSeries.originalLanguage || "ja"} → \${selectedSeries.targetLanguage || "en"}\`} color="primary" variant="outlined" />
              {(selectedSeries.sourceLanguage || selectedSeries.originalLanguage || "ja") === (selectedSeries.targetLanguage || "en") && (
                <Chip label="Reader Mode" color="info" size="small" />
              )}
            </Stack>

            <Typography color="text.secondary" fontWeight={600}>Direction:</Typography>
            <Chip label={selectedSeries.readingDirection} variant="outlined" sx={{ width: 'fit-content' }} />

            <Typography color="text.secondary" fontWeight={600}>Chapters:</Typography>
            <Typography>{chapters.length}</Typography>
          </Box>

          <Box mt="auto" display="flex" gap={2} flexWrap="wrap">
            <Button variant="contained" startIcon={<AddIcon />} onClick={handleNewChapterClick}>
              Add Chapter
            </Button>
            <Button variant="outlined" startIcon={<UploadIcon />} onClick={handleImportChapterClick}>
              Import Chapter (ZIP/ePub)
            </Button>
            <Button variant="outlined" startIcon={<EditIcon />} onClick={handleEditSeriesClick}>
              Edit Series
            </Button>
            <Button variant="outlined" color="error" startIcon={<DeleteIcon />} onClick={handleDeleteSeries}>
              Delete Series
            </Button>
          </Box>
        </Box>
      </Paper>

      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h5" component="h2" sx={{ fontWeight: 600 }}>
          Chapters ({chapters.length})
        </Typography>
        <Button
          variant="outlined"
          color="inherit"
          onClick={() => {
            const nextSort = !sortAsc;
            setSortAsc(nextSort);
            localStorage.setItem("chapters_sort_asc", String(nextSort));
          }}
        >
          Sort: {sortAsc ? "Ascending ↑" : "Descending ↓"}
        </Button>
      </Box>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", md: "repeat(3, 1fr)", lg: "repeat(4, 1fr)" },
          gap: 3,
        }}
      >
        {[...chapters]
          .sort((a, b) =>
            sortAsc
              ? a.chapterNumber - b.chapterNumber
              : b.chapterNumber - a.chapterNumber,
          )
          .map((c) => (
            <Card key={c.id} sx={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
              <CardActionArea
                onClick={() => {
                  onSelectChapter(c);
                  navigate(\`/chapters/\${c.id}/\${toSlug(c.title || \`chapter-\${c.chapterNumber}\`)}\`);
                }}
                sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
              >
                {c.coverImageUrl ? (
                  <CardMedia
                    component="img"
                    height="200"
                    image={c.coverImageUrl}
                    alt={c.title || \`Chapter \${c.chapterNumber}\`}
                    sx={{ objectFit: 'cover' }}
                  />
                ) : selectedSeries.coverImageUrl ? (
                  <CardMedia
                    component="img"
                    height="200"
                    image={selectedSeries.coverImageUrl}
                    alt="Fallback Cover"
                    sx={{ objectFit: 'cover', opacity: 0.8 }}
                  />
                ) : (
                  <Box sx={{ height: 200, bgcolor: 'action.hover', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Typography variant="h5" color="text.secondary">C{c.chapterNumber}</Typography>
                  </Box>
                )}

                <CardContent sx={{ flexGrow: 1, p: 2 }}>
                  <Typography variant="subtitle2" color="primary" gutterBottom>
                    Chapter {c.chapterNumber}
                  </Typography>
                  <Typography variant="body1" sx={{ fontWeight: 500 }} noWrap title={c.title || "Untitled"}>
                    {c.title || "Untitled"}
                  </Typography>
                </CardContent>
              </CardActionArea>
              
              <Box sx={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 1 }}>
                <IconButton
                  size="small"
                  onClick={(e) => handleEditChapterClick(c, e)}
                  sx={{ bgcolor: 'background.paper', '&:hover': { bgcolor: 'background.default' }, boxShadow: 1 }}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  color="error"
                  onClick={(e) => handleDeleteChapter(c.id, e)}
                  sx={{ bgcolor: 'background.paper', '&:hover': { bgcolor: 'background.default' }, boxShadow: 1 }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            </Card>
          ))}
      </Box>

      <SeriesDialog
        isOpen={showSeriesModal}
        editingSeries={selectedSeries}
        onClose={() => setShowSeriesModal(false)}
        onSuccess={handleSeriesSuccess}
        token={user.token}
      />
      
      <ChapterDialog
        isOpen={showChapterModal}
        editingChapter={editingChapter}
        series={selectedSeries}
        nextChapterNum={nextChapterNum}
        onClose={() => {
          setShowChapterModal(false);
          setEditingChapter(null);
        }}
        onSuccess={handleChapterSuccess}
        token={user.token}
      />
      
      <ImportChapterDialog
        isOpen={showImportModal}
        series={selectedSeries}
        nextChapterNum={nextChapterNum}
        onClose={() => setShowImportModal(false)}
        onSuccess={handleImportSuccess}
        token={user.token}
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
`

fs.writeFileSync(file, content);
console.log('SeriesDetails.tsx successfully rewritten.');
