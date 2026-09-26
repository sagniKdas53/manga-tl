import React, { useEffect, useRef, useState } from "react";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import Grid from "@mui/material/Grid";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { safeFetch } from "../utils";
import { CLEANUP_MODE_OPTIONS } from "../utils/cleanupModes";
import {
  CUSTOM_MODEL_VALUE,
  saveCustomModels,
  type ModelCapability,
} from "../utils/customModels";
import type { CustomModel, SystemSettingsDto } from "../types";
import CustomModelDialog, {
  type CustomModelRequest,
} from "./CustomModelDialog";
import { renderModelOptions } from "./modelOptions";
import { useToast } from "./ToastContext";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  token?: string;
}

const QA_MODES = ["auto", "llm", "vlm", "hybrid", "none"];

const PROVIDER_REFETCH_DELAY_MS = 2000;
const MAX_PROVIDER_REFETCH_ATTEMPTS = 5;

/** A provider is unavailable when unset or not among the active providers. */
const isProviderUnavailable = (
  value: string | undefined,
  activeProviders: string[],
) => !value || (activeProviders.length > 0 && !activeProviders.includes(value));

const isAnyProviderUnavailable = (data: SystemSettingsDto) => {
  const activeProviders = data.activeProviders || [];
  return (
    isProviderUnavailable(data.tlProvider, activeProviders) ||
    isProviderUnavailable(data.qaProvider, activeProviders)
  );
};

const isCapabilityMissing = (
  providerMap: SystemSettingsDto["providerModelsMap"],
  provider: string,
  capability: "ocr" | "tl" | "qaLLM" | "qaVLM",
  legacyList: string[] | undefined,
) => {
  if (providerMap) {
    const models = providerMap[provider]?.[capability];
    return !models || models.length === 0;
  }
  return !legacyList || legacyList.length === 0;
};

/**
 * SettingsModal component allows users to configure global system defaults.
 *
 * Model Resolution Logic:
 * The frontend receives provider capabilities via `providerModelsMap`.
 *
 * - If a provider has a capability array (even if empty `[]`), it is considered the absolute source of truth.
 *   For example, if `neurometric` has `qaVLM: []`, it means VLM is definitively not supported by Neurometric.
 * - If the backend does not provide `providerModelsMap` (legacy) or completely omits a capability array,
 *   the UI will safely fall back to legacy global configuration lists (e.g., `qaVlmModelList`).
 *
 * This ensures that modern backend configurations take precedence and capabilities missing from
 * a provider are cleanly greyed out in the interface as "Capability Missing".
 */
