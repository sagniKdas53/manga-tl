/* eslint-disable react-hooks/set-state-in-effect */
import React, { useState, useEffect } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Box from "@mui/material/Box";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import Typography from "@mui/material/Typography";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import type { SystemSettingsDto } from "../types";

interface ImportChapterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (formData: FormData) => Promise<void>;
  defaultChapterNumber: number;
  settings: SystemSettingsDto | null;
  error?: string;
  isImporting: boolean;
}

const ImportChapterDialog: React.FC<ImportChapterDialogProps> = ({
  isOpen,
  onClose,
  onImport,
  defaultChapterNumber,
  settings,
  error,
  isImporting,
}) => {
  const [chapterNum, setChapterNum] = useState<number>(1);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [ocrProvider, setOcrProvider] = useState("");
  const [ocrModel, setOcrModel] = useState("");
  const [tlProvider, setTlProvider] = useState("");
  const [tlModel, setTlModel] = useState("");
  const [qaProvider, setQaProvider] = useState("");
  const [qaLlmModel, setQaLlmModel] = useState("");
  const [qaVlmModel, setQaVlmModel] = useState("");
  const [qaMode, setQaMode] = useState("");

  useEffect(() => {
    if (isOpen) {
      setChapterNum(defaultChapterNumber);
      setTitle("");
      setFile(null);
      setOcrProvider("");
      setOcrModel("");
      setTlProvider("");
      setTlModel("");
      setQaProvider("");
      setQaLlmModel("");
      setQaVlmModel("");
      setQaMode("");
    }
  }, [isOpen, defaultChapterNumber]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

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

    await onImport(formData);
  };

  const providers = settings?.activeProviders || [
    "openrouter",
    "gemini",
    "nvidia",
    "openai",
    "anthropic",
    "ollama",
    "lmstudio",
  ];
  const ocrProviders = settings?.activeOcrProviders || [
    "local",
    "openrouter",
    "gemini",
    "nvidia",
    "ollama",
    "lmstudio",
  ];

  const disableOcrModel =
    ocrProvider === "local" ||
    (ocrProvider === "" && settings?.ocrProvider === "local");
  const actualOcrModel = disableOcrModel
    ? settings?.localOcrModel || "local"
    : ocrModel || "";

  const disableQaLlmModel =
    (qaMode || settings?.qaMode) === "vlm" ||
    (qaMode || settings?.qaMode) === "none";
  const disableQaVlmModel =
    (qaMode || settings?.qaMode) === "llm" ||
    (qaMode || settings?.qaMode) === "none";

  return (
    <Dialog open={isOpen} onClose={!isImporting ? onClose : undefined} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>Import Chapter (ZIP / ePub)</DialogTitle>
        <DialogContent dividers>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <Box display="flex" flexDirection="column" gap={2} mt={1}>
            <TextField
              type="file"
              onChange={(e) => {
                const target = e.target as HTMLInputElement;
                if (target.files && target.files.length > 0) {
                  setFile(target.files[0]);
                }
              }}
              required
              fullWidth
              InputLabelProps={{ shrink: true }}
              inputProps={{ accept: ".zip,.epub" }}
              helperText="Upload a .zip containing images, or a .epub file."
            />
            <TextField
              label="Chapter Number"
              type="number"
              value={chapterNum}
              onChange={(e) => setChapterNum(Number(e.target.value))}
              required
              fullWidth
              inputProps={{ min: 0, step: 0.1 }}
            />
            <TextField
              label="Title (Optional)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. The Beginning"
              fullWidth
            />

            <Accordion variant="outlined" sx={{ mt: 1 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography>Model Overrides (Optional)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Box display="grid" gridTemplateColumns="1fr 1fr" gap={2}>
                  <TextField
                    select
                    label="OCR Provider"
                    value={ocrProvider}
                    onChange={(e) => setOcrProvider(e.target.value)}
                    size="small"
                  >
                    <MenuItem value="">-- Inherit --</MenuItem>
                    {ocrProviders.map((p) => (
                      <MenuItem key={p} value={p}>
                        {p}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    label="OCR VLM Model"
                    value={actualOcrModel}
                    onChange={(e) => setOcrModel(e.target.value)}
                    disabled={disableOcrModel}
                    size="small"
                  >
                    {disableOcrModel ? (
                      <MenuItem value={settings?.localOcrModel || "local"}>
                        {settings?.localOcrModel || "Local Worker Model"}
                      </MenuItem>
                    ) : (
                      [
                        <MenuItem key="inherit" value="">
                          -- Inherit --
                        </MenuItem>,
                        ...(settings?.ocrVlmModelList || []).map((m) => (
                          <MenuItem key={m} value={m}>
                            {m}
                          </MenuItem>
                        )),
                      ]
                    )}
                  </TextField>

                  <TextField
                    select
                    label="TL Provider"
                    value={tlProvider}
                    onChange={(e) => setTlProvider(e.target.value)}
                    size="small"
                  >
                    <MenuItem value="">-- Inherit --</MenuItem>
                    {providers.map((p) => (
                      <MenuItem key={p} value={p}>
                        {p}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    label="TL LLM Model"
                    value={tlModel}
                    onChange={(e) => setTlModel(e.target.value)}
                    size="small"
                  >
                    <MenuItem value="">-- Inherit --</MenuItem>
                    {(settings?.tlLlmModelList || []).map((m) => (
                      <MenuItem key={m} value={m}>
                        {m}
                      </MenuItem>
                    ))}
                  </TextField>

                  <TextField
                    select
                    label="QA Provider"
                    value={qaProvider}
                    onChange={(e) => setQaProvider(e.target.value)}
                    size="small"
                  >
                    <MenuItem value="">-- Inherit --</MenuItem>
                    {providers.map((p) => (
                      <MenuItem key={p} value={p}>
                        {p}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    label="QA Mode"
                    value={qaMode}
                    onChange={(e) => setQaMode(e.target.value)}
                    size="small"
                  >
                    <MenuItem value="">-- Inherit --</MenuItem>
                    <MenuItem value="auto">auto</MenuItem>
                    <MenuItem value="llm">llm</MenuItem>
                    <MenuItem value="vlm">vlm</MenuItem>
                    <MenuItem value="hybrid">hybrid</MenuItem>
                    <MenuItem value="none">none</MenuItem>
                  </TextField>

                  <TextField
                    select
                    label="QA LLM Model"
                    value={qaLlmModel}
                    onChange={(e) => setQaLlmModel(e.target.value)}
                    disabled={disableQaLlmModel}
                    size="small"
                  >
                    <MenuItem value="">-- Inherit --</MenuItem>
                    {(settings?.qaLlmModelList || []).map((m) => (
                      <MenuItem key={m} value={m}>
                        {m}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    select
                    label="QA VLM Model"
                    value={qaVlmModel}
                    onChange={(e) => setQaVlmModel(e.target.value)}
                    disabled={disableQaVlmModel}
                    size="small"
                  >
                    <MenuItem value="">-- Inherit --</MenuItem>
                    {(settings?.qaVlmModelList || []).map((m) => (
                      <MenuItem key={m} value={m}>
                        {m}
                      </MenuItem>
                    ))}
                  </TextField>
                </Box>
              </AccordionDetails>
            </Accordion>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} variant="outlined" color="inherit" disabled={isImporting}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={isImporting || !file}>
            {isImporting ? <CircularProgress size={24} color="inherit" /> : "Import"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default ImportChapterDialog;
