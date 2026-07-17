import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActions from "@mui/material/CardActions";
import CardContent from "@mui/material/CardContent";
import CardMedia from "@mui/material/CardMedia";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useToast } from "./ToastContext";
import type { User, Series } from "../types";
import { safeFetch, toSlug } from "../utils";
import ConfirmModal from "./ConfirmModal";
import CreateSeriesDialog from "./CreateSeriesDialog";

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

  const [sortBy, setSortBy] = useState<"createdAt" | "updatedAt">(() => {
    const saved = localStorage.getItem("dashboard_sort_by");
    return saved === "createdAt" ? "createdAt" : "updatedAt";
  });

  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    const saved = localStorage.getItem("dashboard_sort_dir");
    return saved === "asc" ? "asc" : "desc";
  });

  const sortedSeriesList = [...seriesList].sort((a, b) => {
    const field = sortBy;
    const aVal = a[field];
    const bVal = b[field];
    if (!aVal || !bVal) return 0;
    const cmp = new Date(aVal).getTime() - new Date(bVal).getTime();
    return sortDir === "asc" ? cmp : -cmp;
  });

  // Series modal state
  const [showSeriesModal, setShowSeriesModal] = useState(false);
  const [editingSeries, setEditingSeries] = useState<Series | null>(null);
  const [createCounter, setCreateCounter] = useState(0);

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

  const handleEditSeriesClick = (s: Series, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSeries(s);
    setShowSeriesModal(true);
  };

  const handleNewSeriesClick = () => {
    setEditingSeries(null);
    setCreateCounter((c) => c + 1);
    setShowSeriesModal(true);
  };

  const handleCancelSeriesModal = () => {
    setShowSeriesModal(false);
    setEditingSeries(null);
  };

  const handleSeriesSuccess = (data: Series) => {
    if (editingSeries) {
      setSeriesList((prev) => prev.map((s) => (s.id === data.id ? data : s)));
    } else {
      setSeriesList((prev) => [...prev, data]);
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
    <Box sx={{ flex: 1, p: 3, maxWidth: 1200, mx: "auto", width: "100%" }}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 3,
        }}
      >
        <Box>
          <Typography
            variant="h4"
            sx={{ fontFamily: '"Outfit", sans-serif', fontWeight: 600 }}
          >
            My Manga Library
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5 }}
          >
            Manage translation projects and OCR workflows
          </Typography>
        </Box>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
        >
          <FormControl
            size="small"
            sx={{ minWidth: 160 }}
          >
            <Select
              value={`${sortBy}-${sortDir}`}
              onChange={(e) => {
                const [field, dir] = (e.target.value as string).split("-");
                setSortBy(field as "createdAt" | "updatedAt");
                setSortDir(dir as "asc" | "desc");
                localStorage.setItem("dashboard_sort_by", field);
                localStorage.setItem("dashboard_sort_dir", dir);
              }}
            >
              <MenuItem value="updatedAt-desc">Last Updated ↓</MenuItem>
              <MenuItem value="updatedAt-asc">Last Updated ↑</MenuItem>
              <MenuItem value="createdAt-desc">Created Date ↓</MenuItem>
              <MenuItem value="createdAt-asc">Created Date ↑</MenuItem>
            </Select>
          </FormControl>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={handleNewSeriesClick}
          >
            New Series
          </Button>
        </Stack>
      </Box>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: 2,
        }}
      >
        {sortedSeriesList.map((s) => (
          <Card
            key={s.id}
            sx={{
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              transition: "transform 0.2s, box-shadow 0.2s",
              "&:hover": {
                transform: "translateY(-4px)",
                boxShadow: 4,
              },
            }}
            onClick={() => {
              onSelectSeries(s);
              navigate(`/series/${s.id}/${toSlug(s.title)}`);
            }}
          >
            {s.coverImageUrl ? (
              <CardMedia
                component="img"
                image={s.coverImageUrl}
                alt={s.title}
                sx={{ aspectRatio: "2/3", objectFit: "cover", bgcolor: "#000" }}
              />
            ) : (
              <Box
                sx={{
                  aspectRatio: "2/3",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  bgcolor: "grey.900",
                  color: "text.secondary",
                  fontFamily: '"Outfit", sans-serif',
                  fontWeight: 700,
                  p: 2,
                  textAlign: "center",
                  fontSize: 14,
                }}
              >
                {s.title}
              </Box>
            )}
            <CardContent sx={{ flex: 1, py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Typography
                variant="subtitle2"
                noWrap
                fontWeight={600}
              >
                {s.title}
              </Typography>
              <Box
                sx={{ display: "flex", gap: 0.5, mt: 0.5, flexWrap: "wrap" }}
              >
                <Chip
                  label={`${s.sourceLanguage || s.originalLanguage || "ja"} → ${s.targetLanguage || "en"}`}
                  size="small"
                  variant="outlined"
                />
                <Chip
                  label={s.readingDirection}
                  size="small"
                  variant="outlined"
                />
              </Box>
            </CardContent>
            <CardActions sx={{ justifyContent: "flex-end", pt: 0 }}>
              <IconButton
                size="small"
                title="Edit Series"
                onClick={(e) => handleEditSeriesClick(s, e)}
              >
                <EditIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                title="Delete Series"
                color="error"
                onClick={(e) => handleDeleteSeries(s.id, e)}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </CardActions>
          </Card>
        ))}
      </Box>

      <CreateSeriesDialog
        key={editingSeries?.id ?? `create-${createCounter}`}
        open={showSeriesModal}
        editingSeries={editingSeries}
        user={user}
        onClose={handleCancelSeriesModal}
        onSuccess={handleSeriesSuccess}
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

export default React.memo(Dashboard);
