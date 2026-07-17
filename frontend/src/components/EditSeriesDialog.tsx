import React, { useState, useEffect } from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { User, Series } from "../types";
import { safeFetch } from "../utils";
import { useToast } from "./ToastContext";

interface EditSeriesDialogProps {
  open: boolean;
  series: Series;
  user: User;
  onClose: () => void;
  onSuccess: (data: Series) => void;
}

interface SystemSettingsDto {
  activeProviders?: string[];
  activeOcrProviders?: string[];
  localOcrModel?: string;
  ocrProvider?: string;
  ocrVlmModelList?: string[];
  tlProvider?: string;
  tlLlmModelList?: string[];
  qaProvider?: string;
  qaMode?: string;
  qaLlmModelList?: string[];
  qaVlmModelList?: string[];
  disableLocalOcr?: boolean;
}

const LANG_OPTS = ["ja", "zh-TW", "zh-CN", "ko", "en"];
const TARGET_OPTS = ["en", "ja", "zh-TW", "zh-CN", "ko"];
const DIR_OPTS = [
  { value: "rtl", label: "Right to Left (Manga)" },
  { value: "ltr", label: "Left to Right (Comics)" },
  { value: "ttb", label: "Top to Bottom (Webtoons)" },
];

export const EditSeriesDialog: React.FC<EditSeriesDialogProps> = ({
  open,
  series,
  user,
  onClose,
  onSuccess,
}) => {
  const { showToast } = useToast();
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [title, setTitle] = useState(series.title);
  const [lang, setLang] = useState(
    series.sourceLanguage || series.originalLanguage || "ja",
  );
  const [targetLang, setTargetLang] = useState(series.targetLanguage || "en");
  const [direction, setDirection] = useState(series.readingDirection);
  const [saving, setSaving] = useState(false);

  const [ocrProvider, setOcrProvider] = useState(series.ocrProvider || "");
  const [ocrModel, setOcrModel] = useState(series.ocrModel || "");
  const [tlProvider, setTlProvider] = useState(series.tlProvider || "");
  const [tlModel, setTlModel] = useState(series.tlModel || "");
  const [qaProvider, setQaProvider] = useState(series.qaProvider || "");
  const [qaLlmModel, setQaLlmModel] = useState(series.qaLlmModel || "");
  const [qaVlmModel, setQaVlmModel] = useState(series.qaVlmModel || "");
  const [qaMode, setQaMode] = useState(series.qaMode || "");
  const [overridesOpen, setOverridesOpen] = useState(false);

  const actualProviders = settings?.activeProviders || [
    "openrouter",
    "gemini",
    "nvidia",
    "openai",
    "anthropic",
    "ollama",
    "lmstudio",
  ];
  const actualOcrProviders = settings?.activeOcrProviders || [
    "local",
    "openrouter",
    "gemini",
    "nvidia",
    "ollama",
    "lmstudio",
  ];

  useEffect(() => {
    if (open) {
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setSettings(d))
        .catch(console.error);
    }
  }, [open, user.token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await safeFetch(`/api/series/${series.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
          title,
          originalLanguage: lang,
          sourceLanguage: lang,
          targetLanguage: targetLang,
          readingDirection: direction,
          ocrProvider: ocrProvider || null,
          ocrModel: ocrModel || null,
          tlProvider: tlProvider || null,
          tlModel: tlModel || null,
          qaProvider: qaProvider || null,
          qaLlmModel: qaLlmModel || null,
          qaVlmModel: qaVlmModel || null,
          qaMode: qaMode || null,
        }),
      });
      if (res.ok) {
        const data: Series = await res.json();
        onSuccess(data);
        onClose();
      } else {
        showToast("Failed to update series", "error");
      }
    } catch {
      showToast("Error updating series", "error");
    } finally {
      setSaving(false);
    }
  };

  const isLocalOcr =
    ocrProvider === "local" ||
    (ocrProvider === "" && settings?.ocrProvider === "local");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>Edit Series</DialogTitle>
      <form onSubmit={handleSubmit}>
        <DialogContent dividers>
          <TextField
            label="Series Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            fullWidth
            margin="normal"
            placeholder="e.g. My Hero Academia"
          />
          <FormControl
            fullWidth
            margin="normal"
          >
            <InputLabel>Source Language</InputLabel>
            <Select
              value={lang}
              label="Source Language"
              onChange={(e) => setLang(e.target.value)}
            >
              {LANG_OPTS.map((l) => (
                <MenuItem
                  key={l}
                  value={l}
                >
                  {l}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl
            fullWidth
            margin="normal"
          >
            <InputLabel>Target Language</InputLabel>
            <Select
              value={targetLang}
              label="Target Language"
              onChange={(e) => setTargetLang(e.target.value)}
            >
              {TARGET_OPTS.map((l) => (
                <MenuItem
                  key={l}
                  value={l}
                >
                  {l}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl
            fullWidth
            margin="normal"
          >
            <InputLabel>Reading Direction</InputLabel>
            <Select
              value={direction}
              label="Reading Direction"
              onChange={(e) => setDirection(e.target.value)}
            >
              {DIR_OPTS.map((d) => (
                <MenuItem
                  key={d.value}
                  value={d.value}
                >
                  {d.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Accordion
            expanded={overridesOpen}
            onChange={() => setOverridesOpen(!overridesOpen)}
            sx={{ mt: 2 }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography
                variant="body2"
                color="text.secondary"
              >
                Model Overrides (Optional)
              </Typography>
            </AccordionSummary>
            <AccordionDetails
              sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1.5 }}
            >
              <FormControl fullWidth>
                <InputLabel>OCR Provider</InputLabel>
                <Select
                  size="small"
                  value={ocrProvider}
                  label="OCR Provider"
                  onChange={(e) => setOcrProvider(e.target.value)}
                >
                  <MenuItem value="">-- Inherit --</MenuItem>
                  {actualOcrProviders.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>OCR Model</InputLabel>
                <Select
                  size="small"
                  value={
                    isLocalOcr ? settings?.localOcrModel || "local" : ocrModel
                  }
                  label="OCR Model"
                  disabled={isLocalOcr}
                  onChange={(e) => setOcrModel(e.target.value)}
                >
                  {isLocalOcr ? (
                    <MenuItem value={settings?.localOcrModel || "local"}>
                      {settings?.localOcrModel || "Local"}
                    </MenuItem>
                  ) : (
                    [
                      <MenuItem
                        key="inh"
                        value=""
                      >
                        -- Inherit --
                      </MenuItem>,
                      ...(settings?.ocrVlmModelList || []).map((m) => (
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
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>TL Provider</InputLabel>
                <Select
                  size="small"
                  value={tlProvider}
                  label="TL Provider"
                  onChange={(e) => setTlProvider(e.target.value)}
                >
                  <MenuItem value="">-- Inherit --</MenuItem>
                  {actualProviders.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>TL Model</InputLabel>
                <Select
                  size="small"
                  value={tlModel}
                  label="TL Model"
                  onChange={(e) => setTlModel(e.target.value)}
                >
                  <MenuItem value="">-- Inherit --</MenuItem>
                  {(settings?.tlLlmModelList || []).map((m) => (
                    <MenuItem
                      key={m}
                      value={m}
                    >
                      {m}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>QA Provider</InputLabel>
                <Select
                  size="small"
                  value={qaProvider}
                  label="QA Provider"
                  onChange={(e) => setQaProvider(e.target.value)}
                >
                  <MenuItem value="">-- Inherit --</MenuItem>
                  {actualProviders.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>QA Mode</InputLabel>
                <Select
                  size="small"
                  value={qaMode}
                  label="QA Mode"
                  onChange={(e) => setQaMode(e.target.value)}
                >
                  <MenuItem value="">-- Inherit --</MenuItem>
                  {["auto", "llm", "vlm", "hybrid", "none"].map((m) => (
                    <MenuItem
                      key={m}
                      value={m}
                    >
                      {m}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>QA LLM Model</InputLabel>
                <Select
                  size="small"
                  value={qaLlmModel}
                  label="QA LLM Model"
                  disabled={qaMode === "vlm" || qaMode === "none"}
                  onChange={(e) => setQaLlmModel(e.target.value)}
                >
                  <MenuItem value="">-- Inherit --</MenuItem>
                  {(settings?.qaLlmModelList || []).map((m) => (
                    <MenuItem
                      key={m}
                      value={m}
                    >
                      {m}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>QA VLM Model</InputLabel>
                <Select
                  size="small"
                  value={qaVlmModel}
                  label="QA VLM Model"
                  disabled={qaMode === "llm" || qaMode === "none"}
                  onChange={(e) => setQaVlmModel(e.target.value)}
                >
                  <MenuItem value="">-- Inherit --</MenuItem>
                  {(settings?.qaVlmModelList || []).map((m) => (
                    <MenuItem
                      key={m}
                      value={m}
                    >
                      {m}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </AccordionDetails>
          </Accordion>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="contained"
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default EditSeriesDialog;
