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
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { User, Series } from "../types";
import { safeFetch } from "../utils";
import { useToast } from "./ToastContext";

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
  routingStrategy?: string;
}

interface CreateSeriesDialogProps {
  open: boolean;
  editingSeries: Series | null;
  user: User;
  onClose: () => void;
  onSuccess: (series: Series) => void;
}

const LANG_OPTS = ["ja", "zh-TW", "zh-CN", "ko", "en"];
const TARGET_OPTS = ["en", "ja", "zh-TW", "zh-CN", "ko"];
const DIR_OPTS = [
  { value: "rtl", label: "Right to Left — Manga" },
  { value: "ltr", label: "Left to Right — Comics" },
  { value: "ttb", label: "Top to Bottom — Webtoons" },
];
const QA_MODES = ["auto", "llm", "vlm", "hybrid", "none"];

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

const CreateSeriesDialog: React.FC<CreateSeriesDialogProps> = ({
  open,
  editingSeries,
  user,
  onClose,
  onSuccess,
}) => {
  const [title, setTitle] = useState(
    editingSeries ? editingSeries.title || "" : "",
  );
  const [lang, setLang] = useState(editingSeries?.originalLanguage || "ja");
  const [targetLang, setTargetLang] = useState(
    editingSeries?.targetLanguage || "en",
  );
  const [direction, setDirection] = useState(
    editingSeries?.readingDirection || "rtl",
  );
  const [showOverrides, setShowOverrides] = useState(false);

  const [ocrProvider, setOcrProvider] = useState(
    editingSeries?.ocrProvider || "",
  );
  const [ocrModel, setOcrModel] = useState(editingSeries?.ocrModel || "");
  const [tlProvider, setTlProvider] = useState(editingSeries?.tlProvider || "");
  const [tlModel, setTlModel] = useState(editingSeries?.tlModel || "");
  const [qaProvider, setQaProvider] = useState(editingSeries?.qaProvider || "");
  const [qaLlmModel, setQaLlmModel] = useState(editingSeries?.qaLlmModel || "");
  const [qaVlmModel, setQaVlmModel] = useState(editingSeries?.qaVlmModel || "");
  const [qaMode, setQaMode] = useState(editingSeries?.qaMode || "");
  const [routingStrategy, setRoutingStrategy] = useState(
    editingSeries?.routingStrategy || "",
  );

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (open && !settings) {
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => res.json())
        .then((d) => setSettings(d))
        .catch(() => {});
    }
  }, [open, settings, user.token]);

  const providers = settings?.activeProviders || DEFAULT_PROVIDERS;
  const ocrProviders = settings?.activeOcrProviders || DEFAULT_OCR_PROVIDERS;

  const inheritedOcrProvider = settings?.ocrProvider;
  const inheritedOcrModel = settings?.ocrModel;
  const inheritedTlProvider = settings?.tlProvider;
  const inheritedTlModel = settings?.tlModel;
  const inheritedQaProvider = settings?.qaProvider;
  const inheritedQaMode = settings?.qaMode;
  const inheritedQaLlmModel = settings?.qaLlmModel;
  const inheritedQaVlmModel = settings?.qaVlmModel;
  const inheritedRoutingStrategy = settings?.routingStrategy || "lowest-cost";

  const overrideFields = [
    ocrProvider, ocrModel, tlProvider, tlModel,
    qaProvider, qaMode, qaLlmModel, qaVlmModel, routingStrategy,
  ];
  const overriddenCount = overrideFields.filter((v) => v !== "").length;
  const inheritedCount = overrideFields.length - overriddenCount;

  const ocrDisabled =
    ocrProvider === "local" ||
    (ocrProvider === "" && settings?.ocrProvider === "local");
  const qaLlmDisabled =
    (qaMode || settings?.qaMode) === "vlm" ||
    (qaMode || settings?.qaMode) === "none";
  const qaVlmDisabled =
    (qaMode || settings?.qaMode) === "llm" ||
    (qaMode || settings?.qaMode) === "none";

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const url = editingSeries
        ? `/api/series/${editingSeries.id}`
        : "/api/series";
      const res = await safeFetch(url, {
        method: editingSeries ? "PUT" : "POST",
        headers: {
          Authorization: `Bearer ${user.token}`,
          "Content-Type": "application/json",
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
          routingStrategy: routingStrategy || null,
        }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      onSuccess(data);
      onClose();
    } catch {
      showToast("Failed to save series", "error");
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
        {editingSeries ? "Edit Series" : "Create Series"}
      </DialogTitle>
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
          disabled={!title.trim() || saving}
        >
          {saving
            ? "Saving..."
            : editingSeries
              ? "Update Series"
              : "Create Series"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default CreateSeriesDialog;
