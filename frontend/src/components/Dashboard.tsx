import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActions from "@mui/material/CardActions";
import CardContent from "@mui/material/CardContent";
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
import LazyImage from "./LazyImage";
import LoadMoreSentinel from "./LoadMoreSentinel";

interface DashboardProps {
  user: User;
  seriesList: Series[];
  setSeriesList: React.Dispatch<React.SetStateAction<Series[]>>;
  onSelectSeries: (series: Series) => void;
  mode: "light" | "dark";
  // AUDIT-F8: sort now drives a server-side query (App.tsx owns the fetch), so the
  // selection lives there too — sorting a partial infinite-scroll prefix client-side would
  // just be wrong once the list is no longer fetched whole.
  sortBy: "createdAt" | "updatedAt";
  setSortBy: React.Dispatch<React.SetStateAction<"createdAt" | "updatedAt">>;
  sortDir: "asc" | "desc";
  setSortDir: React.Dispatch<React.SetStateAction<"asc" | "desc">>;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  // AUDIT-F12: without this an empty grid means either "no series yet" or "the fetch
  // failed", and the user cannot tell which. `safeFetch`'s global `api-error` toast is
  // transient and generic; this is what the list itself renders.
  loadError?: string | null;
}

export const Dashboard: React.FC<DashboardProps> = ({
  user,
  seriesList,
  setSeriesList,
  onSelectSeries,
  sortBy,
  setSortBy,
  sortDir,
  setSortDir,
  hasMore,
  isLoadingMore,
  onLoadMore,
  loadError = null,
}) => {
  const navigate = useNavigate();
  const { showToast } = useToast();

  // Already sorted server-side (see App.tsx); this only renders the accumulated pages
  // in the order they arrived.
  const sortedSeriesList = seriesList;

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
          flexDirection: { xs: "column", sm: "row" },
          justifyContent: "space-between",
          alignItems: { xs: "flex-start", sm: "center" },
          gap: 2,
          mb: 3,
        }}
      >
        <Box>
          <Typography
            variant="h4"
            sx={{
              fontFamily: '"Outfit", sans-serif',
              fontWeight: 600,
              color: "text.primary",
            }}
          >
            My Manga Library
          </Typography>
          <Typography
            variant="body2"
            sx={{ mt: 0.5, color: "text.secondary" }}
          >
            Manage translation projects and OCR workflows
          </Typography>
        </Box>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          sx={{ width: { xs: "100%", sm: "auto" } }}
        >
          <FormControl
            size="small"
            sx={{ minWidth: { xs: "100%", sm: 160 } }}
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
            sx={{ width: { xs: "100%", sm: "auto" } }}
          >
            New Series
          </Button>
        </Stack>
      </Box>

      {loadError && sortedSeriesList.length === 0 && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
        >
          Couldn&apos;t load your series. {loadError}
        </Alert>
      )}

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
              <LazyImage
                src={s.coverImageUrl}
                alt={s.title}
                sx={{
                  display: "block",
                  width: "100%",
                  aspectRatio: "2/3",
                  objectFit: "cover",
                  bgcolor: "#000",
                }}
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
                variant="h6"
                noWrap
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
                aria-label="Edit Series"
                title="Edit Series"
                onClick={(e) => handleEditSeriesClick(s, e)}
              >
                <EditIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                aria-label="Delete Series"
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

      <LoadMoreSentinel
        hasMore={hasMore}
        isLoading={isLoadingMore}
        onLoadMore={onLoadMore}
      />

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
