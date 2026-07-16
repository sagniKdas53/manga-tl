import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import React, { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Divider from "@mui/material/Divider";
import FormHelperText from "@mui/material/FormHelperText";

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
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast, showError } = useToast();

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
          showError("Failed to load settings");
          setLoading(false);
        });
    }
  }, [isOpen, token, showError]);

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
      showError("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (field: keyof SystemSettingsDto, value: string) => {
    setSettings((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  return (
    <Dialog
      fullScreen={fullScreen}
      open={isOpen}
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="md"
    >
      <DialogTitle>System Settings</DialogTitle>

      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
            <CircularProgress />
          </Box>
        ) : !settings ? (
          <Typography
            color="error"
            align="center"
            sx={{ p: 2 }}
          >
            Failed to load settings.
          </Typography>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 3, pt: 1 }}>
            <Box>
              <Typography
                variant="subtitle1"
                fontWeight="bold"
                gutterBottom
              >
                OCR Configuration
              </Typography>
              <Box
                sx={{
                  display: "flex",
                  gap: 2,
                  flexDirection: { xs: "column", sm: "row" },
                }}
              >
                <FormControl
                  fullWidth
                  size="small"
                >
                  <InputLabel id="ocr-provider-label">Provider</InputLabel>
                  <Select
                    labelId="ocr-provider-label"
                    label="Provider"
                    value={settings.ocrProvider || ""}
                    onChange={(e) =>
                      handleChange("ocrProvider", e.target.value)
                    }
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

                <FormControl
                  fullWidth
                  size="small"
                  disabled={settings.ocrProvider === "local"}
                >
                  <InputLabel id="ocr-model-label">VLM Model</InputLabel>
                  <Select
                    labelId="ocr-model-label"
                    label="VLM Model"
                    value={
                      settings.ocrProvider === "local"
                        ? settings.localOcrModel || "local"
                        : settings.ocrModel || ""
                    }
                    onChange={(e) => handleChange("ocrModel", e.target.value)}
                  >
                    {settings.ocrProvider === "local" ? (
                      <MenuItem value={settings.localOcrModel || "local"}>
                        {settings.localOcrModel || "Local Worker Model"}
                      </MenuItem>
                    ) : (
                      [
                        <MenuItem
                          key="default"
                          value=""
                        >
                          -- Default / Inherit Env --
                        </MenuItem>,
                        ...settings.ocrVlmModelList.map((m) => (
                          <MenuItem
                            key={m}
                            value={m}
                          >
                            {m}
                          </MenuItem>
                        )),
                      ]
                    )}
                  </Select>
                  <FormHelperText>
                    {settings.ocrProvider === "local"
                      ? "Using local OCR worker"
                      : "Select vision-language model"}
                  </FormHelperText>
                </FormControl>
              </Box>
            </Box>

            <Divider />

            <Box>
              <Typography
                variant="subtitle1"
                fontWeight="bold"
                gutterBottom
              >
                Translation Configuration
              </Typography>
              <Box
                sx={{
                  display: "flex",
                  gap: 2,
                  flexDirection: { xs: "column", sm: "row" },
                }}
              >
                <FormControl
                  fullWidth
                  size="small"
                >
                  <InputLabel id="tl-provider-label">Provider</InputLabel>
                  <Select
                    labelId="tl-provider-label"
                    label="Provider"
                    value={settings.tlProvider || ""}
                    onChange={(e) => handleChange("tlProvider", e.target.value)}
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

                <FormControl
                  fullWidth
                  size="small"
                >
                  <InputLabel id="tl-model-label">LLM Model</InputLabel>
                  <Select
                    labelId="tl-model-label"
                    label="LLM Model"
                    value={settings.tlModel || ""}
                    onChange={(e) => handleChange("tlModel", e.target.value)}
                  >
                    <MenuItem value="">-- Default / Inherit Env --</MenuItem>
                    {settings.tlLlmModelList.map((m) => (
                      <MenuItem
                        key={m}
                        value={m}
                      >
                        {m}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>
            </Box>

            <Divider />

            <Box>
              <Typography
                variant="subtitle1"
                fontWeight="bold"
                gutterBottom
              >
                QA Configuration
              </Typography>
              <Box
                sx={{
                  display: "flex",
                  gap: 2,
                  flexDirection: { xs: "column", sm: "row" },
                }}
              >
                <FormControl
                  fullWidth
                  size="small"
                >
                  <InputLabel id="qa-provider-label">Provider</InputLabel>
                  <Select
                    labelId="qa-provider-label"
                    label="Provider"
                    value={settings.qaProvider || ""}
                    onChange={(e) => handleChange("qaProvider", e.target.value)}
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

                <FormControl
                  fullWidth
                  size="small"
                >
                  <InputLabel id="qa-mode-label">Mode</InputLabel>
                  <Select
                    labelId="qa-mode-label"
                    label="Mode"
                    value={settings.qaMode || ""}
                    onChange={(e) => handleChange("qaMode", e.target.value)}
                  >
                    <MenuItem value="auto">auto</MenuItem>
                    <MenuItem value="llm">llm</MenuItem>
                    <MenuItem value="vlm">vlm</MenuItem>
                    <MenuItem value="hybrid">hybrid</MenuItem>
                    <MenuItem value="none">none</MenuItem>
                  </Select>
                </FormControl>
              </Box>

              <Box
                sx={{
                  display: "flex",
                  gap: 2,
                  flexDirection: { xs: "column", sm: "row" },
                  mt: 2,
                }}
              >
                <FormControl
                  fullWidth
                  size="small"
                  disabled={
                    settings.qaMode === "vlm" || settings.qaMode === "none"
                  }
                >
                  <InputLabel id="qa-llm-model-label">LLM Model</InputLabel>
                  <Select
                    labelId="qa-llm-model-label"
                    label="LLM Model"
                    value={settings.qaLlmModel || ""}
                    onChange={(e) => handleChange("qaLlmModel", e.target.value)}
                  >
                    <MenuItem value="">-- Default / Inherit Env --</MenuItem>
                    {settings.qaLlmModelList.map((m) => (
                      <MenuItem
                        key={m}
                        value={m}
                      >
                        {m}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                <FormControl
                  fullWidth
                  size="small"
                  disabled={
                    settings.qaMode === "llm" || settings.qaMode === "none"
                  }
                >
                  <InputLabel id="qa-vlm-model-label">VLM Model</InputLabel>
                  <Select
                    labelId="qa-vlm-model-label"
                    label="VLM Model"
                    value={settings.qaVlmModel || ""}
                    onChange={(e) => handleChange("qaVlmModel", e.target.value)}
                  >
                    <MenuItem value="">-- Default / Inherit Env --</MenuItem>
                    {settings.qaVlmModelList.map((m) => (
                      <MenuItem
                        key={m}
                        value={m}
                      >
                        {m}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>
            </Box>
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button
          onClick={onClose}
          disabled={saving}
          color="inherit"
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving || loading}
          variant="contained"
        >
          {saving ? "Saving..." : "Save Settings"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default React.memo(SettingsModal);
