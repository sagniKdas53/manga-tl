import MenuItem from "@mui/material/MenuItem";
import { modelOptionLabel } from "../modelPricing";
import type { ModelEntry, SystemSettingsDto } from "../types";
import {
  CUSTOM_MODEL_VALUE,
  type ModelCapability,
} from "../utils/customModels";

/**
 * The options of a model Select: the provider's catalog for the task, then the current value if
 * the catalog does not list it (a custom ID registered after this list was fetched), then — for
 * any provider but local, whose models are baked into the worker — "Custom model ID…".
 *
 * Returned as an array, not a fragment: MUI's Select reads its options off its direct children.
 */
export const renderModelOptions = (
  providerMap: SystemSettingsDto["providerModelsMap"] | undefined,
  provider: string,
  capability: ModelCapability,
  legacyList: string[] | undefined,
  current?: string,
) => {
  let models: ModelEntry[] = [];
  if (providerMap) {
    models = providerMap[provider]?.[capability] || [];
  } else if (legacyList) {
    models = legacyList.map((m) => ({ id: m, name: m }));
  }

  if (models.length === 0) {
    return [
      <MenuItem
        key="N/A"
        value="N/A"
        disabled
      >
        N/A (Capability Missing)
      </MenuItem>,
    ];
  }

  const items = models.map((m) => (
    <MenuItem
      key={m.id}
      value={m.id}
    >
      {modelOptionLabel(m)}
    </MenuItem>
  ));
  if (
    current &&
    current !== "N/A" &&
    current !== CUSTOM_MODEL_VALUE &&
    !models.some((m) => m.id === current)
  ) {
    items.push(
      <MenuItem
        key={current}
        value={current}
      >
        {modelOptionLabel({ id: current, name: current, custom: true })}
      </MenuItem>,
    );
  }
  if (provider !== "local") {
    items.push(
      <MenuItem
        key={CUSTOM_MODEL_VALUE}
        value={CUSTOM_MODEL_VALUE}
        sx={{ fontStyle: "italic", borderTop: 1, borderColor: "divider" }}
      >
        Custom model ID…
      </MenuItem>,
    );
  }
  return items;
};
