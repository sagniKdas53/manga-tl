import React, { useEffect, useState } from "react";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import Grid from "@mui/material/Grid";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";
import { safeFetch } from "../utils";
import type { SystemSettingsDto } from "../types";
import { useToast } from "./ToastContext";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  token?: string;
}

const PROVIDERS = [
  "openrouter", "gemini", "nvidia", "openai", "anthropic", "ollama", "lmstudio",
];
const OCR_PROVIDERS = [
  "local", "openrouter", "gemini", "nvidia", "ollama", "lmstudio",
];
const QA_MODES = ["auto", "llm", "vlm", "hybrid", "none"];

const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  token,
}) => {
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const providers =
    settings?.activeProviders ||
    PROVIDERS.filter(
      (p) => !["ollama", "lmstudio"].includes(p) || !settings?.disableLocalLlm,
    );
  const ocrProviders =
    settings?.activeOcrProviders ||
    OCR_PROVIDERS.filter((p) => p !== "local" || !settings?.disableLocalOcr);

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
    <Dialog
      open={isOpen}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby="settings-dialog-title"
    >
      <DialogTitle id="settings-dialog-title">System Settings</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Typography align="center" sx={{ py: 4 }}>
            <CircularProgress size={28} sx={{ mb: 1 }} />
            <br />
            Loading settings...
          </Typography>
        ) : !settings ? (
          <Typography align="center" color="error" sx={{ py: 4 }}>
            Failed to load settings.
          </Typography>
        ) : (
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl fullWidth size="small">
                <InputLabel>Global OCR Provider</InputLabel>
                <Select
                  value={settings.ocrProvider || ""}
                  label="Global OCR Provider"
                  onChange={(e) => handleChange("ocrProvider", e.target.value)}
                >
                  {ocrProviders.map((p) => (
                    <MenuItem key={p} value={p}>
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
                disabled={settings.ocrProvider === "local"}
              >
                <InputLabel>Global OCR VLM Model</InputLabel>
                <Select
                  value={
                    settings.ocrProvider === "local"
                      ? settings.localOcrModel || "local"
                      : settings.ocrModel || ""
                  }
                  label="Global OCR VLM Model"
                  onChange={(e) => handleChange("ocrModel", e.target.value)}
                >
                  {settings.ocrProvider === "local" ? (
                    <MenuItem value={settings.localOcrModel || "local"}>
                      {settings.localOcrModel || "Local Worker Model"}
                    </MenuItem>
                  ) : (
                    [
                      <MenuItem key="_empty" value="">
                        -- Default / Inherit Env --
                      </MenuItem>,
                      ...settings.ocrVlmModelList.map((m) => (
                        <MenuItem key={m} value={m}>
                          {m}
                        </MenuItem>
                      )),
                    ]
                  )}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={12}>
              <Typography
                variant="overline"
                color="text.disabled"
                sx={{ display: "block", borderTop: 1, borderColor: "divider", pt: 1 }}
              >
                Translation
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl fullWidth size="small">
                <InputLabel>Global Translation Provider</InputLabel>
                <Select
                  value={settings.tlProvider || ""}
                  label="Global Translation Provider"
                  onChange={(e) => handleChange("tlProvider", e.target.value)}
                >
                  {providers.map((p) => (
                    <MenuItem key={p} value={p}>
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl fullWidth size="small">
                <InputLabel>Global Translation LLM Model</InputLabel>
                <Select
                  value={settings.tlModel || ""}
                  label="Global Translation LLM Model"
                  onChange={(e) => handleChange("tlModel", e.target.value)}
                >
                  <MenuItem value="">-- Default / Inherit Env --</MenuItem>
                  {settings.tlLlmModelList.map((m) => (
                    <MenuItem key={m} value={m}>
                      {m}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={12}>
              <Typography
                variant="overline"
                color="text.disabled"
                sx={{ display: "block", borderTop: 1, borderColor: "divider", pt: 1 }}
              >
                Quality Assurance
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl fullWidth size="small">
                <InputLabel>Global QA Provider</InputLabel>
                <Select
                  value={settings.qaProvider || ""}
                  label="Global QA Provider"
                  onChange={(e) => handleChange("qaProvider", e.target.value)}
                >
                  {providers.map((p) => (
                    <MenuItem key={p} value={p}>
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl fullWidth size="small">
                <InputLabel>Global QA Mode</InputLabel>
                <Select
                  value={settings.qaMode || ""}
                  label="Global QA Mode"
                  onChange={(e) => handleChange("qaMode", e.target.value)}
                >
                  {QA_MODES.map((m) => (
                    <MenuItem key={m} value={m}>
                      {m}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
                disabled={
                  settings.qaMode === "vlm" || settings.qaMode === "none"
                }
              >
                <InputLabel>Global QA LLM Model</InputLabel>
                <Select
                  value={settings.qaLlmModel || ""}
                  label="Global QA LLM Model"
                  onChange={(e) => handleChange("qaLlmModel", e.target.value)}
                >
                  <MenuItem value="">-- Default / Inherit Env --</MenuItem>
                  {settings.qaLlmModelList.map((m) => (
                    <MenuItem key={m} value={m}>
                      {m}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
                disabled={
                  settings.qaMode === "llm" || settings.qaMode === "none"
                }
              >
                <InputLabel>Global QA VLM Model</InputLabel>
                <Select
                  value={settings.qaVlmModel || ""}
                  label="Global QA VLM Model"
                  onChange={(e) => handleChange("qaVlmModel", e.target.value)}
                >
                  <MenuItem value="">-- Default / Inherit Env --</MenuItem>
                  {settings.qaVlmModelList.map((m) => (
                    <MenuItem key={m} value={m}>
                      {m}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
          </Grid>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={saving || loading}
        >
          {saving ? "Saving..." : "Save Settings"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SettingsModal;