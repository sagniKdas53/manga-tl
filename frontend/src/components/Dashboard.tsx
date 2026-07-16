import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Container from "@mui/material/Container";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Grid from "@mui/material/Grid";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardMedia from "@mui/material/CardMedia";
import CardContent from "@mui/material/CardContent";
import IconButton from "@mui/material/IconButton";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import Tooltip from "@mui/material/Tooltip";

import { useToast } from "./ToastContext";
import type { User, Series } from "../types";
import { safeFetch, toSlug } from "../utils";
import type { SystemSettingsDto } from "../types";
import ConfirmModal from "./ConfirmModal";
import SeriesDialog from "./SeriesDialog";

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
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);

  React.useEffect(() => {
    if (showSeriesModal && !settings) {
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => setSettings(data))
        .catch(console.error);
    }
  }, [showSeriesModal, settings, user.token]);

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSaveSeries = async (data: any) => {
    try {
      const isEdit = !!editingSeries;
      const url = isEdit ? `/api/series/${editingSeries.id}` : "/api/series";
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
        const savedData: Series = await res.json();
        if (isEdit) {
          setSeriesList((prev) =>
            prev.map((s) => (s.id === savedData.id ? savedData : s)),
          );
        } else {
          setSeriesList((prev) => [...prev, savedData]);
        }
        setShowSeriesModal(false);
        setEditingSeries(null);
      }
    } catch (err) {
      console.error("Error saving series:", err);
    }
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
          const res = await safeFetch(`/api/series/${seriesId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${user.token}` },
          });
          if (res.ok) {
            setSeriesList((prev) => prev.filter((s) => s.id !== seriesId));
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

  return (
    <Container
      maxWidth="lg"
      sx={{ py: 4 }}
    >
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 4,
          flexWrap: "wrap",
          gap: 2,
        }}
      >
        <Box>
          <Typography
            variant="h4"
            component="h1"
            fontWeight="bold"
          >
            My Manga Library
          </Typography>
          <Typography
            variant="body1"
            color="text.secondary"
          >
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

      <Grid
        container
        spacing={3}
      >
        {seriesList.map((s) => (
          <Grid
            item
            xs={12}
            sm={6}
            md={4}
            key={s.id}
          >
            <Card
              sx={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                transition: "transform 0.2s",
                "&:hover": { transform: "translateY(-4px)" },
                position: "relative",
              }}
            >
              <CardActionArea
                onClick={() => {
                  onSelectSeries(s);
                  navigate(`/series/${s.id}/${toSlug(s.title)}`);
                }}
                sx={{
                  flexGrow: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                }}
              >
                {s.coverImageUrl ? (
                  <CardMedia
                    component="img"
                    height="200"
                    image={s.coverImageUrl}
                    alt={s.title}
                    sx={{ objectFit: "cover" }}
                  />
                ) : (
                  <Box
                    sx={{
                      height: 200,
                      width: "100%",
                      bgcolor: "action.hover",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Typography
                      variant="body1"
                      color="text.secondary"
                    >
                      No Cover
                    </Typography>
                  </Box>
                )}

                <CardContent sx={{ width: "100%" }}>
                  <Typography
                    gutterBottom
                    variant="h6"
                    component="h3"
                    noWrap
                    title={s.title}
                  >
                    {s.title}
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ mt: 1 }}
                  >
                    <Chip
                      size="small"
                      label={`${s.sourceLanguage || s.originalLanguage || "ja"} → ${s.targetLanguage || "en"}`}
                      color={
                        (s.sourceLanguage || s.originalLanguage || "ja") ===
                        (s.targetLanguage || "en")
                          ? "secondary"
                          : "primary"
                      }
                      variant="outlined"
                    />
                    <Chip
                      size="small"
                      label={s.readingDirection}
                      variant="outlined"
                    />
                  </Stack>
                </CardContent>
              </CardActionArea>

              <Box
                sx={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  display: "flex",
                  gap: 0.5,
                  backgroundColor: "rgba(0,0,0,0.6)",
                  borderRadius: 1,
                  p: 0.5,
                }}
              >
                <Tooltip title="Edit Series">
                  <IconButton
                    size="small"
                    onClick={(e) => handleEditSeriesClick(s, e)}
                    sx={{
                      color: "white",
                      "&:hover": { backgroundColor: "primary.main" },
                    }}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete Series">
                  <IconButton
                    size="small"
                    onClick={(e) => handleDeleteSeries(s.id, e)}
                    sx={{
                      color: "white",
                      "&:hover": { backgroundColor: "error.main" },
                    }}
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
        initialData={editingSeries}
        settings={settings}
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
