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

interface EditSeriesDialogProps {
  open: boolean;
  series: Series;
  user: User;
  onClose: () => void;
  onSuccess: (data: Series) => void;
}

const LANG_OPTS = ["ja", "zh-TW", "zh-CN", "ko", "en"];
const TARGET_OPTS = ["en", "ja", "zh-TW", "zh-CN", "ko"];
const DIR_OPTS = [
  { value: "rtl", label: "Right to Left (Manga)" },
  { value: "ltr", label: "Left to Right (Comics)" },
  { value: "ttb", label: "Top to Bottom (Webtoons)" },
];

export const EditSeriesDialog: React.FC<EditSeriesDialogProps> = ({
  open,
  series,
  user,
  onClose,
  onSuccess,
}) => {
  const { showToast } = useToast();
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [title, setTitle] = useState(series.title);
  const [lang, setLang] = useState(
    series.sourceLanguage || series.originalLanguage || "ja",
  );
  const [targetLang, setTargetLang] = useState(series.targetLanguage || "en");
  const [direction, setDirection] = useState(series.readingDirection);
  const [saving, setSaving] = useState(false);

  const [ocrProvider, setOcrProvider] = useState(series.ocrProvider || "");
  const [ocrModel, setOcrModel] = useState(series.ocrModel || "");
  const [tlProvider, setTlProvider] = useState(series.tlProvider || "");
  const [tlModel, setTlModel] = useState(series.tlModel || "");
  const [qaProvider, setQaProvider] = useState(series.qaProvider || "");
  const [qaLlmModel, setQaLlmModel] = useState(series.qaLlmModel || "");
  const [qaVlmModel, setQaVlmModel] = useState(series.qaVlmModel || "");
  const [qaMode, setQaMode] = useState(series.qaMode || "");
  const [routingStrategy, setRoutingStrategy] = useState(
    series.routingStrategy || "",
  );
  const [useFallbackModels, setUseFallbackModels] = useState<boolean | null>(
    series.useFallbackModels ?? null,
  );
  const [overridesOpen, setOverridesOpen] = useState(false);

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
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setSettings(d))
        .catch(console.error);
    }
  }, [open, user.token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await safeFetch(`/api/series/${series.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.token}`,
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
      if (res.ok) {
        const data: Series = await res.json();
        onSuccess(data);
        onClose();
      } else {
        showToast("Failed to update series", "error");
      }
    } catch {
      showToast("Error updating series", "error");
    } finally {
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
      <DialogTitle>Edit Series</DialogTitle>
      <form onSubmit={handleSubmit}>
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
            expanded={overridesOpen}
            onToggle={() => setOverridesOpen(!overridesOpen)}
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
            ocrModelLabel="OCR Model"
            tlModelLabel="TL Model"
            localOcrModelLabel="Local"
            useResolvedQaModeForDisable={false}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="contained"
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default EditSeriesDialog;
