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
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { User, Chapter, Series, SystemSettingsDto } from "../types";
import { safeFetch } from "../utils";

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
  "openrouter",
  "gemini",
  "nvidia",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
];
const DEFAULT_OCR_PROVIDERS = [
  "local",
  "openrouter",
  "gemini",
  "nvidia",
  "ollama",
  "lmstudio",
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
  const [tlProvider, setTlProvider] = useState(
    editingChapter?.tlProvider || "",
  );
  const [tlModel, setTlModel] = useState(editingChapter?.tlModel || "");
  const [qaProvider, setQaProvider] = useState(
    editingChapter?.qaProvider || "",
  );
  const [qaLlmModel, setQaLlmModel] = useState(
    editingChapter?.qaLlmModel || "",
  );
  const [qaVlmModel, setQaVlmModel] = useState(
    editingChapter?.qaVlmModel || "",
  );
  const [qaMode, setQaMode] = useState(editingChapter?.qaMode || "");
  const [routingStrategy, setRoutingStrategy] = useState(editingChapter?.routingStrategy || "");

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

  const inheritedOcrProvider = selectedSeries?.ocrProvider || settings?.ocrProvider;
  const inheritedOcrModel = selectedSeries?.ocrModel || settings?.ocrModel;
  const inheritedTlProvider = selectedSeries?.tlProvider || settings?.tlProvider;
  const inheritedTlModel = selectedSeries?.tlModel || settings?.tlModel;
  const inheritedQaProvider = selectedSeries?.qaProvider || settings?.qaProvider;
  const inheritedQaMode = selectedSeries?.qaMode || settings?.qaMode;
  const inheritedQaLlmModel = selectedSeries?.qaLlmModel || settings?.qaLlmModel;
  const inheritedQaVlmModel = selectedSeries?.qaVlmModel || settings?.qaVlmModel;
  const inheritedRoutingStrategy = selectedSeries?.routingStrategy || settings?.routingStrategy || "lowest-cost";

  const overrideFields = [
    ocrProvider, ocrModel, tlProvider, tlModel,
    qaProvider, qaMode, qaLlmModel, qaVlmModel, routingStrategy,
  ];
  const overriddenCount = overrideFields.filter((v) => v !== "").length;
  const inheritedCount = overrideFields.length - overriddenCount;

  const resolvedOcrProvider =
    ocrProvider || selectedSeries?.ocrProvider || settings?.ocrProvider;
  const ocrDisabled = resolvedOcrProvider === "local";

  const resolvedQaMode = qaMode || selectedSeries?.qaMode || settings?.qaMode;
  const qaLlmDisabled = resolvedQaMode === "vlm" || resolvedQaMode === "none";
  const qaVlmDisabled = resolvedQaMode === "llm" || resolvedQaMode === "none";

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
          routingStrategy: routingStrategy || null,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        let msg = body;
        try {
          msg = JSON.parse(body).message || body;
        } catch {
          /* */
        }
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
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
    >
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
            <Chip
              size="small"
              label={`${overriddenCount} overridden, ${inheritedCount} inherited`}
              variant="outlined"
              sx={{ ml: 1 }}
            />
          </AccordionSummary>
          <AccordionDetails
            sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1.5 }}
          >
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
              <FormControl fullWidth>
                <InputLabel>OCR Provider</InputLabel>
                <Select
                  size="small"
                  value={ocrProvider || inheritedOcrProvider || ""}
                  label="OCR Provider"
                  onChange={(e) => setOcrProvider(e.target.value)}
                >
                  {ocrProviders.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {ocrProvider !== "" && (
                <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => setOcrProvider("")}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
              <FormControl
                fullWidth
                disabled={ocrDisabled}
              >
                <InputLabel>OCR VLM Model</InputLabel>
                <Select
                  size="small"
                  value={
                    ocrDisabled
                      ? settings?.localOcrModel || "local"
                      : ocrModel || inheritedOcrModel || ""
                  }
                  label="OCR VLM Model"
                  onChange={(e) => setOcrModel(e.target.value)}
                >
                  {ocrDisabled ? (
                    <MenuItem value={settings?.localOcrModel || "local"}>
                      {settings?.localOcrModel || "Local Worker Model"}
                    </MenuItem>
                  ) : (
                    (settings?.ocrVlmModelList || []).map((m) => (
                      <MenuItem
                        key={m}
                        value={m}
                      >
                        {m}
                      </MenuItem>
                    ))
                  )}
                </Select>
              </FormControl>
              {ocrModel !== "" && (
                <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => setOcrModel("")}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
              <FormControl fullWidth>
                <InputLabel>TL Provider</InputLabel>
                <Select
                  size="small"
                  value={tlProvider || inheritedTlProvider || ""}
                  label="TL Provider"
                  onChange={(e) => setTlProvider(e.target.value)}
                >
                  {providers.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {tlProvider !== "" && (
                <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => setTlProvider("")}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
              <FormControl fullWidth>
                <InputLabel>TL LLM Model</InputLabel>
                <Select
                  size="small"
                  value={tlModel || inheritedTlModel || ""}
                  label="TL LLM Model"
                  onChange={(e) => setTlModel(e.target.value)}
                >
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
              {tlModel !== "" && (
                <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => setTlModel("")}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
              <FormControl fullWidth>
                <InputLabel>QA Provider</InputLabel>
                <Select
                  size="small"
                  value={qaProvider || inheritedQaProvider || ""}
                  label="QA Provider"
                  onChange={(e) => setQaProvider(e.target.value)}
                >
                  {providers.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {qaProvider !== "" && (
                <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => setQaProvider("")}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
              <FormControl fullWidth>
                <InputLabel>QA Mode</InputLabel>
                <Select
                  size="small"
                  value={qaMode || inheritedQaMode || ""}
                  label="QA Mode"
                  onChange={(e) => setQaMode(e.target.value)}
                >
                  {QA_MODES.map((m) => (
                    <MenuItem
                      key={m}
                      value={m}
                    >
                      {m}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {qaMode !== "" && (
                <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => setQaMode("")}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
              <FormControl fullWidth>
                <InputLabel>Routing Strategy</InputLabel>
                <Select
                  size="small"
                  value={routingStrategy || inheritedRoutingStrategy}
                  label="Routing Strategy"
                  onChange={(e) => setRoutingStrategy(e.target.value)}
                >
                  <MenuItem value="lowest-cost">Lowest Cost</MenuItem>
                  <MenuItem value="highest-throughput">Highest Throughput</MenuItem>
                </Select>
              </FormControl>
              {routingStrategy !== "" && (
                <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => setRoutingStrategy("")}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
              <FormControl
                fullWidth
                disabled={qaLlmDisabled}
              >
                <InputLabel>QA LLM Model</InputLabel>
                <Select
                  size="small"
                  value={qaLlmModel || inheritedQaLlmModel || ""}
                  label="QA LLM Model"
                  onChange={(e) => setQaLlmModel(e.target.value)}
                >
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
              {qaLlmModel !== "" && (
                <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => setQaLlmModel("")}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, minWidth: 0 }}>
              <FormControl
                fullWidth
                disabled={qaVlmDisabled}
              >
                <InputLabel>QA VLM Model</InputLabel>
                <Select
                  size="small"
                  value={qaVlmModel || inheritedQaVlmModel || ""}
                  label="QA VLM Model"
                  onChange={(e) => setQaVlmModel(e.target.value)}
                >
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
              {qaVlmModel !== "" && (
                <IconButton size="small" sx={{ mt: 0.5 }} onClick={() => setQaVlmModel("")}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
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