const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  token,
}) => {
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [customRequest, setCustomRequest] = useState<CustomModelRequest | null>(
    null,
  );
  const { showToast } = useToast();

  const providers = settings?.activeProviders || [];
  const ocrProviders = settings?.activeOcrProviders || [];

  const tlProviderUnavailable = isProviderUnavailable(
    settings?.tlProvider,
    providers,
  );
  const qaProviderUnavailable = isProviderUnavailable(
    settings?.qaProvider,
    providers,
  );

  const refetchAttemptsRef = useRef(0);
  const refetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    if (!isOpen) return;
    refetchAttemptsRef.current = 0;

    // Silently refetch settings in the background while the backend has not
    // published usable providers yet. Merges only the provider-related fields
    // so in-progress user edits are never clobbered.
    const scheduleRefetch = () => {
      if (refetchAttemptsRef.current >= MAX_PROVIDER_REFETCH_ATTEMPTS) return;
      refetchAttemptsRef.current += 1;
      refetchTimeoutRef.current = setTimeout(
        refetchSettings,
        PROVIDER_REFETCH_DELAY_MS,
      );
    };

    const refetchSettings = () => {
      if (savingRef.current) return;
      safeFetch("/api/settings", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: SystemSettingsDto | null) => {
          if (data) {
            setSettings((prev) =>
              prev
                ? {
                    ...prev,
                    tlProvider: data.tlProvider ?? prev.tlProvider,
                    qaProvider: data.qaProvider ?? prev.qaProvider,
                    activeProviders:
                      data.activeProviders ?? prev.activeProviders,
                    providerModelsMap:
                      data.providerModelsMap ?? prev.providerModelsMap,
                  }
                : prev,
            );
          }
          if (!data || isAnyProviderUnavailable(data)) scheduleRefetch();
        })
        .catch(() => {
          scheduleRefetch();
        });
    };

    safeFetch("/api/settings", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch settings");
        return res.json();
      })
      .then((data) => {
        setSettings(data);
        setLoading(false);
        if (isAnyProviderUnavailable(data)) scheduleRefetch();
      })
      .catch((err) => {
        console.error(err);
        showToast("Failed to load settings", "error");
        setLoading(false);
      });

    return () => {
      if (refetchTimeoutRef.current) {
        clearTimeout(refetchTimeoutRef.current);
        refetchTimeoutRef.current = null;
      }
    };
  }, [isOpen, token, showToast]);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const res = await safeFetch("/api/settings", {
        method: "PUT",
        headers,
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error("Failed to save settings");
      const updated = await res.json();
      setSettings(updated);
      showToast("Settings saved successfully", "success");
      onClose();
    } catch (err) {
      console.error(err);
      showToast("Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (
    field: keyof SystemSettingsDto,
    value: SystemSettingsDto[keyof SystemSettingsDto],
  ) => {
    setSettings((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  /** A model Select's change: a model, or "Custom model ID…", which asks for one first. */
  const pickModel = (
    field: "ocrModel" | "tlModel" | "qaLlmModel" | "qaVlmModel",
    provider: string,
    task: ModelCapability,
    picked: string,
  ) => {
    if (picked === CUSTOM_MODEL_VALUE) {
      setCustomRequest({
        provider,
        task,
        apply: (id) => handleChange(field, id),
      });
    } else {
      handleChange(field, picked);
    }
  };

  /** Custom IDs are saved on their own endpoint at once; the model lists follow locally. */
  const applyCustomModels = (models: CustomModel[]) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const map = { ...(prev.providerModelsMap ?? {}) };
      for (const [provider, tasks] of Object.entries(map)) {
        const next = { ...tasks };
        for (const [task, list] of Object.entries(next)) {
          next[task] = list.filter((m) => !m.custom);
        }
        map[provider] = next;
      }
      for (const m of models) {
        const tasks = map[m.provider];
        if (!tasks) continue;
        const list = tasks[m.task] ?? [];
        if (!list.some((entry) => entry.id === m.id)) {
          tasks[m.task] = [...list, { id: m.id, name: m.id, custom: true }];
        }
      }
      return { ...prev, customModels: models, providerModelsMap: map };
    });
  };

  const removeCustomModel = async (model: CustomModel) => {
    try {
      const remaining = (settings?.customModels ?? []).filter(
        (m) =>
          !(
            m.provider === model.provider &&
            m.task === model.task &&
            m.id === model.id
          ),
      );
      applyCustomModels(await saveCustomModels(remaining, token));
    } catch (err) {
      console.error(err);
      showToast("Could not remove the custom model", "error");
    }
  };

  // -------------------------------------------------------------------------------------
  // MODEL INHERITANCE LOGIC & CAPABILITY CHECKING:
  // - This modal manages the GLOBAL state. These settings act as the ultimate fallback
  //   for Series and Chapter overrides.
  // - Missing capabilities (e.g. `isCapabilityMissing` for `qaVLM`) will disable the
  //   relevant dropdown and force the value to "N/A (Capability Missing)".
  // -------------------------------------------------------------------------------------
  const getFirstValidModel = (
    provider: string,
    capability: "ocr" | "tl" | "qaLLM" | "qaVLM",
    legacyList: string[] | undefined,
  ) => {
    if (settings?.providerModelsMap) {
      const models = settings.providerModelsMap[provider]?.[capability];
      if (models && models.length > 0) return models[0].id;
      return null;
    }
    if (legacyList && legacyList.length > 0) return legacyList[0];
    return null;
  };

  const handleProviderChange = (
    field: "ocrProvider" | "tlProvider" | "qaProvider",
    value: string,
  ) => {
    handleChange(field, value);

    if (field === "ocrProvider") {
      // "local" now publishes real models (PP-OCRv6 / PP-OCRv5), so it picks a first valid model
      // like any other provider instead of blanking the field.
      const first = getFirstValidModel(value, "ocr", settings?.ocrVlmModelList);
      handleChange("ocrModel", first || "");
    } else if (field === "tlProvider") {
      const first = getFirstValidModel(value, "tl", settings?.tlLlmModelList);
      handleChange("tlModel", first || "");
    } else if (field === "qaProvider") {
      const firstLlm = getFirstValidModel(
        value,
        "qaLLM",
        settings?.qaLlmModelList,
      );
      handleChange("qaLlmModel", firstLlm || "");
      const firstVlm = getFirstValidModel(
        value,
        "qaVLM",
        settings?.qaVlmModelList,
      );
      handleChange("qaVlmModel", firstVlm || "");
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby="settings-dialog-title"
    >
      <DialogTitle id="settings-dialog-title">System Settings</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Typography
            align="center"
            sx={{ py: 4 }}
          >
            <CircularProgress
              size={28}
              sx={{ mb: 1 }}
            />
            <br />
            Loading settings...
          </Typography>
        ) : !settings ? (
          <Typography
            align="center"
            color="error"
            sx={{ py: 4 }}
          >
            Failed to load settings.
          </Typography>
        ) : (
          <Grid
            container
            spacing={1.5}
          >
            <Grid
              size={12}
              sx={{ my: 0, py: 0 }}
            >
              <Typography
                variant="overline"
                sx={{
                  color: "text.disabled",
                  display: "block",
                  m: 0,
                  p: 0,
                }}
              >
                OCR
              </Typography>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Global OCR Provider</InputLabel>
                <Select
                  value={settings.ocrProvider || ""}
                  label="Global OCR Provider"
                  onChange={(e) => {
                    const newProv = e.target.value;
                    const ocrModels =
                      settings.providerModelsMap?.[newProv]?.ocr || [];
                    const defaultModel =
                      ocrModels.length > 0
                        ? ocrModels[0].id
                        : settings.ocrModel || "";
                    setSettings((prev) =>
                      prev
                        ? {
                            ...prev,
                            ocrProvider: newProv,
                            ocrModel: defaultModel,
                          }
                        : null,
                    );
                  }}
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
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              {(() => {
                const isLocalOcr = settings.ocrProvider === "local";
                const localOcrModels =
                  settings.providerModelsMap?.["local"]?.ocr || [];
                // Only fall back to the single legacy entry when the worker has not published its
                // catalog yet — otherwise local behaves like any other provider.
                const localUnpublished =
                  isLocalOcr && localOcrModels.length === 0;
                const capabilityMissing =
                  !isLocalOcr &&
                  isCapabilityMissing(
                    settings.providerModelsMap,
                    settings.ocrProvider,
                    "ocr",
                    settings.ocrVlmModelList,
                  );
                const label = isLocalOcr
                  ? "Global Local OCR Model"
                  : "Global OCR VLM Model";
                return (
                  <FormControl
                    fullWidth
                    size="small"
                    disabled={localUnpublished || capabilityMissing}
                  >
                    <InputLabel>{label}</InputLabel>
                    <Select
                      value={
                        localUnpublished
                          ? settings.localOcrModel || "local"
                          : capabilityMissing
                            ? "N/A"
                            : settings.ocrModel || settings.localOcrModel || ""
                      }
                      label={label}
                      onChange={(e) =>
                        pickModel(
                          "ocrModel",
                          settings.ocrProvider,
                          "ocr",
                          e.target.value,
                        )
                      }
                    >
                      {localUnpublished ? (
                        <MenuItem value={settings.localOcrModel || "local"}>
                          {settings.localOcrModel || "Local Worker Model"}
                        </MenuItem>
                      ) : (
                        renderModelOptions(
                          settings.providerModelsMap,
                          settings.ocrProvider,
                          "ocr",
                          settings.ocrVlmModelList,
                          settings.ocrModel,
                        )
                      )}
                    </Select>
                  </FormControl>
                );
              })()}
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                size="small"
                type="number"
                label="OCR Grouping Threshold"
                helperText="Join OCR fragments closer than this many characters; higher joins more. Applies on redo OCR"
                value={settings.ocrMergeThreshold ?? 0.35}
                onChange={(e) => {
                  const parsed = parseFloat(e.target.value);
                  if (Number.isFinite(parsed)) {
                    handleChange(
                      "ocrMergeThreshold",
                      Math.min(3, Math.max(0.05, parsed)),
                    );
                  }
                }}
                slotProps={{ htmlInput: { min: 0.05, max: 3, step: 0.05 } }}
              />
            </Grid>

            <Grid size={12}>
              <Typography
                variant="overline"
                sx={{
                  color: "text.disabled",
                  display: "block",
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1,
                }}
              >
                Translation
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Global Translation Provider</InputLabel>
                <Select
                  value={tlProviderUnavailable ? "" : settings.tlProvider}
                  label="Global Translation Provider"
                  onChange={(e) =>
                    handleProviderChange("tlProvider", e.target.value)
                  }
                >
                  {tlProviderUnavailable && (
                    <MenuItem
                      value=""
                      disabled
                    >
                      Not Available
                    </MenuItem>
                  )}
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
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Global Translation LLM Model</InputLabel>
                <Select
                  value={
                    isCapabilityMissing(
                      settings.providerModelsMap,
                      settings.tlProvider,
                      "tl",
                      settings.tlLlmModelList,
                    )
                      ? "N/A"
                      : settings.tlModel || ""
                  }
                  label="Global Translation LLM Model"
                  onChange={(e) =>
                    pickModel(
                      "tlModel",
                      settings.tlProvider,
                      "tl",
                      e.target.value,
                    )
                  }
                >
                  {renderModelOptions(
                    settings.providerModelsMap,
                    settings.tlProvider,
                    "tl",
                    settings.tlLlmModelList,
                    settings.tlModel,
                  )}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={12}>
              <Typography
                variant="overline"
                sx={{
                  color: "text.disabled",
                  display: "block",
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1,
                }}
              >
                Quality Assurance
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Global QA Provider</InputLabel>
                <Select
                  value={qaProviderUnavailable ? "" : settings.qaProvider}
                  label="Global QA Provider"
                  onChange={(e) =>
                    handleProviderChange("qaProvider", e.target.value)
                  }
                >
                  {qaProviderUnavailable && (
                    <MenuItem
                      value=""
                      disabled
                    >
                      Not Available
                    </MenuItem>
                  )}
                  {providers.map((p) => (
                    <MenuItem
                      key={p}
                      value={p}
                    >
                      {p}
                    </MenuItem>
                  ))}
                </Select>
                {(tlProviderUnavailable || qaProviderUnavailable) && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    Providers not available yet — retrying in the background…
                  </Typography>
                )}
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Global QA Mode</InputLabel>
                <Select
                  value={settings.qaMode || ""}
                  label="Global QA Mode"
                  onChange={(e) => handleChange("qaMode", e.target.value)}
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
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
                disabled={
                  settings.qaMode === "vlm" || settings.qaMode === "none"
                }
              >
                <InputLabel>Global QA LLM Model</InputLabel>
                <Select
                  value={
                    isCapabilityMissing(
                      settings.providerModelsMap,
                      settings.qaProvider,
                      "qaLLM",
                      settings.qaLlmModelList,
                    )
                      ? "N/A"
                      : settings.qaLlmModel || ""
                  }
                  label="Global QA LLM Model"
                  onChange={(e) =>
                    pickModel(
                      "qaLlmModel",
                      settings.qaProvider,
                      "qaLLM",
                      e.target.value,
                    )
                  }
                >
                  {renderModelOptions(
                    settings.providerModelsMap,
                    settings.qaProvider,
                    "qaLLM",
                    settings.qaLlmModelList,
                    settings.qaLlmModel,
                  )}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
                disabled={
                  settings.qaMode === "llm" || settings.qaMode === "none"
                }
              >
                <InputLabel>Global QA VLM Model</InputLabel>
                <Select
                  value={
                    isCapabilityMissing(
                      settings.providerModelsMap,
                      settings.qaProvider,
                      "qaVLM",
                      settings.qaVlmModelList,
                    )
                      ? "N/A"
                      : settings.qaVlmModel || ""
                  }
                  label="Global QA VLM Model"
                  onChange={(e) =>
                    pickModel(
                      "qaVlmModel",
                      settings.qaProvider,
                      "qaVLM",
                      e.target.value,
                    )
                  }
                >
                  {renderModelOptions(
                    settings.providerModelsMap,
                    settings.qaProvider,
                    "qaVLM",
                    settings.qaVlmModelList,
                    settings.qaVlmModel,
                  )}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={12}>
              <Typography
                variant="overline"
                sx={{
                  color: "text.disabled",
                  display: "block",
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1,
                }}
              >
                Cleanup &amp; Text Fit
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Cleanup Mode</InputLabel>
                <Select
                  value={settings.cleanupMode || "auto"}
                  label="Cleanup Mode"
                  onChange={(e) => handleChange("cleanupMode", e.target.value)}
                >
                  {CLEANUP_MODE_OPTIONS.map((option) => (
                    <MenuItem
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
                <FormHelperText>
                  Applies to pages cleaned from now on; redo OCR to re-clean a
                  page
                </FormHelperText>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                size="small"
                type="number"
                label="Text Safety Margin (%)"
                helperText="Share of the padded box text may use; 100 = all of it"
                value={settings.textBoxSafetyPercent ?? 100}
                onChange={(e) =>
                  handleChange(
                    "textBoxSafetyPercent",
                    Math.min(100, Math.max(1, parseInt(e.target.value) || 1)),
                  )
                }
                slotProps={{ htmlInput: { min: 1, max: 100, step: 1 } }}
              />
            </Grid>

            {/* AUDIT-F16: the space around text inside its box, per edge. One rule in three
                parts -- a share of the box, lifted to a floor, stopped at a cap -- so the three
                fields sit on one row. */}
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                size="small"
                type="number"
                label="Text Box Padding (%)"
                helperText="Of each box's shorter side; 0 = none"
                value={settings.textBoxPaddingPercent ?? 4}
                onChange={(e) =>
                  handleChange(
                    "textBoxPaddingPercent",
                    Math.min(50, Math.max(0, parseInt(e.target.value) || 0)),
                  )
                }
                slotProps={{ htmlInput: { min: 0, max: 50, step: 1 } }}
              />
            </Grid>

            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                size="small"
                type="number"
                label="Min Padding (px)"
                helperText="Floor for small boxes; 0 = none"
                value={settings.textBoxPaddingMinPx ?? 0}
                onChange={(e) =>
                  handleChange(
                    "textBoxPaddingMinPx",
                    Math.min(64, Math.max(0, parseInt(e.target.value) || 0)),
                  )
                }
                slotProps={{ htmlInput: { min: 0, max: 64, step: 1 } }}
              />
            </Grid>

            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                size="small"
                type="number"
                label="Max Padding (px)"
                helperText="Cap for large boxes; 0 = no padding"
                value={settings.textBoxPaddingMaxPx ?? 4}
                onChange={(e) =>
                  handleChange(
                    "textBoxPaddingMaxPx",
                    Math.min(64, Math.max(0, parseInt(e.target.value) || 0)),
                  )
                }
                slotProps={{ htmlInput: { min: 0, max: 64, step: 1 } }}
              />
            </Grid>

            <Grid size={12}>
              <Typography
                variant="overline"
                sx={{
                  color: "text.disabled",
                  display: "block",
                  borderTop: 1,
                  borderColor: "divider",
                  pt: 1,
                }}
              >
                Advanced Routing (OpenRouter)
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
                disabled={
                  ![
                    settings.ocrProvider,
                    settings.tlProvider,
                    settings.qaProvider,
                  ].includes("openrouter")
                }
              >
                <InputLabel>OpenRouter Routing Strategy</InputLabel>
                <Select
                  value={settings.routingStrategy || "lowest-cost"}
                  label="OpenRouter Routing Strategy"
                  onChange={(e) =>
                    handleChange("routingStrategy", e.target.value)
                  }
                >
                  <MenuItem value="lowest-cost">Lowest Cost</MenuItem>
                  <MenuItem value="highest-throughput">
                    Highest Throughput
                  </MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl
                fullWidth
                size="small"
              >
                <InputLabel>Use Fallback Models</InputLabel>
                <Select
                  value={
                    settings.useFallbackModels !== false ? "true" : "false"
                  }
                  label="Use Fallback Models"
                  onChange={(e) =>
                    handleChange("useFallbackModels", e.target.value === "true")
                  }
                >
                  <MenuItem value="true">Enabled</MenuItem>
                  <MenuItem value="false">Disabled</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid size={12}>
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", display: "block", mb: 0.5 }}
              >
                Custom model IDs — add one with “Custom model ID…” in any model
                list
              </Typography>
              {(settings.customModels ?? []).length === 0 ? (
                <Typography
                  variant="caption"
                  sx={{ color: "text.disabled" }}
                >
                  None
                </Typography>
              ) : (
                (settings.customModels ?? []).map((m) => (
                  <Chip
                    key={`${m.provider}/${m.task}/${m.id}`}
                    size="small"
                    label={`${m.id} · ${m.provider} ${m.task}`}
                    onDelete={() => void removeCustomModel(m)}
                    sx={{ mr: 0.5, mb: 0.5 }}
                  />
                ))
              )}
            </Grid>
          </Grid>
        )}
      </DialogContent>
      <CustomModelDialog
        request={customRequest}
        onClose={() => setCustomRequest(null)}
        token={token}
        onRegistered={applyCustomModels}
      />
      <DialogActions>
        <Button
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={saving || loading}
        >
          {saving ? "Saving..." : "Save Settings"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SettingsModal;
