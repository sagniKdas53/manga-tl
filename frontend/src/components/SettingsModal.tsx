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

  const providers = settings?.activeProviders || [];
  const ocrProviders = settings?.activeOcrProviders || [];

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

  const handleChange = (
    field: keyof SystemSettingsDto,
    value: SystemSettingsDto[keyof SystemSettingsDto],
  ) => {
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
          <Typography
            align="center"
            sx={{ py: 4 }}
          >
            <CircularProgress
              size={28}
              sx={{ mb: 1 }}
            />
            <br />
            Loading settings...
          </Typography>
        ) : !settings ? (
          <Typography
            align="center"
            color="error"
            sx={{ py: 4 }}
          >
            Failed to load settings.
          </Typography>
        ) : (
          <Grid
            container
            spacing={1.5}
          >
            <Grid
              size={12}
              sx={{ my: 0, py: 0 }}
            >
              <Typography
                variant="overline"
                color="text.disabled"
                sx={{
                  display: "block",
                  m: 0,
                  p: 0,
                }}
              >
                OCR
              </Typography>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Global OCR Provider</InputLabel>
                <Select
                  value={settings.ocrProvider || ""}
                  label="Global OCR Provider"
                  onChange={(e) => {
                    const newProv = e.target.value;
                    const ocrModels = settings.providerModelsMap?.[newProv]?.ocr || [];
                    const defaultModel = ocrModels.length > 0 ? ocrModels[0].id : (settings.ocrModel || "");
                    setSettings((prev) => prev ? { ...prev, ocrProvider: newProv, ocrModel: defaultModel } : null);
                  }}
                >
                  {ocrProviders.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
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
                      : (!settings.providerModelsMap?.[settings.ocrProvider]?.ocr || settings.providerModelsMap?.[settings.ocrProvider]?.ocr.length === 0)
                        ? "N/A"
                        : settings.ocrModel || ""
                  }
                  label="Global OCR VLM Model"
                  onChange={(e) => handleChange("ocrModel", e.target.value)}
                >
                  {settings.ocrProvider === "local" ? (
                    <MenuItem value={settings.localOcrModel || "local"}>
                      {settings.localOcrModel || "Local Worker Model"}
                    </MenuItem>
                  ) : (!settings.providerModelsMap?.[settings.ocrProvider]?.ocr || settings.providerModelsMap?.[settings.ocrProvider]?.ocr.length === 0) ? (
                    <MenuItem value="N/A" disabled>N/A (Capability Missing)</MenuItem>
                  ) : (
                    (settings.providerModelsMap?.[settings.ocrProvider]?.ocr || []).map((m) => (
                      <MenuItem key={m.id} value={m.id}>
                        {m.name}{m.free ? " (Free)" : ""}
                      </MenuItem>
                    )).concat(
                      (!settings.providerModelsMap?.[settings.ocrProvider]?.ocr && settings.ocrVlmModelList)
                        ? settings.ocrVlmModelList.map((m) => (
                            <MenuItem key={m} value={m}>{m}</MenuItem>
                          ))
                        : []
                    )
                  )}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={12}>
              <Typography
                variant="overline"
                color="text.disabled"
                sx={{
                  display: "block",
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1,
                }}
              >
                Translation
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Global Translation Provider</InputLabel>
                <Select
                  value={settings.tlProvider || ""}
                  label="Global Translation Provider"
                  onChange={(e) => {
                    const newProv = e.target.value;
                    const tlModels = settings.providerModelsMap?.[newProv]?.tl || [];
                    const defaultModel = tlModels.length > 0 ? tlModels[0].id : (settings.tlModel || "");
                    setSettings((prev) => prev ? { ...prev, tlProvider: newProv, tlModel: defaultModel } : null);
                  }}
                >
                  {providers.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
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
              >
                <InputLabel>Global Translation LLM Model</InputLabel>
                <Select
                  value={settings.tlModel || ""}
                  label="Global Translation LLM Model"
                  onChange={(e) => handleChange("tlModel", e.target.value)}
                >
                  {(settings.providerModelsMap?.[settings.tlProvider]?.tl || []).map((m) => (
                    <MenuItem key={m.id} value={m.id}>
                      {m.name}{m.free ? " (Free)" : ""}
                    </MenuItem>
                  )).concat(
                    (!settings.providerModelsMap?.[settings.tlProvider]?.tl && settings.tlLlmModelList)
                      ? settings.tlLlmModelList.map((m) => (
                          <MenuItem key={m} value={m}>{m}</MenuItem>
                        ))
                      : []
                  )}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={12}>
              <Typography
                variant="overline"
                color="text.disabled"
                sx={{
                  display: "block",
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1,
                }}
              >
                Quality Assurance
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Global QA Provider</InputLabel>
                <Select
                  value={settings.qaProvider || ""}
                  label="Global QA Provider"
                  onChange={(e) => {
                    const newProv = e.target.value;
                    const qaLlmModels = settings.providerModelsMap?.[newProv]?.qaLLM || [];
                    const qaVlmModels = settings.providerModelsMap?.[newProv]?.qaVLM || [];
                    const defaultLlm = qaLlmModels.length > 0 ? qaLlmModels[0].id : (settings.qaLlmModel || "");
                    const defaultVlm = qaVlmModels.length > 0 ? qaVlmModels[0].id : (settings.qaVlmModel || "");
                    setSettings((prev) => prev ? { ...prev, qaProvider: newProv, qaLlmModel: defaultLlm, qaVlmModel: defaultVlm } : null);
                  }}
                >
                  {providers.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
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
              >
                <InputLabel>Global QA Mode</InputLabel>
                <Select
                  value={settings.qaMode || ""}
                  label="Global QA Mode"
                  onChange={(e) => handleChange("qaMode", e.target.value)}
                >
                  {QA_MODES.map((m) => (
                    <MenuItem
                      key={m}
                      value={m}
                    >
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
                  {(settings.providerModelsMap?.[settings.qaProvider]?.qaLLM || []).map((m) => (
                    <MenuItem key={m.id} value={m.id}>
                      {m.name}{m.free ? " (Free)" : ""}
                    </MenuItem>
                  )).concat(
                    (!settings.providerModelsMap?.[settings.qaProvider]?.qaLLM && settings.qaLlmModelList)
                      ? settings.qaLlmModelList.map((m) => (
                          <MenuItem key={m} value={m}>{m}</MenuItem>
                        ))
                      : []
                  )}
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
                  value={
                    settings.qaMode === "llm" || settings.qaMode === "none" || (!settings.providerModelsMap?.[settings.qaProvider]?.qaVLM || settings.providerModelsMap?.[settings.qaProvider]?.qaVLM.length === 0)
                      ? "N/A"
                      : settings.qaVlmModel || ""
                  }
                  label="Global QA VLM Model"
                  onChange={(e) => handleChange("qaVlmModel", e.target.value)}
                >
                  {(!settings.providerModelsMap?.[settings.qaProvider]?.qaVLM || settings.providerModelsMap?.[settings.qaProvider]?.qaVLM.length === 0) ? (
                    <MenuItem value="N/A" disabled>N/A (Capability Missing)</MenuItem>
                  ) : (
                    (settings.providerModelsMap?.[settings.qaProvider]?.qaVLM || []).map((m) => (
                      <MenuItem key={m.id} value={m.id}>
                        {m.name}{m.free ? " (Free)" : ""}
                      </MenuItem>
                    )).concat(
                      (!settings.providerModelsMap?.[settings.qaProvider]?.qaVLM && settings.qaVlmModelList)
                        ? settings.qaVlmModelList.map((m) => (
                            <MenuItem key={m} value={m}>{m}</MenuItem>
                          ))
                        : []
                    )
                  )}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={12}>
              <Typography
                variant="overline"
                color="text.disabled"
                sx={{
                  display: "block",
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1,
                }}
              >
                Advanced Routing
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
                disabled={![settings.ocrProvider, settings.tlProvider, settings.qaProvider].includes("openrouter")}
              >
                <InputLabel>OpenRouter Routing Strategy</InputLabel>
                <Select
                  value={settings.routingStrategy || "lowest-cost"}
                  label="OpenRouter Routing Strategy"
                  onChange={(e) =>
                    handleChange("routingStrategy", e.target.value)
                  }
                >
                  <MenuItem value="lowest-cost">Lowest Cost</MenuItem>
                  <MenuItem value="highest-throughput">
                    Highest Throughput
                  </MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Use Fallback Models</InputLabel>
                <Select
                  value={
                    settings.useFallbackModels !== false ? "true" : "false"
                  }
                  label="Use Fallback Models"
                  onChange={(e) =>
                    handleChange("useFallbackModels", e.target.value === "true")
                  }
                >
                  <MenuItem value="true">Enabled</MenuItem>
                  <MenuItem value="false">Disabled</MenuItem>
                </Select>
              </FormControl>
            </Grid>
          </Grid>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          onClick={onClose}
          disabled={saving}
        >
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
