const fs = require('fs');
const file = 'frontend/src/components/Dashboard.tsx';

const content = `import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "./ToastContext";
import type { User, Series } from "../types";
import { safeFetch, toSlug } from "../utils";
import ConfirmModal from "./ConfirmModal";
import SeriesDialog from "./SeriesDialog";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CardMedia from "@mui/material/CardMedia";
import CardActionArea from "@mui/material/CardActionArea";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";

interface DashboardProps {
  user: User;
  seriesList: Series[];
  setSeriesList: React.Dispatch<React.SetStateAction<Series[]>>;
  onSelectSeries: (series: Series) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  user,
  seriesList,
  setSeriesList,
  onSelectSeries,
}) => {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [showSeriesModal, setShowSeriesModal] = useState(false);
  const [editingSeries, setEditingSeries] = useState<Series | null>(null);

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

  const handleEditSeriesClick = (s: Series, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSeries(s);
    setShowSeriesModal(true);
  };

  const handleNewSeriesClick = () => {
    setEditingSeries(null);
    setShowSeriesModal(true);
  };

  const handleCloseSeriesModal = () => {
    setShowSeriesModal(false);
    setEditingSeries(null);
  };

  const handleSeriesSuccess = (data: Series, isEdit: boolean) => {
    if (isEdit) {
      setSeriesList((prev) => prev.map((s) => (s.id === data.id ? data : s)));
      showToast("Series updated successfully", "success");
    } else {
      setSeriesList((prev) => [...prev, data]);
      showToast("Series created successfully", "success");
    }
    handleCloseSeriesModal();
  };

  const handleDeleteSeries = (seriesId: string, e: React.MouseEvent) => {
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
          const res = await safeFetch(\`/api/series/\${seriesId}\`, {
            method: "DELETE",
            headers: { Authorization: \`Bearer \${user.token}\` },
          });
          if (res.ok) {
            setSeriesList((prev) => prev.filter((s) => s.id !== seriesId));
            showToast("Series deleted successfully", "success");
          } else if (res.status === 403) {
            showToast("You don't have permission to delete this series.", "error");
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

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={4}>
        <Box>
          <Typography variant="h4" component="h1" gutterBottom sx={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
            My Manga Library
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Manage translation projects and OCR workflows
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleNewSeriesClick}
        >
          New Series
        </Button>
      </Box>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", md: "repeat(3, 1fr)", lg: "repeat(4, 1fr)" },
          gap: 3,
        }}
      >
        {seriesList.map((s) => (
          <Card key={s.id} sx={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
            <CardActionArea
              onClick={() => {
                onSelectSeries(s);
                navigate(\`/series/\${s.id}/\${toSlug(s.title)}\`);
              }}
              sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
            >
              {s.coverImageUrl ? (
                <CardMedia
                  component="img"
                  height="300"
                  image={s.coverImageUrl}
                  alt={s.title}
                  sx={{ objectFit: 'cover' }}
                />
              ) : (
                <Box
                  sx={{
                    height: 300,
                    bgcolor: 'action.hover',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    p: 2,
                    textAlign: 'center',
                  }}
                >
                  <Typography variant="h6" color="text.secondary">{s.title}</Typography>
                </Box>
              )}

              <CardContent sx={{ flexGrow: 1, p: 2 }}>
                <Typography variant="h6" component="h3" noWrap gutterBottom title={s.title} sx={{ fontWeight: 600 }}>
                  {s.title}
                </Typography>
                
                <Stack direction="row" spacing={1} mb={2} flexWrap="wrap" useFlexGap>
                  <Chip
                    size="small"
                    label={\`\${s.sourceLanguage || s.originalLanguage || "ja"} → \${s.targetLanguage || "en"}\`}
                    variant="outlined"
                  />
                  <Chip
                    size="small"
                    label={s.readingDirection}
                    variant="outlined"
                  />
                  {(s.sourceLanguage || s.originalLanguage || "ja") === (s.targetLanguage || "en") && (
                    <Chip size="small" label="Reader Mode" color="info" />
                  )}
                </Stack>

                {(s.ocrModel || s.tlModel) && (
                  <Stack direction="column" spacing={0.5}>
                    {s.ocrModel && (
                      <Typography variant="caption" color="text.secondary">
                        <strong>OCR:</strong> {s.ocrModel}
                      </Typography>
                    )}
                    {s.tlModel && (
                      <Typography variant="caption" color="text.secondary">
                        <strong>TL:</strong> {s.tlModel}
                      </Typography>
                    )}
                  </Stack>
                )}
              </CardContent>
            </CardActionArea>
            
            <Box sx={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 1 }}>
              <IconButton
                size="small"
                onClick={(e) => handleEditSeriesClick(s, e)}
                sx={{ bgcolor: 'background.paper', '&:hover': { bgcolor: 'background.default' }, boxShadow: 1 }}
              >
                <EditIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                color="error"
                onClick={(e) => handleDeleteSeries(s.id, e)}
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
        editingSeries={editingSeries}
        onClose={handleCloseSeriesModal}
        onSuccess={handleSeriesSuccess}
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

export default Dashboard;
`

fs.writeFileSync(file, content);
console.log('Dashboard.tsx successfully rewritten.');
