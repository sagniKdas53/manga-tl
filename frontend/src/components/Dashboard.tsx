import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { User, Series } from "../types";
import { safeFetch, toSlug } from "../utils";
import type { SystemSettingsDto } from "../types";
import ConfirmModal from "./ConfirmModal";

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

  // Series modal form states (fully encapsulated)
  const [showSeriesModal, setShowSeriesModal] = useState(false);
  const [editingSeries, setEditingSeries] = useState<Series | null>(null);
  const [newSeriesTitle, setNewSeriesTitle] = useState("");
  const [newSeriesCoverUrl, setNewSeriesCoverUrl] = useState("");
  const [newSeriesLang, setNewSeriesLang] = useState("ja");
  const [newSeriesTargetLang, setNewSeriesTargetLang] = useState("en");
  const [newSeriesDirection, setNewSeriesDirection] = useState("rtl");

  // Model overrides
  const [newOcrProvider, setNewOcrProvider] = useState("");
  const [newOcrModel, setNewOcrModel] = useState("");
  const [newTlProvider, setNewTlProvider] = useState("");
  const [newTlModel, setNewTlModel] = useState("");
  const [newQaProvider, setNewQaProvider] = useState("");
  const [newQaLlmModel, setNewQaLlmModel] = useState("");
  const [newQaVlmModel, setNewQaVlmModel] = useState("");
  const [newQaMode, setNewQaMode] = useState("");

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [showModelOverrides, setShowModelOverrides] = useState(false);

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
    setNewSeriesTitle(s.title);
    setNewSeriesCoverUrl(s.coverImageUrl || "");
    setNewSeriesLang(s.sourceLanguage || s.originalLanguage || "ja");
    setNewSeriesTargetLang(s.targetLanguage || "en");
    setNewSeriesDirection(s.readingDirection);
    setNewOcrProvider(s.ocrProvider || "");
    setNewOcrModel(s.ocrModel || "");
    setNewTlProvider(s.tlProvider || "");
    setNewTlModel(s.tlModel || "");
    setNewQaProvider(s.qaProvider || "");
    setNewQaLlmModel(s.qaLlmModel || "");
    setNewQaVlmModel(s.qaVlmModel || "");
    setNewQaMode(s.qaMode || "");
    setShowModelOverrides(false);
    setShowSeriesModal(true);
  };

  const handleNewSeriesClick = () => {
    setEditingSeries(null);
    setNewSeriesTitle("");
    setNewSeriesCoverUrl("");
    setNewSeriesLang("ja");
    setNewSeriesTargetLang("en");
    setNewSeriesDirection("rtl");
    setNewOcrProvider("");
    setNewOcrModel("");
    setNewTlProvider("");
    setNewTlModel("");
    setNewQaProvider("");
    setNewQaLlmModel("");
    setNewQaVlmModel("");
    setNewQaMode("");
    setShowModelOverrides(false);
    setShowSeriesModal(true);
  };

  const handleCancelSeriesModal = () => {
    setShowSeriesModal(false);
    setEditingSeries(null);
    setNewSeriesTitle("");
    setNewSeriesCoverUrl("");
    setNewSeriesLang("ja");
    setNewSeriesTargetLang("en");
  };

  const handleCreateSeries = async (e: React.FormEvent) => {
    e.preventDefault();
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
        body: JSON.stringify({
          title: newSeriesTitle,
          originalLanguage: newSeriesLang,
          sourceLanguage: newSeriesLang,
          targetLanguage: newSeriesTargetLang,
          readingDirection: newSeriesDirection,
          coverImageUrl: newSeriesCoverUrl || null,
          ocrProvider: newOcrProvider || null,
          ocrModel: newOcrModel || null,
          tlProvider: newTlProvider || null,
          tlModel: newTlModel || null,
          qaProvider: newQaProvider || null,
          qaLlmModel: newQaLlmModel || null,
          qaVlmModel: newQaVlmModel || null,
          qaMode: newQaMode || null,
        }),
      });
      if (res.ok) {
        const data: Series = await res.json();
        if (isEdit) {
          setSeriesList((prev) =>
            prev.map((s) => (s.id === data.id ? data : s)),
          );
        } else {
          setSeriesList((prev) => [...prev, data]);
        }
        setShowSeriesModal(false);
        setEditingSeries(null);
        setNewSeriesTitle("");
        setNewSeriesCoverUrl("");
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
          } else {
            alert("Failed to delete series");
          }
        } catch (err) {
          console.error("Error deleting series:", err);
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
              {editingSeries ? "Edit Series" : "Create New Series"}
            </h2>
            <form onSubmit={handleCreateSeries}>
              <div className="form-group">
                <label className="form-label">Series Title</label>
                <input
                  type="text"
                  className="form-input"
                  value={newSeriesTitle}
                  onChange={(e) => setNewSeriesTitle(e.target.value)}
                  placeholder="e.g. My Hero Academia"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Cover Image URL (Optional)</label>
                <input
                  type="text"
                  className="form-input"
                  value={newSeriesCoverUrl}
                  onChange={(e) => setNewSeriesCoverUrl(e.target.value)}
                  placeholder="Leave empty for default cover"
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
                  onClick={() => setShowModelOverrides(!showModelOverrides)}
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
                    {showModelOverrides ? "▲" : "▼"}
                  </span>
                </div>

                {showModelOverrides && (
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
                        value={newOcrProvider}
                        onChange={(e) => setNewOcrProvider(e.target.value)}
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
                          ...(newOcrProvider === "local" || (newOcrProvider === "" && settings?.ocrProvider === "local")
                            ? { opacity: 0.6, cursor: "not-allowed" }
                            : {})
                        }}
                        value={newOcrModel}
                        onChange={(e) => setNewOcrModel(e.target.value)}
                        disabled={newOcrProvider === "local" || (newOcrProvider === "" && settings?.ocrProvider === "local")}
                      >
                        <option value="">-- Inherit --</option>
                        {settings?.ocrVlmModelList.map((m) => (
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
                        TL Provider
                      </label>
                      <select
                        className="form-input"
                        style={{ fontSize: "13px", padding: "6px" }}
                        value={newTlProvider}
                        onChange={(e) => setNewTlProvider(e.target.value)}
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
                        value={newTlModel}
                        onChange={(e) => setNewTlModel(e.target.value)}
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
                        value={newQaProvider}
                        onChange={(e) => setNewQaProvider(e.target.value)}
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
                        value={newQaMode}
                        onChange={(e) => setNewQaMode(e.target.value)}
                      >
                        <option value="">-- Inherit --</option>
                        <option value="auto">auto</option>
                        <option value="llm">llm</option>
                        <option value="vlm">vlm</option>
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
                          ...(((newQaMode || settings?.qaMode) === "vlm" || (newQaMode || settings?.qaMode) === "none")
                            ? { opacity: 0.6, cursor: "not-allowed" }
                            : {}),
                        }}
                        value={newQaLlmModel}
                        onChange={(e) => setNewQaLlmModel(e.target.value)}
                        disabled={(newQaMode || settings?.qaMode) === "vlm" || (newQaMode || settings?.qaMode) === "none"}
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
                          ...(((newQaMode || settings?.qaMode) === "llm" || (newQaMode || settings?.qaMode) === "none")
                            ? { opacity: 0.6, cursor: "not-allowed" }
                            : {}),
                        }}
                        value={newQaVlmModel}
                        onChange={(e) => setNewQaVlmModel(e.target.value)}
                        disabled={(newQaMode || settings?.qaMode) === "llm" || (newQaMode || settings?.qaMode) === "none"}
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
                  onClick={handleCancelSeriesModal}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                >
                  {editingSeries ? "Save" : "Create"}
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

export default Dashboard;
