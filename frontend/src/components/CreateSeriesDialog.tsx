import React, { useState, useEffect } from "react";
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
import type { User, Series, SystemSettingsDto } from "../types";
import { safeFetch } from "../utils";
import { useToast } from "./ToastContext";
import ModelOverridesAccordion, {
  type ModelOverridesValue,
} from "./ModelOverridesAccordion";

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
  const [useFallbackModels, setUseFallbackModels] = useState<boolean | null>(
    editingSeries?.useFallbackModels ?? null,
  );

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const [prevOpen, setPrevOpen] = useState(false);
  const [prevEditingSeries, setPrevEditingSeries] = useState<Series | null>(
    null,
  );

  if (open && (!prevOpen || editingSeries !== prevEditingSeries)) {
    setPrevOpen(true);
    setPrevEditingSeries(editingSeries);
    if (editingSeries) {
      setTitle(editingSeries.title || "");
      setLang(editingSeries.originalLanguage || "ja");
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
      setRoutingStrategy(editingSeries.routingStrategy || "");
      setUseFallbackModels(editingSeries.useFallbackModels ?? null);
    } else {
      setTitle("");
      setLang("ja");
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
      setRoutingStrategy("");
      setUseFallbackModels(null);
    }
  } else if (!open && prevOpen) {
    setPrevOpen(false);
  }

  useEffect(() => {
    if (open && !settings) {
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((res) => res.json())
        .then((d) => {
          setSettings(d);
        })
        .catch(() => {});
    }
  }, [open, settings, editingSeries, user.token]);

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
          useFallbackModels: useFallbackModels,
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

        <ModelOverridesAccordion
          expanded={showOverrides}
          onToggle={() => setShowOverrides(!showOverrides)}
          value={overridesValue}
          onChange={handleOverrideChange}
          settings={settings}
          inherited={{
            ocrProvider: settings?.ocrProvider,
            ocrModel: settings?.ocrModel,
            tlProvider: settings?.tlProvider,
            tlModel: settings?.tlModel,
            qaProvider: settings?.qaProvider,
            qaMode: settings?.qaMode,
            qaLlmModel: settings?.qaLlmModel,
            qaVlmModel: settings?.qaVlmModel,
            routingStrategy: settings?.routingStrategy,
            useFallbackModels: settings?.useFallbackModels,
          }}
        />
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
