import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import AddIcon from "@mui/icons-material/Add";
import ImportExportIcon from "@mui/icons-material/ImportExport";
import UploadIcon from "@mui/icons-material/Upload";
import { useToast } from "./ToastContext";
import type { User, Series, Chapter, SystemSettingsDto } from "../types";
import { safeFetch, toSlug } from "../utils";
import ConfirmModal from "./ConfirmModal";
import CreateChapterDialog from "./CreateChapterDialog";

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

  // Local states for series edit modal
  const [showSeriesModal, setShowSeriesModal] = useState(false);
  const [newSeriesTitle, setNewSeriesTitle] = useState("");
  const [newSeriesLang, setNewSeriesLang] = useState("ja");
  const [newSeriesTargetLang, setNewSeriesTargetLang] = useState("en");
  const [newSeriesDirection, setNewSeriesDirection] = useState("rtl");

  // Local states for chapter create/edit modal
  const [showChapterModal, setShowChapterModal] = useState(false);
  const [editingChapter, setEditingChapter] = useState<Chapter | null>(null);
  const [chapterCreateCounter, setChapterCreateCounter] = useState(0);
  const { showToast } = useToast();

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const providers = settings?.activeProviders || [
    "openrouter",
    "gemini",
    "nvidia",
    "openai",
    "anthropic",
    "ollama",
    "lmstudio",
  ];
  const ocrProviders = settings?.activeOcrProviders || [
    "local",
    "openrouter",
    "gemini",
    "nvidia",
    "ollama",
    "lmstudio",
  ];

  const [showSeriesModelOverrides, setShowSeriesModelOverrides] =
    useState(false);

  // Model overrides for Series
  const [newSeriesOcrProvider, setNewSeriesOcrProvider] = useState("");
  const [newSeriesOcrModel, setNewSeriesOcrModel] = useState("");
  const [newSeriesTlProvider, setNewSeriesTlProvider] = useState("");
  const [newSeriesTlModel, setNewSeriesTlModel] = useState("");
  const [newSeriesQaProvider, setNewSeriesQaProvider] = useState("");
  const [newSeriesQaLlmModel, setNewSeriesQaLlmModel] = useState("");
  const [newSeriesQaVlmModel, setNewSeriesQaVlmModel] = useState("");
  const [newSeriesQaMode, setNewSeriesQaMode] = useState("");

  // Model overrides for Import
  const [importOcrProvider, setImportOcrProvider] = useState("");
  const [importOcrModel, setImportOcrModel] = useState("");
  const [importTlProvider, setImportTlProvider] = useState("");
  const [importTlModel, setImportTlModel] = useState("");
  const [importQaProvider, setImportQaProvider] = useState("");
  const [importQaLlmModel, setImportQaLlmModel] = useState("");
  const [importQaVlmModel, setImportQaVlmModel] = useState("");
  const [importQaMode, setImportQaMode] = useState("");
  const [showImportModelOverrides, setShowImportModelOverrides] =
    useState(false);

  // Local states for chapter import modal
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importChapterNum, setImportChapterNum] = useState<number>(1);
  const [importChapterTitle, setImportChapterTitle] = useState("");
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
      <div className="dashboard-content text-center">
        <div className="spinner"></div>
        <p>Loading series details...</p>
      </div>
    );
  }

  // --- SERIES ACTIONS ---
  const handleEditSeriesClick = () => {
    setNewSeriesTitle(selectedSeries.title);
    setNewSeriesLang(
      selectedSeries.sourceLanguage || selectedSeries.originalLanguage || "ja",
    );
    setNewSeriesTargetLang(selectedSeries.targetLanguage || "en");
    setNewSeriesDirection(selectedSeries.readingDirection);
    setNewSeriesOcrProvider(selectedSeries.ocrProvider || "");
    setNewSeriesOcrModel(selectedSeries.ocrModel || "");
    setNewSeriesTlProvider(selectedSeries.tlProvider || "");
    setNewSeriesTlModel(selectedSeries.tlModel || "");
    setNewSeriesQaProvider(selectedSeries.qaProvider || "");
    setNewSeriesQaLlmModel(selectedSeries.qaLlmModel || "");
    setNewSeriesQaVlmModel(selectedSeries.qaVlmModel || "");
    setNewSeriesQaMode(selectedSeries.qaMode || "");
    setShowSeriesModelOverrides(false);
    setShowSeriesModal(true);
  };

  const handleCreateSeriesSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await safeFetch(`/api/series/${selectedSeries.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
          title: newSeriesTitle,
          originalLanguage: newSeriesLang,
          sourceLanguage: newSeriesLang,
          targetLanguage: newSeriesTargetLang,
          readingDirection: newSeriesDirection,
          ocrProvider: newSeriesOcrProvider || null,
          ocrModel: newSeriesOcrModel || null,
          tlProvider: newSeriesTlProvider || null,
          tlModel: newSeriesTlModel || null,
          qaProvider: newSeriesQaProvider || null,
          qaLlmModel: newSeriesQaLlmModel || null,
          qaVlmModel: newSeriesQaVlmModel || null,
          qaMode: newSeriesQaMode || null,
        }),
      });
      if (res.ok) {
        const data: Series = await res.json();
        setSelectedSeries(data);
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

  const handleImportChapterClick = () => {
    const maxNum = chapters.reduce(
      (max, c) => (c.chapterNumber > max ? c.chapterNumber : max),
      0,
    );
    setImportChapterNum(maxNum + 1);
    setImportChapterTitle("");
    setImportFile(null);
    setImportError("");
    setImportOcrProvider("");
    setImportOcrModel("");
    setImportTlProvider("");
    setImportTlModel("");
    setImportQaProvider("");
    setImportQaLlmModel("");
    setImportQaVlmModel("");
    setImportQaMode("");
    setShowImportModelOverrides(false);
    setIsImporting(false);
    setShowImportModal(true);
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importFile || !selectedSeries) return;
    setImportError("");
    setIsImporting(true);

    const formData = new FormData();
    formData.append("file", importFile);
    formData.append("chapterNumber", importChapterNum.toString());
    formData.append("title", importChapterTitle);
    if (importOcrProvider) formData.append("ocrProvider", importOcrProvider);
    if (importOcrModel) formData.append("ocrModel", importOcrModel);
    if (importTlProvider) formData.append("tlProvider", importTlProvider);
    if (importTlModel) formData.append("tlModel", importTlModel);
    if (importQaProvider) formData.append("qaProvider", importQaProvider);
    if (importQaLlmModel) formData.append("qaLlmModel", importQaLlmModel);
    if (importQaVlmModel) formData.append("qaVlmModel", importQaVlmModel);
    if (importQaMode) formData.append("qaMode", importQaMode);

    try {
      const res = await safeFetch(
        `/api/series/${selectedSeries.id}/chapters/import`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${user.token}`,
          },
          body: formData,
        } as RequestInit,
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
            showToast("You don't have permission to delete this chapter.", "error");
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
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
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
                onClick={handleImportChapterClick}
              >
                Import Chapter (ZIP)
              </Button>
              <Button variant="outlined" onClick={handleEditSeriesClick}>
                Edit Series
              </Button>
              <Button variant="outlined" color="error" onClick={handleDeleteSeries}>
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
              </div>
            </div>
          ))}
      </div>

      {showSeriesModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.7)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            className="glass"
            style={{ padding: "32px", width: "100%", maxWidth: "440px" }}
          >
            <h2
              style={{
                fontFamily: "var(--font-display)",
                marginBottom: "24px",
              }}
            >
              Edit Series
            </h2>
            <form onSubmit={handleCreateSeriesSubmit}>
              <div className="form-group">
                <label className="form-label">Series Title</label>
                <input
                  type="text"
                  className="form-input"
                  value={newSeriesTitle}
                  onChange={(e) => setNewSeriesTitle(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Source Language</label>
                <select
                  className="form-input"
                  value={newSeriesLang}
                  onChange={(e) => setNewSeriesLang(e.target.value)}
                >
                  <option value="ja">Japanese (ja)</option>
                  <option value="zh-TW">Traditional Chinese (zh-TW)</option>
                  <option value="zh-CN">Simplified Chinese (zh-CN)</option>
                  <option value="ko">Korean (ko)</option>
                  <option value="en">English (en)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Target Language</label>
                <select
                  className="form-input"
                  value={newSeriesTargetLang}
                  onChange={(e) => setNewSeriesTargetLang(e.target.value)}
                >
                  <option value="en">English (en)</option>
                  <option value="ja">Japanese (ja)</option>
                  <option value="zh-TW">Traditional Chinese (zh-TW)</option>
                  <option value="zh-CN">Simplified Chinese (zh-CN)</option>
                  <option value="ko">Korean (ko)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Reading Direction</label>
                <select
                  className="form-input"
                  value={newSeriesDirection}
                  onChange={(e) => setNewSeriesDirection(e.target.value)}
                >
                  <option value="rtl">Right to Left (Manga)</option>
                  <option value="ltr">Left to Right (Comics)</option>
                  <option value="ttb">Top to Bottom (Webtoons)</option>
                </select>
              </div>

              <div
                style={{
                  marginTop: "16px",
                  padding: "16px",
                  background: "var(--bg-hover)",
                  borderRadius: "8px",
                }}
              >
                <div
                  onClick={() =>
                    setShowSeriesModelOverrides(!showSeriesModelOverrides)
                  }
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <h4 style={{ margin: 0, fontSize: "14px", opacity: 0.8 }}>
                    Model Overrides (Optional)
                  </h4>
                  <span style={{ fontSize: "12px", opacity: 0.6 }}>
                    {showSeriesModelOverrides ? "▲" : "▼"}
                  </span>
                </div>

                {showSeriesModelOverrides && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "12px",
                      marginTop: "12px",
                    }}
                  >
                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        OCR Provider
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={newSeriesOcrProvider}
                        onChange={(e) =>
                          setNewSeriesOcrProvider(e.target.value)
                        }
                      >
                        <option value="">-- Inherit --</option>
                        {ocrProviders.map((p) => (
                          <option
                            key={p}
                            value={p}
                          >
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        OCR VLM Model
                      </label>
                      <select
                        className="form-input"
                        style={{
                          fontSize: "13px",
                          padding: "6px",
                          ...(newSeriesOcrProvider === "local" ||
                          (newSeriesOcrProvider === "" &&
                            settings?.ocrProvider === "local")
                            ? { opacity: 0.6, cursor: "not-allowed" }
                            : {}),
                        }}
                        value={
                          newSeriesOcrProvider === "local" ||
                          (newSeriesOcrProvider === "" &&
                            settings?.ocrProvider === "local")
                            ? settings?.localOcrModel || "local"
                            : newSeriesOcrModel || ""
                        }
                        onChange={(e) => setNewSeriesOcrModel(e.target.value)}
                        disabled={
                          newSeriesOcrProvider === "local" ||
                          (newSeriesOcrProvider === "" &&
                            settings?.ocrProvider === "local")
                        }
                      >
                        {newSeriesOcrProvider === "local" ||
                        (newSeriesOcrProvider === "" &&
                          settings?.ocrProvider === "local") ? (
                          <option value={settings?.localOcrModel || "local"}>
                            {settings?.localOcrModel || "Local Worker Model"}
                          </option>
                        ) : (
                          <>
                            <option value="">-- Inherit --</option>
                            {settings?.ocrVlmModelList.map((m) => (
                              <option
                                key={m}
                                value={m}
                              >
                                {m}
                              </option>
                            ))}
                          </>
                        )}
                      </select>
                    </div>

                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        TL Provider
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={newSeriesTlProvider}
                        onChange={(e) => setNewSeriesTlProvider(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        {providers.map((p) => (
                          <option
                            key={p}
                            value={p}
                          >
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        TL LLM Model
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={newSeriesTlModel}
                        onChange={(e) => setNewSeriesTlModel(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        {settings?.tlLlmModelList.map((m) => (
                          <option
                            key={m}
                            value={m}
                          >
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        QA Provider
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={newSeriesQaProvider}
                        onChange={(e) => setNewSeriesQaProvider(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        {providers.map((p) => (
                          <option
                            key={p}
                            value={p}
                          >
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        QA Mode
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={newSeriesQaMode}
                        onChange={(e) => setNewSeriesQaMode(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        <option value="auto">auto</option>
                        <option value="llm">llm</option>
                        <option value="vlm">vlm</option>
                        <option value="hybrid">hybrid</option>
                        <option value="none">none</option>
                      </select>
                    </div>

                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        QA LLM Model
                      </label>
                      <select
                        className="form-input"
                        style={{
                          fontSize: "13px",
                          padding: "6px",
                          ...((newSeriesQaMode || settings?.qaMode) === "vlm" ||
                          (newSeriesQaMode || settings?.qaMode) === "none"
                            ? { opacity: 0.6, cursor: "not-allowed" }
                            : {}),
                        }}
                        value={newSeriesQaLlmModel}
                        onChange={(e) => setNewSeriesQaLlmModel(e.target.value)}
                        disabled={
                          (newSeriesQaMode || settings?.qaMode) === "vlm" ||
                          (newSeriesQaMode || settings?.qaMode) === "none"
                        }
                      >
                        <option value="">-- Inherit --</option>
                        {settings?.qaLlmModelList.map((m) => (
                          <option
                            key={m}
                            value={m}
                          >
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        QA VLM Model
                      </label>
                      <select
                        className="form-input"
                        style={{
                          fontSize: "13px",
                          padding: "6px",
                          ...((newSeriesQaMode || settings?.qaMode) === "llm" ||
                          (newSeriesQaMode || settings?.qaMode) === "none"
                            ? { opacity: 0.6, cursor: "not-allowed" }
                            : {}),
                        }}
                        value={newSeriesQaVlmModel}
                        onChange={(e) => setNewSeriesQaVlmModel(e.target.value)}
                        disabled={
                          (newSeriesQaMode || settings?.qaMode) === "llm" ||
                          (newSeriesQaMode || settings?.qaMode) === "none"
                        }
                      >
                        <option value="">-- Inherit --</option>
                        {settings?.qaVlmModelList.map((m) => (
                          <option
                            key={m}
                            value={m}
                          >
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: "12px", marginTop: "24px" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => setShowSeriesModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
      {showImportModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.7)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            className="glass"
            style={{ padding: "32px", width: "100%", maxWidth: "400px" }}
          >
            <h2
              style={{
                fontFamily: "var(--font-display)",
                marginBottom: "24px",
              }}
            >
              Import Chapter (ZIP)
            </h2>
            <form onSubmit={handleImportSubmit}>
              <div className="form-group">
                <label className="form-label">ZIP / ePub Archive</label>
                <input
                  type="file"
                  accept=".zip,.epub,application/epub+zip,application/zip"
                  className="form-input"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Chapter Number</label>
                <input
                  type="number"
                  step="any"
                  className="form-input"
                  value={importChapterNum}
                  onChange={(e) =>
                    setImportChapterNum(parseFloat(e.target.value) || 0)
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Chapter Title</label>
                <input
                  type="text"
                  className="form-input"
                  value={importChapterTitle}
                  onChange={(e) => setImportChapterTitle(e.target.value)}
                  placeholder="e.g. Chapter 1 - Imported Volume"
                />
              </div>

              <div
                style={{
                  marginTop: "16px",
                  padding: "16px",
                  background: "var(--bg-hover)",
                  borderRadius: "8px",
                }}
              >
                <div
                  onClick={() =>
                    setShowImportModelOverrides(!showImportModelOverrides)
                  }
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <h4 style={{ margin: 0, fontSize: "14px", opacity: 0.8 }}>
                    Model Overrides (Optional)
                  </h4>
                  <span style={{ fontSize: "12px", opacity: 0.6 }}>
                    {showImportModelOverrides ? "▲" : "▼"}
                  </span>
                </div>

                {showImportModelOverrides && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "12px",
                      marginTop: "12px",
                    }}
                  >
                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        OCR Provider
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={importOcrProvider}
                        onChange={(e) => setImportOcrProvider(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        {ocrProviders.map((p) => (
                          <option
                            key={p}
                            value={p}
                          >
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        OCR VLM Model
                      </label>
                      <select
                        className="form-input"
                        style={{
                          fontSize: "13px",
                          padding: "6px",
                          ...(importOcrProvider === "local" ||
                          (importOcrProvider === "" &&
                            (selectedSeries?.ocrProvider === "local" ||
                              (!selectedSeries?.ocrProvider &&
                                settings?.ocrProvider === "local")))
                            ? { opacity: 0.6, cursor: "not-allowed" }
                            : {}),
                        }}
                        value={
                          importOcrProvider === "local" ||
                          (importOcrProvider === "" &&
                            (selectedSeries?.ocrProvider === "local" ||
                              (!selectedSeries?.ocrProvider &&
                                settings?.ocrProvider === "local")))
                            ? settings?.localOcrModel || "local"
                            : importOcrModel || ""
                        }
                        onChange={(e) => setImportOcrModel(e.target.value)}
                        disabled={
                          importOcrProvider === "local" ||
                          (importOcrProvider === "" &&
                            (selectedSeries?.ocrProvider === "local" ||
                              (!selectedSeries?.ocrProvider &&
                                settings?.ocrProvider === "local")))
                        }
                      >
                        {importOcrProvider === "local" ||
                        (importOcrProvider === "" &&
                          (selectedSeries?.ocrProvider === "local" ||
                            (!selectedSeries?.ocrProvider &&
                              settings?.ocrProvider === "local"))) ? (
                          <option value={settings?.localOcrModel || "local"}>
                            {settings?.localOcrModel || "Local Worker Model"}
                          </option>
                        ) : (
                          <>
                            <option value="">-- Inherit --</option>
                            {settings?.ocrVlmModelList.map((m) => (
                              <option
                                key={m}
                                value={m}
                              >
                                {m}
                              </option>
                            ))}
                          </>
                        )}
                      </select>
                    </div>

                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        TL Provider
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={importTlProvider}
                        onChange={(e) => setImportTlProvider(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        {providers.map((p) => (
                          <option
                            key={p}
                            value={p}
                          >
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        TL LLM Model
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={importTlModel}
                        onChange={(e) => setImportTlModel(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        {settings?.tlLlmModelList.map((m) => (
                          <option
                            key={m}
                            value={m}
                          >
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        QA Provider
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={importQaProvider}
                        onChange={(e) => setImportQaProvider(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        {providers.map((p) => (
                          <option
                            key={p}
                            value={p}
                          >
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        QA Mode
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={importQaMode}
                        onChange={(e) => setImportQaMode(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        <option value="auto">auto</option>
                        <option value="llm">llm</option>
                        <option value="vlm">vlm</option>
                        <option value="hybrid">hybrid</option>
                        <option value="none">none</option>
                      </select>
                    </div>

                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        QA LLM Model
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={importQaLlmModel}
                        onChange={(e) => setImportQaLlmModel(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        {settings?.qaLlmModelList.map((m) => (
                          <option
                            key={m}
                            value={m}
                          >
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div
                      className="form-group"
                      style={{ marginBottom: 0 }}
                    >
                      <label
                        className="form-label"
                        style={{ fontSize: "12px" }}
                      >
                        QA VLM Model
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={importQaVlmModel}
                        onChange={(e) => setImportQaVlmModel(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        {settings?.qaVlmModelList.map((m) => (
                          <option
                            key={m}
                            value={m}
                          >
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>

              {importError && (
                <div
                  style={{
                    color: "var(--error, #ff4d4f)",
                    fontSize: "13px",
                    marginTop: "16px",
                    textAlign: "center",
                  }}
                >
                  {importError}
                </div>
              )}
              <div style={{ display: "flex", gap: "12px", marginTop: "24px" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => setShowImportModal(false)}
                  disabled={isImporting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                  }}
                  disabled={isImporting}
                >
                  {isImporting ? <div className="spinner-mini"></div> : null}
                  {isImporting ? "Importing..." : "Import"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
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
