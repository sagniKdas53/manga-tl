import React from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { modelOptionLabel } from "../modelPricing";
import type { ModelEntry, SystemSettingsDto } from "../types";

const QA_MODES = ["auto", "llm", "vlm", "hybrid", "none"];

/**
 * Editable model override values. An empty string (or null for
 * useFallbackModels) means the field is inherited, not overridden.
 */
export interface ModelOverridesValue {
  ocrProvider: string;
  ocrModel: string;
  tlProvider: string;
  tlModel: string;
  qaProvider: string;
  qaLlmModel: string;
  qaVlmModel: string;
  qaMode: string;
  routingStrategy: string;
  useFallbackModels: boolean | null;
}

/**
 * Values inherited from the parent scope (e.g. series-level overrides falling
 * back to the global settings). They are displayed when a field is not
 * overridden.
 */
export interface InheritedModelSettings {
  ocrProvider?: string;
  ocrModel?: string;
  tlProvider?: string;
  tlModel?: string;
  qaProvider?: string;
  qaLlmModel?: string;
  qaVlmModel?: string;
  qaMode?: string;
  routingStrategy?: string;
  /** Resolved inherited fallback toggle (series override ?? global setting). */
  useFallbackModels?: boolean;
}

interface ModelOverridesAccordionProps {
  value: ModelOverridesValue;
  onChange: <K extends keyof ModelOverridesValue>(
    field: K,
    fieldValue: ModelOverridesValue[K],
  ) => void;
  settings: SystemSettingsDto | null;
  inherited: InheritedModelSettings;
  expanded: boolean;
  onToggle: () => void;
  ocrModelLabel?: string;
  tlModelLabel?: string;
  localOcrModelLabel?: string;
  /**
   * When true (default), the QA LLM/VLM model dropdowns are disabled based on
   * the resolved QA mode (override || inherited). Pass false to only consider
   * the local override value.
   */
  useResolvedQaModeForDisable?: boolean;
}

