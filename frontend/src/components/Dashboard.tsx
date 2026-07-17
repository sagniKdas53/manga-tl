import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
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
      setSeriesList((prev) =>
        prev.map((s) => (s.id === data.id ? data : s)),
      );
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
    <div className="dashboard-content">
      <div className="page-header">
        <div>
          <h1>My Manga Library</h1>
          <p style={{ color: "var(--text-muted)", margin: "8px 0 0" }}>
            Manage translation projects and OCR workflows
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleNewSeriesClick}
        >
          + New Series
        </button>
      </div>

      <div className="grid-cols-3">
        {seriesList.map((s) => (
          <div
            key={s.id}
            className="manga-card glass"
            onClick={() => {
              onSelectSeries(s);
              navigate(`/series/${s.id}/${toSlug(s.title)}`);
            }}
          >
            <div className="manga-cover-container">
              {s.coverImageUrl ? (
                <img
                  src={s.coverImageUrl}
                  className="manga-cover-img"
                  alt={s.title}
                />
              ) : (
                <div className="manga-cover-placeholder">{s.title}</div>
              )}
              <div
                className="manga-card-actions"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="action-btn-small"
                  onClick={(e) => handleEditSeriesClick(s, e)}
                  title="Edit Series"
                >
                  <svg
                    width="14"
                    height="14"
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
                  onClick={(e) => handleDeleteSeries(s.id, e)}
                  title="Delete Series"
                >
                  <svg
                    width="14"
                    height="14"
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
            <div className="manga-card-content">
              <h3>{s.title}</h3>
              <div className="manga-meta">
                <span className="meta-badge">
                  {s.sourceLanguage || s.originalLanguage || "ja"} →{" "}
                  {s.targetLanguage || "en"}
                  {(s.sourceLanguage || s.originalLanguage || "ja") ===
                  (s.targetLanguage || "en")
                    ? " (Reader Mode)"
                    : ""}
                </span>
                <span className="meta-badge">{s.readingDirection}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

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
    </div>
  );
};

export default React.memo(Dashboard);
