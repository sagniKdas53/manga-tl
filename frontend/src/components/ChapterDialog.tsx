import React, { useState, useEffect } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Grid from "@mui/material/Grid";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Alert from "@mui/material/Alert";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";

import type { Chapter, Series, SystemSettingsDto } from "../types";
import { safeFetch } from "../utils";

interface ChapterDialogProps {
  isOpen: boolean;
  editingChapter: Chapter | null;
  series: Series;
  nextChapterNum: number;
  onClose: () => void;
  onSuccess: (chapter: Chapter, isEdit: boolean) => void;
  token: string;
}

const ChapterDialog: React.FC<ChapterDialogProps> = ({
  isOpen,
  editingChapter,
  series,
  nextChapterNum,
  onClose,
  onSuccess,
  token,
}) => {
  const [chapterNum, setChapterNum] = useState<number>(1);
  const [title, setTitle] = useState("");
  const [useContextMemory, setUseContextMemory] = useState<boolean>(true);
  
  const [ocrProvider, setOcrProvider] = useState("");
  const [ocrModel, setOcrModel] = useState("");
  const [tlProvider, setTlProvider] = useState("");
  const [tlModel, setTlModel] = useState("");
  const [qaProvider, setQaProvider] = useState("");
  const [qaLlmModel, setQaLlmModel] = useState("");
  const [qaVlmModel, setQaVlmModel] = useState("");
  const [qaMode, setQaMode] = useState("");

  const [error, setError] = useState("");
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);

  useEffect(() => {
    if (isOpen) {
      setError("");
      if (editingChapter) {
        setChapterNum(editingChapter.chapterNumber);
        setTitle(editingChapter.title || "");
        setUseContextMemory(editingChapter.useContextMemory !== false);
        setOcrProvider(editingChapter.ocrProvider || "");
        setOcrModel(editingChapter.ocrModel || "");
        setTlProvider(editingChapter.tlProvider || "");
        setTlModel(editingChapter.tlModel || "");
        setQaProvider(editingChapter.qaProvider || "");
        setQaLlmModel(editingChapter.qaLlmModel || "");
        setQaVlmModel(editingChapter.qaVlmModel || "");
        setQaMode(editingChapter.qaMode || "");
      } else {
        setChapterNum(nextChapterNum);
        setTitle("");
        setUseContextMemory(true);
        setOcrProvider("");
        setOcrModel("");
        setTlProvider("");
        setTlModel("");
        setQaProvider("");
        setQaLlmModel("");
        setQaVlmModel("");
        setQaMode("");
      }
      
      if (!settings) {
        safeFetch("/api/settings", {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => setSettings(data))
          .catch(console.error);
      }
    }
  }, [isOpen, editingChapter, nextChapterNum, token, settings]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const isEdit = !!editingChapter;
      const url = isEdit
        ? `/api/series/chapters/${editingChapter.id}`
        : `/api/series/${series.id}/chapters`;
      const method = isEdit ? "PUT" : "POST";

      const res = await safeFetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          chapterNumber: chapterNum,
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

      if (res.ok) {
        const data: Chapter = await res.json();
        onSuccess(data, isEdit);
      } else {
        let errMsg = "Failed to save chapter";
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
        setError(errMsg);
      }
    } catch (err) {
      console.error("Error saving chapter:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const providers = settings?.activeProviders || ["openrouter", "gemini", "nvidia", "openai", "anthropic", "ollama", "lmstudio"];
  const ocrProviders = settings?.activeOcrProviders || ["local", "openrouter", "gemini", "nvidia", "ollama", "lmstudio"];

  return (
    <Dialog open={isOpen} onClose={onClose} fullWidth maxWidth="sm">
      <form onSubmit={handleSubmit}>
        <DialogTitle>{editingChapter ? "Edit Chapter" : "Create New Chapter"}</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <TextField
              label="Chapter Number"
              type="number"
              inputProps={{ step: "any" }}
              value={chapterNum}
              onChange={(e) => setChapterNum(parseFloat(e.target.value) || 0)}
              fullWidth
              required
            />
            
            <TextField
              label="Chapter Title (Optional)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              fullWidth
            />
            
            <FormControlLabel
              control={
                <Switch
                  checked={useContextMemory}
                  onChange={(e) => setUseContextMemory(e.target.checked)}
                  color="primary"
                />
              }
              label="Use Context Memory"
            />

            <Accordion variant="outlined">
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                Model Overrides (Optional)
              </AccordionSummary>
              <AccordionDetails>
                <Grid container spacing={2}>
                  <Grid item xs={6}>
                    <TextField
                      select
                      label="OCR Provider"
                      value={ocrProvider}
                      onChange={(e) => setOcrProvider(e.target.value)}
                      fullWidth
                      size="small"
                    >
                      <MenuItem value="">-- Inherit --</MenuItem>
                      {ocrProviders.map((p) => (
                        <MenuItem key={p} value={p}>{p}</MenuItem>
                      ))}
                    </TextField>
                  </Grid>
                  <Grid item xs={6}>
                    <TextField
                      select
                      label="OCR VLM Model"
                      value={ocrProvider === "local" || (ocrProvider === "" && (series.ocrProvider === "local" || (!series.ocrProvider && settings?.ocrProvider === "local"))) ? (settings?.localOcrModel || "local") : (ocrModel || "")}
                      onChange={(e) => setOcrModel(e.target.value)}
                      fullWidth
                      size="small"
                      disabled={ocrProvider === "local" || (ocrProvider === "" && (series.ocrProvider === "local" || (!series.ocrProvider && settings?.ocrProvider === "local")))}
                    >
                      {ocrProvider === "local" || (ocrProvider === "" && (series.ocrProvider === "local" || (!series.ocrProvider && settings?.ocrProvider === "local"))) ? (
                        <MenuItem value={settings?.localOcrModel || "local"}>
                          {settings?.localOcrModel || "Local Worker Model"}
                        </MenuItem>
                      ) : (
                        [
                          <MenuItem key="inherit" value="">-- Inherit --</MenuItem>,
                          ...(settings?.ocrVlmModelList || []).map((m) => (
                            <MenuItem key={m} value={m}>{m}</MenuItem>
                          ))
                        ]
                      )}
                    </TextField>
                  </Grid>

                  <Grid item xs={6}>
                    <TextField
                      select
                      label="TL Provider"
                      value={tlProvider}
                      onChange={(e) => setTlProvider(e.target.value)}
                      fullWidth
                      size="small"
                    >
                      <MenuItem value="">-- Inherit --</MenuItem>
                      {providers.map((p) => (
                        <MenuItem key={p} value={p}>{p}</MenuItem>
                      ))}
                    </TextField>
                  </Grid>
                  <Grid item xs={6}>
                    <TextField
                      select
                      label="TL LLM Model"
                      value={tlModel}
                      onChange={(e) => setTlModel(e.target.value)}
                      fullWidth
                      size="small"
                    >
                      <MenuItem value="">-- Inherit --</MenuItem>
                      {(settings?.tlLlmModelList || []).map((m) => (
                        <MenuItem key={m} value={m}>{m}</MenuItem>
                      ))}
                    </TextField>
                  </Grid>

                  <Grid item xs={6}>
                    <TextField
                      select
                      label="QA Mode"
                      value={qaMode}
                      onChange={(e) => setQaMode(e.target.value)}
                      fullWidth
                      size="small"
                    >
                      <MenuItem value="">-- Inherit --</MenuItem>
                      <MenuItem value="auto">auto</MenuItem>
                      <MenuItem value="llm">llm</MenuItem>
                      <MenuItem value="vlm">vlm</MenuItem>
                      <MenuItem value="hybrid">hybrid</MenuItem>
                      <MenuItem value="none">none</MenuItem>
                    </TextField>
                  </Grid>
                  <Grid item xs={6}>
                    <TextField
                      select
                      label="QA Provider"
                      value={qaProvider}
                      onChange={(e) => setQaProvider(e.target.value)}
                      fullWidth
                      size="small"
                    >
                      <MenuItem value="">-- Inherit --</MenuItem>
                      {providers.map((p) => (
                        <MenuItem key={p} value={p}>{p}</MenuItem>
                      ))}
                    </TextField>
                  </Grid>

                  <Grid item xs={6}>
                    <TextField
                      select
                      label="QA LLM Model"
                      value={qaLlmModel}
                      onChange={(e) => setQaLlmModel(e.target.value)}
                      fullWidth
                      size="small"
                      disabled={(qaMode || series.qaMode || settings?.qaMode) === "vlm" || (qaMode || series.qaMode || settings?.qaMode) === "none"}
                    >
                      <MenuItem value="">-- Inherit --</MenuItem>
                      {(settings?.qaLlmModelList || []).map((m) => (
                        <MenuItem key={m} value={m}>{m}</MenuItem>
                      ))}
                    </TextField>
                  </Grid>
                  <Grid item xs={6}>
                    <TextField
                      select
                      label="QA VLM Model"
                      value={qaVlmModel}
                      onChange={(e) => setQaVlmModel(e.target.value)}
                      fullWidth
                      size="small"
                      disabled={(qaMode || series.qaMode || settings?.qaMode) === "llm" || (qaMode || series.qaMode || settings?.qaMode) === "none"}
                    >
                      <MenuItem value="">-- Inherit --</MenuItem>
                      {(settings?.qaVlmModelList || []).map((m) => (
                        <MenuItem key={m} value={m}>{m}</MenuItem>
                      ))}
                    </TextField>
                  </Grid>
                </Grid>
              </AccordionDetails>
            </Accordion>
          </Box>
          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} color="inherit">Cancel</Button>
          <Button type="submit" variant="contained">{editingChapter ? "Save" : "Add"}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default ChapterDialog;
