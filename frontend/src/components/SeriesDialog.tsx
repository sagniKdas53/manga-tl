/* eslint-disable react-hooks/set-state-in-effect */
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
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
import type { Series, SystemSettingsDto } from "../types";

interface SeriesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSave: (data: any) => Promise<void>;
  initialData?: Series | null;
  settings: SystemSettingsDto | null;
}

const SeriesDialog: React.FC<SeriesDialogProps> = ({
  isOpen,
  onClose,
  onSave,
  initialData,
  settings,
}) => {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));

  const [title, setTitle] = useState("");
  const [sourceLang, setSourceLang] = useState("ja");
  const [targetLang, setTargetLang] = useState("en");
  const [readingDirection, setReadingDirection] = useState("rtl");

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
        setTitle(initialData.title);
        setSourceLang(
          initialData.sourceLanguage || initialData.originalLanguage || "ja",
        );
        setTargetLang(initialData.targetLanguage || "en");
        setReadingDirection(initialData.readingDirection);
        setOcrProvider(initialData.ocrProvider || "");
        setOcrModel(initialData.ocrModel || "");
        setTlProvider(initialData.tlProvider || "");
        setTlModel(initialData.tlModel || "");
        setQaProvider(initialData.qaProvider || "");
        setQaLlmModel(initialData.qaLlmModel || "");
        setQaVlmModel(initialData.qaVlmModel || "");
        setQaMode(initialData.qaMode || "");
      } else {
        setTitle("");
        setSourceLang("ja");
        setTargetLang("en");
        setReadingDirection("rtl");
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
  }, [isOpen, initialData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave({
      title,
      originalLanguage: sourceLang,
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
      readingDirection,
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
    <Dialog
      fullScreen={fullScreen}
      open={isOpen}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
    >
      <form onSubmit={handleSubmit}>
        <DialogTitle>
          {initialData ? "Edit Series" : "Create New Series"}
        </DialogTitle>
        <DialogContent dividers>
          <Box
            display="flex"
            flexDirection="column"
            gap={2}
            mt={1}
          >
            <TextField
              label="Series Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. My Hero Academia"
              required
              fullWidth
              variant="outlined"
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
              value={readingDirection}
              onChange={(e) => setReadingDirection(e.target.value)}
              fullWidth
            >
              <MenuItem value="rtl">Right to Left (Manga)</MenuItem>
              <MenuItem value="ltr">Left to Right (Comics)</MenuItem>
              <MenuItem value="ttb">Top to Bottom (Webtoons)</MenuItem>
            </TextField>

            <Accordion
              variant="outlined"
              sx={{ mt: 1 }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography>Model Overrides (Optional)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Box
                  display="grid"
                  gridTemplateColumns="1fr 1fr"
                  gap={2}
                >
                  <TextField
                    select
                    label="OCR Provider"
                    value={ocrProvider}
                    onChange={(e) => setOcrProvider(e.target.value)}
                    size="small"
                  >
                    <MenuItem value="">-- Inherit --</MenuItem>
                    {ocrProviders.map((p) => (
                      <MenuItem
                        key={p}
                        value={p}
                      >
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
                        <MenuItem
                          key="inherit"
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
                      <MenuItem
                        key={p}
                        value={p}
                      >
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
                      <MenuItem
                        key={m}
                        value={m}
                      >
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
                      <MenuItem
                        key={p}
                        value={p}
                      >
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
                      <MenuItem
                        key={m}
                        value={m}
                      >
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
                      <MenuItem
                        key={m}
                        value={m}
                      >
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
          <Button
            onClick={onClose}
            variant="outlined"
            color="inherit"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
          >
            {initialData ? "Save" : "Create"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default SeriesDialog;
