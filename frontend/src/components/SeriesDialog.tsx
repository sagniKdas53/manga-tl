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

import type { Series, SystemSettingsDto } from "../types";
import { safeFetch } from "../utils";

interface SeriesDialogProps {
  isOpen: boolean;
  editingSeries: Series | null;
  onClose: () => void;
  onSuccess: (series: Series, isEdit: boolean) => void;
  token: string;
}

const SeriesDialog: React.FC<SeriesDialogProps> = ({
  isOpen,
  editingSeries,
  onClose,
  onSuccess,
  token,
}) => {
  const [title, setTitle] = useState("");
  const [sourceLang, setSourceLang] = useState("ja");
  const [targetLang, setTargetLang] = useState("en");
  const [direction, setDirection] = useState("rtl");

  const [ocrProvider, setOcrProvider] = useState("");
  const [ocrModel, setOcrModel] = useState("");
  const [tlProvider, setTlProvider] = useState("");
  const [tlModel, setTlModel] = useState("");
  const [qaProvider, setQaProvider] = useState("");
  const [qaLlmModel, setQaLlmModel] = useState("");
  const [qaVlmModel, setQaVlmModel] = useState("");
  const [qaMode, setQaMode] = useState("");

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);

  useEffect(() => {
    if (isOpen) {
      if (editingSeries) {
        setTitle(editingSeries.title);
        setSourceLang(editingSeries.sourceLanguage || editingSeries.originalLanguage || "ja");
        setTargetLang(editingSeries.targetLanguage || "en");
        setDirection(editingSeries.readingDirection || "rtl");
        setOcrProvider(editingSeries.ocrProvider || "");
        setOcrModel(editingSeries.ocrModel || "");
        setTlProvider(editingSeries.tlProvider || "");
        setTlModel(editingSeries.tlModel || "");
        setQaProvider(editingSeries.qaProvider || "");
        setQaLlmModel(editingSeries.qaLlmModel || "");
        setQaVlmModel(editingSeries.qaVlmModel || "");
        setQaMode(editingSeries.qaMode || "");
      } else {
        setTitle("");
        setSourceLang("ja");
        setTargetLang("en");
        setDirection("rtl");
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
  }, [isOpen, editingSeries, token, settings]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const isEdit = !!editingSeries;
      const url = isEdit ? `/api/series/${editingSeries.id}` : "/api/series";
      const method = isEdit ? "PUT" : "POST";

      const res = await safeFetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title,
          originalLanguage: sourceLang,
          sourceLanguage: sourceLang,
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
        onSuccess(data, isEdit);
      }
    } catch (err) {
      console.error("Error saving series:", err);
    }
  };

  const providers = settings?.activeProviders || ["openrouter", "gemini", "nvidia", "openai", "anthropic", "ollama", "lmstudio"];
  const ocrProviders = settings?.activeOcrProviders || ["local", "openrouter", "gemini", "nvidia", "ollama", "lmstudio"];

  return (
    <Dialog open={isOpen} onClose={onClose} fullWidth maxWidth="sm">
      <form onSubmit={handleSubmit}>
        <DialogTitle>{editingSeries ? "Edit Series" : "Create New Series"}</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <TextField
              label="Series Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              fullWidth
              required
            />
            
            <TextField
              select
              label="Source Language"
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
              fullWidth
            >
              <MenuItem value="ja">Japanese (ja)</MenuItem>
              <MenuItem value="zh-TW">Traditional Chinese (zh-TW)</MenuItem>
              <MenuItem value="zh-CN">Simplified Chinese (zh-CN)</MenuItem>
              <MenuItem value="ko">Korean (ko)</MenuItem>
              <MenuItem value="en">English (en)</MenuItem>
            </TextField>

            <TextField
              select
              label="Target Language"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              fullWidth
            >
              <MenuItem value="en">English (en)</MenuItem>
              <MenuItem value="ja">Japanese (ja)</MenuItem>
              <MenuItem value="zh-TW">Traditional Chinese (zh-TW)</MenuItem>
              <MenuItem value="zh-CN">Simplified Chinese (zh-CN)</MenuItem>
              <MenuItem value="ko">Korean (ko)</MenuItem>
            </TextField>

            <TextField
              select
              label="Reading Direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              fullWidth
            >
              <MenuItem value="rtl">Right to Left (Manga)</MenuItem>
              <MenuItem value="ltr">Left to Right (Comics)</MenuItem>
              <MenuItem value="ttb">Top to Bottom (Webtoons)</MenuItem>
            </TextField>

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
                      value={ocrProvider === "local" || (ocrProvider === "" && settings?.ocrProvider === "local") ? (settings?.localOcrModel || "local") : (ocrModel || "")}
                      onChange={(e) => setOcrModel(e.target.value)}
                      fullWidth
                      size="small"
                      disabled={ocrProvider === "local" || (ocrProvider === "" && settings?.ocrProvider === "local")}
                    >
                      {ocrProvider === "local" || (ocrProvider === "" && settings?.ocrProvider === "local") ? (
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
                      disabled={(qaMode || settings?.qaMode) === "vlm" || (qaMode || settings?.qaMode) === "none"}
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
                      disabled={(qaMode || settings?.qaMode) === "llm" || (qaMode || settings?.qaMode) === "none"}
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
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} color="inherit">Cancel</Button>
          <Button type="submit" variant="contained">{editingSeries ? "Save" : "Create"}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default SeriesDialog;
