import React, { useState, useEffect } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Box from "@mui/material/Box";
import type { User, Series, Chapter, SystemSettingsDto } from "../types";
import { safeFetch } from "../utils";
import ModelOverridesAccordion, {
  type ModelOverridesValue,
} from "./ModelOverridesAccordion";

interface ImportChapterDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (chapter: Chapter) => void;
  user: User;
  series: Series;
  nextNum: number;
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
  const [routingStrategy, setRoutingStrategy] = useState("");
  const [useFallbackModels, setUseFallbackModels] = useState<boolean | null>(
    series.useFallbackModels ?? null,
  );

  const overridesValue: ModelOverridesValue = {
    ocrProvider,
    ocrModel,
    tlProvider,
    tlModel,
    qaProvider,
    qaLlmModel,
    qaVlmModel,
    qaMode,
    routingStrategy,
    useFallbackModels,
  };

  const overrideSetters: {
    [K in keyof ModelOverridesValue]: (v: ModelOverridesValue[K]) => void;
  } = {
    ocrProvider: setOcrProvider,
    ocrModel: setOcrModel,
    tlProvider: setTlProvider,
    tlModel: setTlModel,
    qaProvider: setQaProvider,
    qaLlmModel: setQaLlmModel,
    qaVlmModel: setQaVlmModel,
    qaMode: setQaMode,
    routingStrategy: setRoutingStrategy,
    useFallbackModels: setUseFallbackModels,
  };

  const handleOverrideChange = <K extends keyof ModelOverridesValue>(
    field: K,
    fieldValue: ModelOverridesValue[K],
  ) => {
    overrideSetters[field](fieldValue);
  };

  useEffect(() => {
    if (open) {
      Promise.resolve().then(() => {
        setUseFallbackModels(series.useFallbackModels ?? null);
      });
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d) {
            setSettings(d);
          }
        })
        .catch(() => {});
    }
  }, [open, series, user.token]);

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
    if (routingStrategy) formData.append("routingStrategy", routingStrategy);
    formData.append("useFallbackModels", String(useFallbackModels));

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
        } catch {
          /* JSON parse failed — use raw text */
        }
        setImportError(msg);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

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

          <ModelOverridesAccordion
            expanded={overridesOpen}
            onToggle={() => setOverridesOpen(!overridesOpen)}
            value={overridesValue}
            onChange={handleOverrideChange}
            settings={settings}
            inherited={{
              ocrProvider: series.ocrProvider || settings?.ocrProvider,
              ocrModel: series.ocrModel || settings?.ocrModel,
              tlProvider: series.tlProvider || settings?.tlProvider,
              tlModel: series.tlModel || settings?.tlModel,
              qaProvider: series.qaProvider || settings?.qaProvider,
              qaMode: series.qaMode || settings?.qaMode,
              qaLlmModel: series.qaLlmModel || settings?.qaLlmModel,
              qaVlmModel: series.qaVlmModel || settings?.qaVlmModel,
              routingStrategy:
                series.routingStrategy || settings?.routingStrategy,
              useFallbackModels:
                series.useFallbackModels ?? settings?.useFallbackModels,
            }}
            ocrModelLabel="OCR Model"
            tlModelLabel="TL Model"
            localOcrModelLabel="Local"
            useResolvedQaModeForDisable={false}
          />

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
