import React, { useState, useEffect } from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { User, Chapter, Series } from "../types";
import { safeFetch } from "../utils";

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
}

interface CreateChapterDialogProps {
  open: boolean;
  editingChapter: Chapter | null;
  user: User;
  selectedSeries: Series | null;
  chapters: Chapter[];
  onClose: () => void;
  onSuccess: (chapter: Chapter) => void;
  onError: (message: string) => void;
}

const DEFAULT_PROVIDERS = [
  "openrouter", "gemini", "nvidia", "openai", "anthropic", "ollama", "lmstudio",
];
const DEFAULT_OCR_PROVIDERS = [
  "local", "openrouter", "gemini", "nvidia", "ollama", "lmstudio",
];
const QA_MODES = ["auto", "llm", "vlm", "hybrid", "none"];

const CreateChapterDialog: React.FC<CreateChapterDialogProps> = ({
  open,
  editingChapter,
  user,
  selectedSeries,
  chapters,
  onClose,
  onSuccess,
  onError,
}) => {
  const defaultNum = editingChapter
    ? editingChapter.chapterNumber
    : chapters.reduce((m, c) => Math.max(m, c.chapterNumber), 0) +
        (chapters.length > 0 ? 1 : 1);
  const [number, setNumber] = useState(defaultNum);
  const [title, setTitle] = useState(editingChapter?.title || "");
  const [useContextMemory, setUseContextMemory] = useState(
    editingChapter?.useContextMemory ?? true,
  );
  const [showOverrides, setShowOverrides] = useState(false);

  const [ocrProvider, setOcrProvider] = useState(
    editingChapter?.ocrProvider || "",
  );
  const [ocrModel, setOcrModel] = useState(editingChapter?.ocrModel || "");
  const [tlProvider, setTlProvider] = useState(editingChapter?.tlProvider || "");
  const [tlModel, setTlModel] = useState(editingChapter?.tlModel || "");
  const [qaProvider, setQaProvider] = useState(editingChapter?.qaProvider || "");
  const [qaLlmModel, setQaLlmModel] = useState(
    editingChapter?.qaLlmModel || "",
  );
  const [qaVlmModel, setQaVlmModel] = useState(
    editingChapter?.qaVlmModel || "",
  );
  const [qaMode, setQaMode] = useState(editingChapter?.qaMode || "");

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && !settings) {
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((r) => r.json())
        .then((d) => setSettings(d))
        .catch(() => {});
    }
  }, [open, settings, user.token]);

  const providers = settings?.activeProviders || DEFAULT_PROVIDERS;
  const ocrProviders = settings?.activeOcrProviders || DEFAULT_OCR_PROVIDERS;

  const resolvedOcrProvider =
    ocrProvider || selectedSeries?.ocrProvider || settings?.ocrProvider;
  const ocrDisabled = resolvedOcrProvider === "local";

  const resolvedQaMode =
    qaMode || selectedSeries?.qaMode || settings?.qaMode;
  const qaLlmDisabled =
    resolvedQaMode === "vlm" || resolvedQaMode === "none";
  const qaVlmDisabled =
    resolvedQaMode === "llm" || resolvedQaMode === "none";

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const isEdit = !!editingChapter;
      const url = isEdit
        ? `/api/series/chapters/${editingChapter.id}`
        : `/api/series/${selectedSeries?.id}/chapters`;
      const res = await safeFetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: {
          Authorization: `Bearer ${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chapterNumber: number,
          title,
          useContextMemory,
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
      if (!res.ok) {
        const body = await res.text();
        let msg = body;
        try { msg = JSON.parse(body).message || body; } catch { /* */ }
        onError(msg);
        setSaving(false);
        return;
      }
      const data = await res.json();
      onSuccess(data);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {editingChapter ? "Edit Chapter" : "Add Chapter"}
      </DialogTitle>
      <DialogContent dividers>
        <TextField
          label="Chapter Number"
          type="number"
          value={number}
          onChange={(e) => setNumber(Number(e.target.value))}
          required
          fullWidth
          margin="normal"
          slotProps={{ htmlInput: { step: "any" } }}
        />
        <TextField
          label="Chapter Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          fullWidth
          margin="normal"
          placeholder="e.g. The Beginning"
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={useContextMemory}
              onChange={(e) => setUseContextMemory(e.target.checked)}
            />
          }
          label="Inject Context Memory"
          sx={{ mt: 1 }}
        />
        <Accordion
          expanded={showOverrides}
          onChange={() => setShowOverrides(!showOverrides)}
          sx={{ mt: 2 }}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="body2">Model Overrides (Optional)</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <FormControl fullWidth margin="dense">
              <InputLabel>OCR Provider</InputLabel>
              <Select
                value={ocrProvider}
                label="OCR Provider"
                onChange={(e) => setOcrProvider(e.target.value)}
              >
                <MenuItem value="">-- Inherit --</MenuItem>
                {ocrProviders.map((p) => (
                  <MenuItem key={p} value={p}>{p}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth margin="dense" disabled={ocrDisabled}>
              <InputLabel>OCR VLM Model</InputLabel>
              <Select
                value={ocrModel}
                label="OCR VLM Model"
                onChange={(e) => setOcrModel(e.target.value)}
              >
                <MenuItem value="">-- Inherit --</MenuItem>
                {ocrDisabled && settings?.localOcrModel ? (
                  <MenuItem value={settings.localOcrModel}>
                    {settings.localOcrModel}
                  </MenuItem>
                ) : (
                  (settings?.ocrVlmModelList || []).map((m) => (
                    <MenuItem key={m} value={m}>{m}</MenuItem>
                  ))
                )}
              </Select>
            </FormControl>
            <FormControl fullWidth margin="dense">
              <InputLabel>TL Provider</InputLabel>
              <Select
                value={tlProvider}
                label="TL Provider"
                onChange={(e) => setTlProvider(e.target.value)}
              >
                <MenuItem value="">-- Inherit --</MenuItem>
                {providers.map((p) => (
                  <MenuItem key={p} value={p}>{p}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth margin="dense">
              <InputLabel>TL LLM Model</InputLabel>
              <Select
                value={tlModel}
                label="TL LLM Model"
                onChange={(e) => setTlModel(e.target.value)}
              >
                <MenuItem value="">-- Inherit --</MenuItem>
                {(settings?.tlLlmModelList || []).map((m) => (
                  <MenuItem key={m} value={m}>{m}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth margin="dense">
              <InputLabel>QA Provider</InputLabel>
              <Select
                value={qaProvider}
                label="QA Provider"
                onChange={(e) => setQaProvider(e.target.value)}
              >
                <MenuItem value="">-- Inherit --</MenuItem>
                {providers.map((p) => (
                  <MenuItem key={p} value={p}>{p}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth margin="dense">
              <InputLabel>QA Mode</InputLabel>
              <Select
                value={qaMode}
                label="QA Mode"
                onChange={(e) => setQaMode(e.target.value)}
              >
                <MenuItem value="">-- Inherit --</MenuItem>
                {QA_MODES.map((m) => (
                  <MenuItem key={m} value={m}>{m}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth margin="dense" disabled={qaLlmDisabled}>
              <InputLabel>QA LLM Model</InputLabel>
              <Select
                value={qaLlmModel}
                label="QA LLM Model"
                onChange={(e) => setQaLlmModel(e.target.value)}
              >
                <MenuItem value="">-- Inherit --</MenuItem>
                {(settings?.qaLlmModelList || []).map((m) => (
                  <MenuItem key={m} value={m}>{m}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth margin="dense" disabled={qaVlmDisabled}>
              <InputLabel>QA VLM Model</InputLabel>
              <Select
                value={qaVlmModel}
                label="QA VLM Model"
                onChange={(e) => setQaVlmModel(e.target.value)}
              >
                <MenuItem value="">-- Inherit --</MenuItem>
                {(settings?.qaVlmModelList || []).map((m) => (
                  <MenuItem key={m} value={m}>{m}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </AccordionDetails>
        </Accordion>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={!number || saving}
        >
          {saving
            ? "Saving..."
            : editingChapter
              ? "Update Chapter"
              : "Create Chapter"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default CreateChapterDialog;