import React, { useState, useEffect, useRef } from "react";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import TextField from "@mui/material/TextField";
import type { User, Chapter, Series, SystemSettingsDto } from "../types";
import { safeFetch } from "../utils";
import { fetchHighestChapterNumber } from "./chapterNumbering";
import ModelOverridesAccordion, {
  type ModelOverridesValue,
} from "./ModelOverridesAccordion";

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
  // A max over `chapters` is a max over the *loaded page*, so this is only a starting guess;
  // the effect below replaces it with the series-wide maximum from the server.
  const defaultNum = editingChapter
    ? editingChapter.chapterNumber
    : chapters.reduce((m, c) => Math.max(m, c.chapterNumber), 0) + 1;
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
  const [routingStrategy, setRoutingStrategy] = useState(
    editingChapter?.routingStrategy || "",
  );
  const [useFallbackModels, setUseFallbackModels] = useState<boolean | null>(
    editingChapter?.useFallbackModels ?? null,
  );

  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [saving, setSaving] = useState(false);

  // Set the moment the user types in the Chapter Number field, cleared whenever the dialog is
  // (re)opened. `cancelled` below only fires when the effect tears down — closing the dialog or
  // changing series — never on typing, so on its own it does not stop a slow response landing on
  // top of a number the user deliberately chose. Same defect as AUDIT-F18's in ImportChapterDialog.
  const numberTouchedRef = useRef(false);
  const [prevOpen, setPrevOpen] = useState(false);
  const [prevEditingChapter, setPrevEditingChapter] = useState<Chapter | null>(
    null,
  );

  if (open && (!prevOpen || editingChapter !== prevEditingChapter)) {
    setPrevOpen(true);
    setPrevEditingChapter(editingChapter);
    if (editingChapter) {
      setNumber(editingChapter.chapterNumber);
      setTitle(editingChapter.title || "");
      setUseContextMemory(editingChapter.useContextMemory ?? true);
      setOcrProvider(editingChapter.ocrProvider || "");
      setOcrModel(editingChapter.ocrModel || "");
      setTlProvider(editingChapter.tlProvider || "");
      setTlModel(editingChapter.tlModel || "");
      setQaProvider(editingChapter.qaProvider || "");
      setQaLlmModel(editingChapter.qaLlmModel || "");
      setQaVlmModel(editingChapter.qaVlmModel || "");
      setQaMode(editingChapter.qaMode || "");
      setRoutingStrategy(editingChapter.routingStrategy || "");
      setUseFallbackModels(editingChapter.useFallbackModels ?? null);
    } else {
      setNumber(defaultNum);
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
      setRoutingStrategy("");
      setUseFallbackModels(null);
    }
  } else if (!open && prevOpen) {
    setPrevOpen(false);
  }

  // Not in the render-phase reset block above: that runs during render, and a ref must not be
  // written there. Opening the dialog is the event that clears it either way.
  useEffect(() => {
    if (open) {
      numberTouchedRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (open && !settings) {
      safeFetch("/api/settings", {
        headers: { Authorization: `Bearer ${user.token}` },
      })
        .then((r) => r.json())
        .then((d) => {
          setSettings(d);
        })
        .catch(() => {});
    }
  }, [
    open,
    settings,
    editingChapter,
    selectedSeries?.useFallbackModels,
    user.token,
  ]);

  // Ask the server for the highest chapter number when creating.
  //
  // The `chapters` prop is one page of 15, so on a longer series its maximum is not the
  // series maximum and the suggested number collides with one that already exists. Only
  // for creation — an edit keeps the number the chapter already has.
  useEffect(() => {
    if (!open || editingChapter || !selectedSeries) return;
    let cancelled = false;

    void fetchHighestChapterNumber(selectedSeries.id, user.token)
      .then((highest) => {
        // A stale response must not overwrite a number the user has since typed.
        if (cancelled || numberTouchedRef.current || highest === null) return;
        setNumber(highest + 1);
      })
      .catch(() => {
        // Leave the local guess in place; the server rejects a duplicate anyway.
      });

    return () => {
      cancelled = true;
    };
  }, [open, editingChapter, selectedSeries, user.token]);

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
          useFallbackModels: useFallbackModels,
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
          onChange={(e) => {
            numberTouchedRef.current = true;
            setNumber(Number(e.target.value));
          }}
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
        <ModelOverridesAccordion
          expanded={showOverrides}
          onToggle={() => setShowOverrides(!showOverrides)}
          value={overridesValue}
          onChange={handleOverrideChange}
          settings={settings}
          inherited={{
            ocrProvider: selectedSeries?.ocrProvider || settings?.ocrProvider,
            ocrModel: selectedSeries?.ocrModel || settings?.ocrModel,
            tlProvider: selectedSeries?.tlProvider || settings?.tlProvider,
            tlModel: selectedSeries?.tlModel || settings?.tlModel,
            qaProvider: selectedSeries?.qaProvider || settings?.qaProvider,
            qaMode: selectedSeries?.qaMode || settings?.qaMode,
            qaLlmModel: selectedSeries?.qaLlmModel || settings?.qaLlmModel,
            qaVlmModel: selectedSeries?.qaVlmModel || settings?.qaVlmModel,
            routingStrategy:
              selectedSeries?.routingStrategy || settings?.routingStrategy,
            useFallbackModels:
              selectedSeries?.useFallbackModels ?? settings?.useFallbackModels,
          }}
        />
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
