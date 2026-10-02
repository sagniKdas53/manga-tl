import React, { useState } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { CustomModel } from "../types";
import { registerCustomModel } from "../utils/customModels";

const TASK_LABELS: Record<string, string> = {
  ocr: "OCR",
  tl: "translation",
  qaLLM: "QA (text)",
  qaVLM: "QA (vision)",
};

/** What a model Select asked for: a custom ID for this provider and task, applied on success. */
export interface CustomModelRequest {
  provider: string;
  task: string;
  apply: (id: string) => void;
}

interface CustomModelDialogProps {
  request: CustomModelRequest | null;
  onClose: () => void;
  token?: string;
  onRegistered?: (models: CustomModel[]) => void;
}

/**
 * Type a model ID the catalog does not list (a stealth model, say) and use it straight away. The
 * ID is registered for its provider and task only, so the pipeline accepts it; it can be removed
 * again under System Settings → Advanced Routing.
 */
const CustomModelDialog: React.FC<CustomModelDialogProps> = ({
  request,
  onClose,
  token,
  onRegistered,
}) => {
  const [id, setId] = useState("");
  const [saving, setSaving] = useState(false);
  // Shown inline rather than as a toast: the dialog is used inside dialogs rendered without a
  // toast provider (the override accordion's tests, for one).
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setId("");
    setError(null);
    onClose();
  };

  const submit = async () => {
    const trimmed = id.trim();
    if (!request || !trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const models = await registerCustomModel(
        { provider: request.provider, task: request.task, id: trimmed },
        token,
      );
      onRegistered?.(models);
      request.apply(trimmed);
      close();
    } catch (err) {
      console.error(err);
      setError("Could not register the model; try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={request !== null}
      onClose={close}
      fullWidth
      maxWidth="xs"
      aria-labelledby="custom-model-dialog-title"
    >
      <DialogTitle id="custom-model-dialog-title">Custom model ID</DialogTitle>
      <DialogContent>
        <Typography
          variant="body2"
          sx={{ color: "text.secondary", mb: 2 }}
        >
          For {request?.provider} {TASK_LABELS[request?.task ?? ""] ?? ""},
          exactly as the provider lists it. Its price is unknown here, and it
          must accept the same requests as the listed models.
        </Typography>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="Model ID"
          placeholder="stealth/space-bunny-alpha"
          value={id}
          error={error !== null}
          helperText={error ?? undefined}
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button
          onClick={close}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={saving || !id.trim()}
        >
          Use model
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default CustomModelDialog;
