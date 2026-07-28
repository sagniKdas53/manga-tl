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

const fieldBoxSx = {
  display: "flex",
  alignItems: "flex-start",
  gap: 0.5,
  minWidth: 0,
} as const;

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

  const ocrDisabled = (ocrProvider || inherited.ocrProvider) === "local";
  const disableQaMode = useResolvedQaModeForDisable
    ? qaMode || inherited.qaMode || ""
    : qaMode;
  const qaLlmDisabled = disableQaMode === "vlm" || disableQaMode === "none";
  const qaVlmDisabled = disableQaMode === "llm" || disableQaMode === "none";

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
          color="text.secondary"
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
              onChange={(e) => onChange("ocrProvider", e.target.value)}
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
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("ocrProvider", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl
            fullWidth
            disabled={ocrDisabled}
          >
            <InputLabel>{ocrModelLabel}</InputLabel>
            <Select
              size="small"
              value={
                ocrDisabled
                  ? settings?.localOcrModel || "local"
                  : ocrModel || inherited.ocrModel || ""
              }
              label={ocrModelLabel}
              onChange={(e) => onChange("ocrModel", e.target.value)}
            >
              {ocrDisabled ? (
                <MenuItem value={settings?.localOcrModel || "local"}>
                  {settings?.localOcrModel || localOcrModelLabel}
                </MenuItem>
              ) : (
                (() => {
                  const effProv =
                    ocrProvider ||
                    inherited.ocrProvider ||
                    settings?.ocrProvider ||
                    "openrouter";
                  if (
                    effProv !== "local" &&
                    (!settings?.providerModelsMap?.[effProv]?.ocr ||
                      settings?.providerModelsMap?.[effProv]?.ocr.length === 0)
                  ) {
                    return (
                      <MenuItem
                        value="N/A"
                        disabled
                      >
                        N/A (Capability Missing)
                      </MenuItem>
                    );
                  }
                  const models = settings?.providerModelsMap?.[effProv]?.ocr;
                  if (models && models.length > 0) {
                    return models.map((m: ModelEntry) => (
                      <MenuItem
                        key={m.id || m}
                        value={m.id || m}
                      >
                        {m.name || m}
                        {m.free ? " (Free)" : ""}
                      </MenuItem>
                    ));
                  }
                  return (settings?.ocrVlmModelList || []).map((m) => (
                    <MenuItem
                      key={m}
                      value={m}
                    >
                      {m}
                    </MenuItem>
                  ));
                })()
              )}
            </Select>
          </FormControl>
          {ocrModel !== "" && (
            <IconButton
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
              onChange={(e) => onChange("tlProvider", e.target.value)}
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
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("tlProvider", "")}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Box sx={fieldBoxSx}>
          <FormControl fullWidth>
            <InputLabel>{tlModelLabel}</InputLabel>
            <Select
              size="small"
              value={tlModel || inherited.tlModel || ""}
              label={tlModelLabel}
              onChange={(e) => onChange("tlModel", e.target.value)}
            >
              {(() => {
                const effProv =
                  tlProvider ||
                  inherited.tlProvider ||
                  settings?.tlProvider ||
                  "openrouter";
                const models = settings?.providerModelsMap?.[effProv]?.tl;
                if (models && models.length > 0) {
                  return models.map((m: ModelEntry) => (
                    <MenuItem
                      key={m.id || m}
                      value={m.id || m}
                    >
                      {m.name || m}
                      {m.free ? " (Free)" : ""}
                    </MenuItem>
                  ));
                }
                return (settings?.tlLlmModelList || []).map((m) => (
                  <MenuItem
                    key={m}
                    value={m}
                  >
                    {m}
                  </MenuItem>
                ));
              })()}
            </Select>
          </FormControl>
          {tlModel !== "" && (
            <IconButton
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
              onChange={(e) => onChange("qaProvider", e.target.value)}
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
              size="small"
              sx={{ mt: 0.5 }}
              onClick={() => onChange("qaProvider", "")}
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
            disabled={qaLlmDisabled}
          >
            <InputLabel>QA LLM Model</InputLabel>
            <Select
              size="small"
              value={qaLlmModel || inherited.qaLlmModel || ""}
              label="QA LLM Model"
              onChange={(e) => onChange("qaLlmModel", e.target.value)}
            >
              {(() => {
                const effProv =
                  qaProvider ||
                  inherited.qaProvider ||
                  settings?.qaProvider ||
                  "openrouter";
                const models = settings?.providerModelsMap?.[effProv]?.qaLLM;
                if (models && models.length > 0) {
                  return models.map((m: ModelEntry) => (
                    <MenuItem
                      key={m.id || m}
                      value={m.id || m}
                    >
                      {m.name || m}
                      {m.free ? " (Free)" : ""}
                    </MenuItem>
                  ));
                }
                return (settings?.qaLlmModelList || []).map((m) => (
                  <MenuItem
                    key={m}
                    value={m}
                  >
                    {m}
                  </MenuItem>
                ));
              })()}
            </Select>
          </FormControl>
          {qaLlmModel !== "" && (
            <IconButton
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
            disabled={qaVlmDisabled}
          >
            <InputLabel>QA VLM Model</InputLabel>
            <Select
              size="small"
              value={qaVlmModel || inherited.qaVlmModel || ""}
              label="QA VLM Model"
              onChange={(e) => onChange("qaVlmModel", e.target.value)}
            >
              {(() => {
                const effProv =
                  qaProvider ||
                  inherited.qaProvider ||
                  settings?.qaProvider ||
                  "openrouter";
                if (
                  !settings?.providerModelsMap?.[effProv]?.qaVLM ||
                  settings?.providerModelsMap?.[effProv]?.qaVLM.length === 0
                ) {
                  return (
                    <MenuItem
                      value="N/A"
                      disabled
                    >
                      N/A (Capability Missing)
                    </MenuItem>
                  );
                }
                const models = settings?.providerModelsMap?.[effProv]?.qaVLM;
                if (models && models.length > 0) {
                  return models.map((m: ModelEntry) => (
                    <MenuItem
                      key={m.id || m}
                      value={m.id || m}
                    >
                      {m.name || m}
                      {m.free ? " (Free)" : ""}
                    </MenuItem>
                  ));
                }
                return (settings?.qaVlmModelList || []).map((m) => (
                  <MenuItem
                    key={m}
                    value={m}
                  >
                    {m}
                  </MenuItem>
                ));
              })()}
            </Select>
          </FormControl>
          {qaVlmModel !== "" && (
            <IconButton
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