const isCapabilityMissing = (
  providerMap: SystemSettingsDto["providerModelsMap"] | undefined,
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

const renderModelOptions = (
  providerMap: SystemSettingsDto["providerModelsMap"] | undefined,
  provider: string,
  capability: "ocr" | "tl" | "qaLLM" | "qaVLM",
  legacyList: string[] | undefined,
) => {
  let models: ModelEntry[] = [];
  if (providerMap) {
    models = providerMap[provider]?.[capability] || [];
  } else if (legacyList) {
    models = legacyList.map((m) => ({ id: m, name: m }));
  }

  if (models.length === 0) {
    return (
      <MenuItem
        value="N/A"
        disabled
      >
        N/A (Capability Missing)
      </MenuItem>
    );
  }

  return models.map((m) => (
    <MenuItem
      key={m.id}
      value={m.id}
    >
      {modelOptionLabel(m)}
    </MenuItem>
  ));
};

const fieldBoxSx = {
  display: "flex",
  alignItems: "flex-start",
  gap: 0.5,
  minWidth: 0,
} as const;

/**
 * Renders the Model Overrides accordion in the Edit Chapter or Series dialogs.
 *
 * -------------------------------------------------------------------------------------
 * MODEL INHERITANCE LOGIC & CAPABILITY CHECKING:
 * - This component manages the state for chapter/series overrides.
 * - Missing capabilities (e.g. `isCapabilityMissing` for `qaVLM`) will disable the
 *   relevant dropdown and force the value to "N/A (Capability Missing)".
 * - Inheritance operates strictly Global -> Series -> Chapter.
 * -------------------------------------------------------------------------------------
 *
 * The frontend receives provider capabilities via `providerModelsMap`.
 * - For a given provider (e.g. 'openai'), `providerModelsMap['openai'].qaVLM`
 *   contains the list of vision models.
 * - If the backend does not provide `providerModelsMap` (legacy) or completely omits a capability array,
 *   it falls back to checking legacy specific lists like `settings?.qaVlmModelList`.
 *
 * This ensures that modern backend configurations take precedence and capabilities missing from
 *
 * QA Mode Routing Logic:
 * - When `qaMode` is "auto", the backend intelligently routes to VLM if available.
 * - If VLM is not available for the selected provider (e.g., Neurometric), it gracefully falls back to LLM.
 * - This prevents failures and future-proofs against providers that only offer one type of model.
 */
const ModelOverridesAccordion: React.FC<ModelOverridesAccordionProps> = ({
  value,
  onChange,
  settings,
  inherited,
  expanded,
  onToggle,
  ocrModelLabel = "OCR VLM Model",
  tlModelLabel = "TL LLM Model",
  localOcrModelLabel = "Local Worker Model",
  useResolvedQaModeForDisable = true,
}) => {
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
    onChange(field, value);

    if (value === "") {
      if (field === "ocrProvider") onChange("ocrModel", "");
      if (field === "tlProvider") onChange("tlModel", "");
      if (field === "qaProvider") {
        onChange("qaLlmModel", "");
        onChange("qaVlmModel", "");
      }
      return;
    }

    if (field === "ocrProvider") {
      // "local" now publishes real models (PP-OCRv6 / PP-OCRv5), so it picks a first valid model
      // like any other provider instead of blanking the field.
      const first = getFirstValidModel(value, "ocr", settings?.ocrVlmModelList);
      onChange("ocrModel", first || "");
    } else if (field === "tlProvider") {
      const first = getFirstValidModel(value, "tl", settings?.tlLlmModelList);
      onChange("tlModel", first || "");
    } else if (field === "qaProvider") {
      const firstLlm = getFirstValidModel(
        value,
        "qaLLM",
        settings?.qaLlmModelList,
      );
      onChange("qaLlmModel", firstLlm || "");
      const firstVlm = getFirstValidModel(
        value,
        "qaVLM",
        settings?.qaVlmModelList,
      );
      onChange("qaVlmModel", firstVlm || "");
    }
  };

  const {
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
  } = value;

  const providers = settings?.activeProviders || [];
  const ocrProviders = settings?.activeOcrProviders || [];

  const inheritedRoutingStrategy = inherited.routingStrategy || "lowest-cost";

  const overrideFields = [
    ocrProvider,
    ocrModel,
    tlProvider,
    tlModel,
    qaProvider,
    qaMode,
    qaLlmModel,
    qaVlmModel,
    routingStrategy,
  ];
  const overriddenCount =
    overrideFields.filter((v) => v !== "").length +
    (useFallbackModels !== null ? 1 : 0);
  const inheritedCount = overrideFields.length + 1 - overriddenCount;

  const effOcrProv =
    ocrProvider ||
    inherited.ocrProvider ||
    settings?.ocrProvider ||
    "openrouter";
  // Local OCR is only locked to a single fixed value when the worker has not published its
  // det+rec catalog; once it has, PP-OCRv6 / PP-OCRv5 are selectable like any other model.
  const ocrDisabled =
    effOcrProv === "local" &&
    (settings?.providerModelsMap?.["local"]?.ocr || []).length === 0;
  // Local OCR models are PaddleOCR det+rec pairs, not vision-language models, so the default
  // "OCR VLM Model" label would be wrong for them.
  const effectiveOcrModelLabel =
    effOcrProv === "local" ? localOcrModelLabel : ocrModelLabel;
  const ocrCapabilityMissing =
    effOcrProv !== "local" &&
    isCapabilityMissing(
      settings?.providerModelsMap,
      effOcrProv,
      "ocr",
      settings?.ocrVlmModelList,
    );
  const disableQaMode = useResolvedQaModeForDisable
    ? qaMode || inherited.qaMode || ""
    : qaMode;
  const effTlProv =
    tlProvider || inherited.tlProvider || settings?.tlProvider || "openrouter";
  const tlCapabilityMissing = isCapabilityMissing(
    settings?.providerModelsMap,
    effTlProv,
    "tl",
    settings?.tlLlmModelList,
  );
  const qaLlmDisabled = disableQaMode === "vlm" || disableQaMode === "none";
  const qaVlmDisabled = disableQaMode === "llm" || disableQaMode === "none";
  const effQaProv =
    qaProvider || inherited.qaProvider || settings?.qaProvider || "openrouter";
  const qaLlmCapabilityMissing = isCapabilityMissing(
    settings?.providerModelsMap,
    effQaProv,
    "qaLLM",
    settings?.qaLlmModelList,
  );
  const qaVlmCapabilityMissing = isCapabilityMissing(
    settings?.providerModelsMap,
    effQaProv,
    "qaVLM",
    settings?.qaVlmModelList,
  );

  // When inheriting, display the inherited value so the select is never blank.
  // Picking an option sets an explicit override; the X button reverts to inherit.
  const effectiveUseFallback =
    useFallbackModels ?? inherited.useFallbackModels !== false;

  return (
    <Accordion
      expanded={expanded}
      onChange={onToggle}
      sx={{ mt: 2 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          Model Overrides (Optional)
        </Typography>
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
        <Box sx={fieldBoxSx}>
          <FormControl fullWidth>
            <InputLabel>OCR Provider</InputLabel>
            <Select
              size="small"
              value={ocrProvider || inherited.ocrProvider || ""}
              label="OCR Provider"
              onChange={(e) =>
                handleProviderChange("ocrProvider", e.target.value)
              }
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
            <IconButton
              aria-label="Clear OCR Provider override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => handleProviderChange("ocrProvider", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl
            fullWidth
            disabled={ocrDisabled || ocrCapabilityMissing}
          >
            <InputLabel>{effectiveOcrModelLabel}</InputLabel>
            <Select
              size="small"
              value={
                ocrDisabled
                  ? settings?.localOcrModel || "local"
                  : ocrCapabilityMissing
                    ? "N/A"
                    : ocrModel || inherited.ocrModel || ""
              }
              label={effectiveOcrModelLabel}
              onChange={(e) => onChange("ocrModel", e.target.value)}
            >
              {ocrDisabled ? (
                <MenuItem value={settings?.localOcrModel || "local"}>
                  {settings?.localOcrModel || localOcrModelLabel}
                </MenuItem>
              ) : (
                renderModelOptions(
                  settings?.providerModelsMap,
                  effOcrProv,
                  "ocr",
                  settings?.ocrVlmModelList,
                )
              )}
            </Select>
          </FormControl>
          {ocrModel !== "" && (
            <IconButton
              aria-label="Clear OCR Model override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("ocrModel", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl fullWidth>
            <InputLabel>TL Provider</InputLabel>
            <Select
              size="small"
              value={tlProvider || inherited.tlProvider || ""}
              label="TL Provider"
              onChange={(e) =>
                handleProviderChange("tlProvider", e.target.value)
              }
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
            <IconButton
              aria-label="Clear TL Provider override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => handleProviderChange("tlProvider", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl
            fullWidth
            disabled={tlCapabilityMissing}
          >
            <InputLabel>{tlModelLabel}</InputLabel>
            <Select
              size="small"
              value={
                tlCapabilityMissing ? "N/A" : tlModel || inherited.tlModel || ""
              }
              label={tlModelLabel}
              onChange={(e) => onChange("tlModel", e.target.value)}
            >
              {renderModelOptions(
                settings?.providerModelsMap,
                effTlProv,
                "tl",
                settings?.tlLlmModelList,
              )}
            </Select>
          </FormControl>
          {tlModel !== "" && (
            <IconButton
              aria-label="Clear TL Model override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("tlModel", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl fullWidth>
            <InputLabel>QA Provider</InputLabel>
            <Select
              size="small"
              value={qaProvider || inherited.qaProvider || ""}
              label="QA Provider"
              onChange={(e) =>
                handleProviderChange("qaProvider", e.target.value)
              }
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
            <IconButton
              aria-label="Clear QA Provider override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => handleProviderChange("qaProvider", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl fullWidth>
            <InputLabel>QA Mode</InputLabel>
            <Select
              size="small"
              value={qaMode || inherited.qaMode || ""}
              label="QA Mode"
              onChange={(e) => onChange("qaMode", e.target.value)}
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
            <IconButton
              aria-label="Clear QA Mode override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("qaMode", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl
            fullWidth
            disabled={qaLlmDisabled || qaLlmCapabilityMissing}
          >
            <InputLabel>QA LLM Model</InputLabel>
            <Select
              size="small"
              value={
                qaLlmCapabilityMissing
                  ? "N/A"
                  : qaLlmModel || inherited.qaLlmModel || ""
              }
              label="QA LLM Model"
              onChange={(e) => onChange("qaLlmModel", e.target.value)}
            >
              {renderModelOptions(
                settings?.providerModelsMap,
                effQaProv,
                "qaLLM",
                settings?.qaLlmModelList,
              )}
            </Select>
          </FormControl>
          {qaLlmModel !== "" && (
            <IconButton
              aria-label="Clear QA LLM Model override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("qaLlmModel", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl
            fullWidth
            disabled={qaVlmDisabled || qaVlmCapabilityMissing}
          >
            <InputLabel>QA VLM Model</InputLabel>
            <Select
              size="small"
              value={
                qaVlmCapabilityMissing
                  ? "N/A"
                  : qaVlmModel || inherited.qaVlmModel || ""
              }
              label="QA VLM Model"
              onChange={(e) => onChange("qaVlmModel", e.target.value)}
            >
              {renderModelOptions(
                settings?.providerModelsMap,
                effQaProv,
                "qaVLM",
                settings?.qaVlmModelList,
              )}
            </Select>
          </FormControl>
          {qaVlmModel !== "" && (
            <IconButton
              aria-label="Clear QA VLM Model override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("qaVlmModel", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl
            fullWidth
            size="small"
            disabled={
              ![
                ocrProvider || inherited.ocrProvider || settings?.ocrProvider,
                tlProvider || inherited.tlProvider || settings?.tlProvider,
                qaProvider || inherited.qaProvider || settings?.qaProvider,
              ].includes("openrouter")
            }
          >
            <InputLabel>Routing Strategy</InputLabel>
            <Select
              size="small"
              value={routingStrategy || inheritedRoutingStrategy}
              label="Routing Strategy"
              onChange={(e) => onChange("routingStrategy", e.target.value)}
            >
              <MenuItem value="lowest-cost">Lowest Cost</MenuItem>
              <MenuItem value="highest-throughput">Highest Throughput</MenuItem>
            </Select>
          </FormControl>
          {routingStrategy !== "" && (
            <IconButton
              aria-label="Clear Routing Strategy override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("routingStrategy", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl
            fullWidth
            size="small"
          >
            <InputLabel>Use Fallback Models</InputLabel>
            <Select
              size="small"
              value={effectiveUseFallback ? "true" : "false"}
              label="Use Fallback Models"
              onChange={(e) =>
                onChange("useFallbackModels", e.target.value === "true")
              }
            >
              <MenuItem value="true">Enabled</MenuItem>
              <MenuItem value="false">Disabled</MenuItem>
            </Select>
          </FormControl>
          {useFallbackModels !== null && (
            <IconButton
              aria-label="Clear Use Fallback Models override"
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("useFallbackModels", null)}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
      </AccordionDetails>
    </Accordion>
  );
};

export default ModelOverridesAccordion;
