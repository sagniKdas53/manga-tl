const fs = require('fs');
const file = 'frontend/src/components/SettingsModal.tsx';

const content = `import React, { useEffect, useState } from "react";
import { safeFetch } from "../utils";
import type { SystemSettingsDto } from "../types";
import { useToast } from "./ToastContext";

import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import FormHelperText from "@mui/material/FormHelperText";
import CircularProgress from "@mui/material/CircularProgress";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

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
        headers: token ? { Authorization: \`Bearer \${token}\` } : {},
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
        headers["Authorization"] = \`Bearer \${token}\`;
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
    <Dialog open={isOpen} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>System Settings</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box display="flex" justifyContent="center" p={4}>
            <CircularProgress />
          </Box>
        ) : !settings ? (
          <Typography color="error" align="center" p={4}>
            Failed to load settings.
          </Typography>
        ) : (
          <Box display="flex" flexDirection="column" gap={2}>
            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="h6">OCR (Text Recognition)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Box display="grid" gridTemplateColumns="1fr 1fr" gap={3}>
                  <FormControl fullWidth>
                    <InputLabel id="ocr-provider-label">Global OCR Provider</InputLabel>
                    <Select
                      labelId="ocr-provider-label"
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

                  <FormControl fullWidth disabled={settings.ocrProvider === "local"}>
                    <InputLabel id="ocr-model-label">Global OCR VLM Model</InputLabel>
                    <Select
                      labelId="ocr-model-label"
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
                          <MenuItem key="default" value="">
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
                    {(!settings.ocrModel && settings.ocrProvider !== "local") && (
                      <FormHelperText>Inheriting from environment defaults.</FormHelperText>
                    )}
                  </FormControl>
                </Box>
              </AccordionDetails>
            </Accordion>

            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="h6">Translation (LLM)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Box display="grid" gridTemplateColumns="1fr 1fr" gap={3}>
                  <FormControl fullWidth>
                    <InputLabel id="tl-provider-label">Global Translation Provider</InputLabel>
                    <Select
                      labelId="tl-provider-label"
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

                  <FormControl fullWidth>
                    <InputLabel id="tl-model-label">Global Translation LLM Model</InputLabel>
                    <Select
                      labelId="tl-model-label"
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
                    {!settings.tlModel && (
                      <FormHelperText>Inheriting from environment defaults.</FormHelperText>
                    )}
                  </FormControl>
                </Box>
              </AccordionDetails>
            </Accordion>

            <Accordion defaultExpanded>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="h6">Quality Assurance (QA)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Box display="grid" gridTemplateColumns="1fr 1fr" gap={3}>
                  <FormControl fullWidth>
                    <InputLabel id="qa-provider-label">Global QA Provider</InputLabel>
                    <Select
                      labelId="qa-provider-label"
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

                  <FormControl fullWidth>
                    <InputLabel id="qa-mode-label">Global QA Mode</InputLabel>
                    <Select
                      labelId="qa-mode-label"
                      value={settings.qaMode || ""}
                      label="Global QA Mode"
                      onChange={(e) => handleChange("qaMode", e.target.value)}
                    >
                      <MenuItem value="auto">auto</MenuItem>
                      <MenuItem value="llm">llm</MenuItem>
                      <MenuItem value="vlm">vlm</MenuItem>
                      <MenuItem value="hybrid">hybrid</MenuItem>
                      <MenuItem value="none">none</MenuItem>
                    </Select>
                  </FormControl>

                  <FormControl fullWidth disabled={settings.qaMode === "vlm" || settings.qaMode === "none"}>
                    <InputLabel id="qa-llm-label">Global QA LLM Model</InputLabel>
                    <Select
                      labelId="qa-llm-label"
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
                    {!settings.qaLlmModel && settings.qaMode !== "vlm" && settings.qaMode !== "none" && (
                      <FormHelperText>Inheriting from environment defaults.</FormHelperText>
                    )}
                  </FormControl>

                  <FormControl fullWidth disabled={settings.qaMode === "llm" || settings.qaMode === "none"}>
                    <InputLabel id="qa-vlm-label">Global QA VLM Model</InputLabel>
                    <Select
                      labelId="qa-vlm-label"
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
                    {!settings.qaVlmModel && settings.qaMode !== "llm" && settings.qaMode !== "none" && (
                      <FormHelperText>Inheriting from environment defaults.</FormHelperText>
                    )}
                  </FormControl>
                </Box>
              </AccordionDetails>
            </Accordion>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} color="inherit">
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving || loading} variant="contained" color="primary">
          {saving ? "Saving..." : "Save Settings"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SettingsModal;
`

fs.writeFileSync(file, content);
console.log('SettingsModal.tsx successfully rewritten.');
