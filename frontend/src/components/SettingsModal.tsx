import React, { useEffect, useState } from "react";
import { safeFetch } from "../utils";
import type { SystemSettingsDto } from "../types";
import { useToast } from "./ToastContext";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  token?: string;
}

const PROVIDERS = [
  "openrouter",
  "gemini",
  "nvidia",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
];
const OCR_PROVIDERS = [
  "local",
  "openrouter",
  "gemini",
  "nvidia",
  "ollama",
  "lmstudio",
];

const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  token,
}) => {
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (isOpen) {
      safeFetch("/api/settings", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then((res) => {
          if (!res.ok) throw new Error("Failed to fetch settings");
          return res.json();
        })
        .then((data) => {
          setSettings(data);
          setLoading(false);
        })
        .catch((err) => {
          console.error(err);
          showToast("Failed to load settings", "error");
          setLoading(false);
        });
    }
  }, [isOpen, token, showToast]);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const res = await safeFetch("/api/settings", {
        method: "PUT",
        headers,
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error("Failed to save settings");
      const updated = await res.json();
      setSettings(updated);
      showToast("Settings saved successfully", "success");
      onClose();
    } catch (err) {
      console.error(err);
      showToast("Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (field: keyof SystemSettingsDto, value: string) => {
    setSettings((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.65)",
        animation: "fadeIn 0.15s ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          padding: "24px 32px",
          minWidth: "400px",
          maxWidth: "550px",
          width: "90vw",
          maxHeight: "90vh",
          overflowY: "auto",
          animation: "scaleIn 0.18s ease-out",
        }}
      >
        <h2
          style={{ marginTop: 0, marginBottom: "24px", color: "var(--text)" }}
        >
          System Settings
        </h2>

        {loading ? (
          <div
            style={{
              textAlign: "center",
              padding: "20px",
              color: "var(--text-muted)",
            }}
          >
            Loading...
          </div>
        ) : !settings ? (
          <div
            style={{
              textAlign: "center",
              padding: "20px",
              color: "var(--error, #ff4d4f)",
            }}
          >
            Failed to load settings.
          </div>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <div
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <label
                htmlFor="ocrProvider"
                style={{
                  fontSize: "14px",
                  fontWeight: "bold",
                  color: "var(--text)",
                }}
              >
                Global OCR Provider
              </label>
              <select
                id="ocrProvider"
                className="glass-input"
                value={settings.ocrProvider || ""}
                onChange={(e) => handleChange("ocrProvider", e.target.value)}
              >
                {OCR_PROVIDERS.map((p) => (
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
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <label
                htmlFor="ocrModel"
                style={{
                  fontSize: "14px",
                  fontWeight: "bold",
                  color: "var(--text)",
                }}
              >
                Global OCR VLM Model
              </label>
              <select
                id="ocrModel"
                className="glass-input"
                value={settings.ocrModel || ""}
                onChange={(e) => handleChange("ocrModel", e.target.value)}
              >
                <option value="">-- Default / Inherit Env --</option>
                {settings.ocrVlmModelList.map((m) => (
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
              style={{
                height: "1px",
                background: "var(--border)",
                margin: "8px 0",
              }}
            ></div>

            <div
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <label
                htmlFor="tlProvider"
                style={{
                  fontSize: "14px",
                  fontWeight: "bold",
                  color: "var(--text)",
                }}
              >
                Global Translation Provider
              </label>
              <select
                id="tlProvider"
                className="glass-input"
                value={settings.tlProvider || ""}
                onChange={(e) => handleChange("tlProvider", e.target.value)}
              >
                {PROVIDERS.map((p) => (
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
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <label
                htmlFor="tlModel"
                style={{
                  fontSize: "14px",
                  fontWeight: "bold",
                  color: "var(--text)",
                }}
              >
                Global Translation LLM Model
              </label>
              <select
                id="tlModel"
                className="glass-input"
                value={settings.tlModel || ""}
                onChange={(e) => handleChange("tlModel", e.target.value)}
              >
                <option value="">-- Default / Inherit Env --</option>
                {settings.tlLlmModelList.map((m) => (
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
              style={{
                height: "1px",
                background: "var(--border)",
                margin: "8px 0",
              }}
            ></div>

            <div
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <label
                htmlFor="qaProvider"
                style={{
                  fontSize: "14px",
                  fontWeight: "bold",
                  color: "var(--text)",
                }}
              >
                Global QA Provider
              </label>
              <select
                id="qaProvider"
                className="glass-input"
                value={settings.qaProvider || ""}
                onChange={(e) => handleChange("qaProvider", e.target.value)}
              >
                {PROVIDERS.map((p) => (
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
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <label
                htmlFor="qaLlmModel"
                style={{
                  fontSize: "14px",
                  fontWeight: "bold",
                  color: "var(--text)",
                }}
              >
                Global QA LLM Model
              </label>
              <select
                id="qaLlmModel"
                className="glass-input"
                value={settings.qaLlmModel || ""}
                onChange={(e) => handleChange("qaLlmModel", e.target.value)}
              >
                <option value="">-- Default / Inherit Env --</option>
                {settings.qaLlmModelList.map((m) => (
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
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <label
                htmlFor="qaVlmModel"
                style={{
                  fontSize: "14px",
                  fontWeight: "bold",
                  color: "var(--text)",
                }}
              >
                Global QA VLM Model
              </label>
              <select
                id="qaVlmModel"
                className="glass-input"
                value={settings.qaVlmModel || ""}
                onChange={(e) => handleChange("qaVlmModel", e.target.value)}
              >
                <option value="">-- Default / Inherit Env --</option>
                {settings.qaVlmModelList.map((m) => (
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

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "12px",
            marginTop: "24px",
          }}
        >
          <button
            className="glass-button"
            onClick={onClose}
            disabled={saving}
            style={{ padding: "8px 16px" }}
          >
            Cancel
          </button>
          <button
            className="glass-button"
            onClick={handleSave}
            disabled={saving || loading}
            style={{
              padding: "8px 16px",
              background: "var(--accent)",
              color: "white",
            }}
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
