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
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { User, Series, Chapter } from "../types";
import { safeFetch } from "../utils";

interface ImportChapterDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (chapter: Chapter) => void;
  user: User;
  series: Series;
  nextNum: number;
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
}

export const ImportChapterDialog: React.FC<ImportChapterDialogProps> = ({
  open,
  onClose,
  onSuccess,
  user,
  series,
  nextNum,
}) => {
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [chapterNum, setChapterNum] = useState(nextNum);
  const [title, setTitle] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [overridesOpen, setOverridesOpen] = useState(false);

  const [ocrProvider, setOcrProvider] = useState("");
  const [ocrModel, setOcrModel] = useState("");
  const [tlProvider, setTlProvider] = useState("");
  const [tlModel, setTlModel] = useState("");
  const [qaProvider, setQaProvider] = useState("");
  const [qaLlmModel, setQaLlmModel] = useState("");
  const [qaVlmModel, setQaVlmModel] = useState("");
  const [qaMode, setQaMode] = useState("");

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
        .then((d) => {
          if (d) setSettings(d);
        })
        .catch(() => {});
    }
  }, [open, user.token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setImportError("");
    setImporting(true);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("chapterNumber", chapterNum.toString());
    formData.append("title", title);
    if (ocrProvider) formData.append("ocrProvider", ocrProvider);
    if (ocrModel) formData.append("ocrModel", ocrModel);
    if (tlProvider) formData.append("tlProvider", tlProvider);
    if (tlModel) formData.append("tlModel", tlModel);
    if (qaProvider) formData.append("qaProvider", qaProvider);
    if (qaLlmModel) formData.append("qaLlmModel", qaLlmModel);
    if (qaVlmModel) formData.append("qaVlmModel", qaVlmModel);
    if (qaMode) formData.append("qaMode", qaMode);

    try {
      const res = await safeFetch(`/api/series/${series.id}/chapters/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      } as RequestInit);
      if (res.ok) {
        const data: Chapter = await res.json();
        onSuccess(data);
        onClose();
      } else {
        const text = await res.text();
        let msg = "Failed to import chapter";
        try {
          const p = JSON.parse(text);
          msg = p.message || msg;
        } catch {}
        setImportError(msg);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const isLocalOcr =
    ocrProvider === "local" ||
    (ocrProvider === "" &&
      (series.ocrProvider === "local" ||
        (!series.ocrProvider && settings?.ocrProvider === "local")));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>Import Chapter (ZIP)</DialogTitle>
      <form onSubmit={handleSubmit}>
        <DialogContent dividers>
          <Box sx={{ mb: 2 }}>
            <Typography
              variant="body2"
              gutterBottom
            >
              ZIP / ePub Archive
            </Typography>
            <input
              type="file"
              accept=".zip,.epub,application/epub+zip,application/zip"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              required
              style={{ display: "block", width: "100%" }}
            />
          </Box>
          <TextField
            label="Chapter Number"
            type="number"
            value={chapterNum}
            onChange={(e) => setChapterNum(parseFloat(e.target.value) || 0)}
            required
            fullWidth
            margin="normal"
          />
          <TextField
            label="Chapter Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Imported Volume"
            fullWidth
            margin="normal"
          />

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

          {importError && (
            <Alert
              severity="error"
              sx={{ mt: 2 }}
            >
              {importError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="contained"
            disabled={importing || !file}
          >
            {importing ? (
              <CircularProgress
                size={16}
                sx={{ mr: 1 }}
              />
            ) : null}
            {importing ? "Importing..." : "Import"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default ImportChapterDialog;
