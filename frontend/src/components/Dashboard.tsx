import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import AddIcon from "@mui/icons-material/Add";
import UploadIcon from "@mui/icons-material/Upload";
import TranslateIcon from "@mui/icons-material/Translate";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import FormControl from "@mui/material/FormControl";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";
import { useToast } from "./ToastContext";
import type { User, Series } from "../types";
import { safeFetch, toSlug } from "../utils";
import {
  readingDirectionLabel,
  readingDirectionShort,
} from "../utils/readingDirection";
import CardFooter from "./CardFooter";
import ConfirmModal from "./ConfirmModal";
import CreateSeriesDialog from "./CreateSeriesDialog";
import LazyImage from "./LazyImage";
import LoadMoreSentinel from "./LoadMoreSentinel";
import DropOverlay from "./DropOverlay";
import { useArchiveDrop } from "../hooks/useArchiveDrop";
import { isChapterArchiveFile } from "../utils/zipPages";

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

  // Standalone chapters (a chapter with no series) need a schema change and are a future
  // milestone. Until then the library's "New chapter", "Import chapter" and ZIP drop are in
  // place but lead nowhere: they say so and point at the series page, where import works.
  const standaloneNotYet = () =>
    showToast(
      "Chapters without a series are coming later. For now, open a series and import there.",
      "info",
    );
  const draggingArchive = useArchiveDrop(!showSeriesModal, (file) => {
    if (!isChapterArchiveFile(file)) {
      showToast("Drop a .zip, .cbz or .epub to import a chapter.", "info");
      return;
    }
    standaloneNotYet();
  });

  const openSeries = (s: Series) => {
    onSelectSeries(s);
    navigate(`/series/${s.id}/${toSlug(s.title)}`);
  };

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
    <Box
      sx={{
        flex: 1,
        px: { xs: 2, sm: 3 },
        py: 3,
        maxWidth: 1240,
        mx: "auto",
        width: "100%",
      }}
    >
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 1.5,
          mb: 3,
        }}
      >
        <Typography
          variant="h4"
          component="h1"
          sx={{ flex: 1, minWidth: 160 }}
        >
          Library
        </Typography>
        <FormControl size="small">
          <Select
            value={`${sortBy}-${sortDir}`}
            aria-label="Sort series"
            onChange={(e) => {
              const [field, dir] = (e.target.value as string).split("-");
              setSortBy(field as "createdAt" | "updatedAt");
              setSortDir(dir as "asc" | "desc");
              localStorage.setItem("dashboard_sort_by", field);
              localStorage.setItem("dashboard_sort_dir", dir);
            }}
          >
            <MenuItem value="updatedAt-desc">Recently updated</MenuItem>
            <MenuItem value="updatedAt-asc">Least recently updated</MenuItem>
            <MenuItem value="createdAt-desc">Newest first</MenuItem>
            <MenuItem value="createdAt-asc">Oldest first</MenuItem>
          </Select>
        </FormControl>
        <Button
          variant="outlined"
          startIcon={<UploadIcon />}
          onClick={standaloneNotYet}
        >
          Import chapter
        </Button>
        <Button
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={standaloneNotYet}
        >
          New chapter
        </Button>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleNewSeriesClick}
        >
          New series
        </Button>
      </Box>

      {loadError && sortedSeriesList.length === 0 && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
        >
          Couldn&apos;t load your series. {loadError}
        </Alert>
      )}

      {!loadError && sortedSeriesList.length === 0 && !hasMore && (
        <Box
          sx={{
            py: 8,
            textAlign: "center",
            border: "1.5px dashed",
            borderColor: "divider",
            borderRadius: "10px",
          }}
        >
          <Typography sx={{ fontWeight: 700, fontSize: "1.125rem" }}>
            Your library is empty
          </Typography>
          <Typography
            variant="body2"
            sx={{ color: "text.secondary", mt: 0.5 }}
          >
            Create a series, or drop a chapter ZIP anywhere on this page.
          </Typography>
        </Box>
      )}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "repeat(auto-fill, minmax(140px, 1fr))",
            sm: "repeat(auto-fill, minmax(168px, 1fr))",
          },
          gap: 2,
        }}
      >
        {sortedSeriesList.map((s) => (
          <Card
            key={s.id}
            role="link"
            tabIndex={0}
            aria-label={s.title}
            onClick={() => openSeries(s)}
            onKeyDown={(e) => {
              if (e.key === "Enter") openSeries(s);
            }}
            sx={{
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              borderRadius: "8px",
              outline: "2px solid transparent",
              outlineOffset: 2,
              transition: "outline-color 0.12s ease",
              "&:hover, &:focus-visible": { outlineColor: "primary.main" },
            }}
          >
            {s.coverImageUrl ? (
              <LazyImage
                src={s.coverImageUrl}
                alt={s.title}
                sx={{
                  display: "block",
                  width: "100%",
                  aspectRatio: "2 / 3",
                  objectFit: "cover",
                }}
              />
            ) : (
              <Box
                sx={{
                  aspectRatio: "2 / 3",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "text.secondary",
                  bgcolor: "background.default",
                  fontWeight: 700,
                  p: 2,
                  textAlign: "center",
                }}
              >
                No pages yet
              </Box>
            )}
            <Typography
              title={s.title}
              sx={{
                px: 1,
                pt: 0.75,
                fontWeight: 700,
                fontSize: "0.875rem",
                lineHeight: 1.3,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {s.title}
            </Typography>
            <CardFooter
              info={[
                {
                  key: "languages",
                  icon: <TranslateIcon />,
                  text: `${s.sourceLanguage || s.originalLanguage || "ja"} → ${s.targetLanguage || "en"}`,
                  label: "Translated from, into",
                },
                {
                  key: "direction",
                  icon: <SwapHorizIcon />,
                  text: readingDirectionShort(s.readingDirection),
                  label: `Reading direction: ${readingDirectionLabel(s.readingDirection).toLowerCase()}`,
                },
              ]}
              actions={[
                {
                  title: "Edit Series",
                  icon: <EditIcon />,
                  onClick: (e) => handleEditSeriesClick(s, e),
                },
                {
                  title: "Delete Series",
                  icon: <DeleteIcon />,
                  onClick: (e) => handleDeleteSeries(s.id, e),
                  danger: true,
                },
              ]}
            />
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
      <DropOverlay
        visible={draggingArchive}
        title="Chapters without a series are coming later"
        detail="To import this ZIP now, open a series and drop it there."
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
