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
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import type { Chapter, SystemSettingsDto } from "../types";

interface ChapterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSave: (data: any) => Promise<void>;
  initialData?: Chapter | null;
  defaultChapterNumber: number;
  settings: SystemSettingsDto | null;
  error?: string;
}

const ChapterDialog: React.FC<ChapterDialogProps> = ({
  isOpen,
  onClose,
  onSave,
  initialData,
  defaultChapterNumber,
  settings,
  error,
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

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setChapterNum(initialData.chapterNumber);
        setTitle(initialData.title || "");
        setUseContextMemory(initialData.useContextMemory !== false);
        setOcrProvider(initialData.ocrProvider || "");
        setOcrModel(initialData.ocrModel || "");
        setTlProvider(initialData.tlProvider || "");
        setTlModel(initialData.tlModel || "");
        setQaProvider(initialData.qaProvider || "");
        setQaLlmModel(initialData.qaLlmModel || "");
        setQaVlmModel(initialData.qaVlmModel || "");
        setQaMode(initialData.qaMode || "");
      } else {
        setChapterNum(defaultChapterNumber);
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
    }
  }, [isOpen, initialData, defaultChapterNumber]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave({
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
    });
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
    <Dialog open={isOpen} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>{initialData ? "Edit Chapter" : "Add Chapter"}</DialogTitle>
        <DialogContent dividers>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <Box display="flex" flexDirection="column" gap={2} mt={1}>
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
            <FormControlLabel
              control={
                <Switch
                  checked={useContextMemory}
                  onChange={(e) => setUseContextMemory(e.target.checked)}
                />
              }
              label={
                <Box>
                  <Typography variant="body1">Use Context Memory</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Pass previous pages as context to the LLM for better consistency.
                  </Typography>
                </Box>
              }
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
          <Button onClick={onClose} variant="outlined" color="inherit">
            Cancel
          </Button>
          <Button type="submit" variant="contained">
            {initialData ? "Save" : "Create"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default ChapterDialog;
