import { safeFetch } from "../utils";
import type { CustomModel } from "../types";

/** The Select value of the "Custom model ID…" entry; it is never saved as a model. */
export const CUSTOM_MODEL_VALUE = "__custom_model__";

export type ModelCapability = "ocr" | "tl" | "qaLLM" | "qaVLM";

/**
 * Registers `entry` alongside the owner's other custom model IDs and returns the stored list.
 * Registration is what makes the backend accept the ID: without it a chapter override naming a
 * model the catalog does not list is swapped for the global model when a job is queued.
 */
export async function registerCustomModel(
  entry: CustomModel,
  token: string | undefined,
): Promise<CustomModel[]> {
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};
  const current = await safeFetch("/api/settings", { headers });
  if (!current.ok) throw new Error("Could not load settings");
  const settings = (await current.json()) as { customModels?: CustomModel[] };
  return saveCustomModels([...(settings.customModels ?? []), entry], token);
}

/** Replaces the owner's custom model IDs; the backend normalizes and deduplicates them. */
export async function saveCustomModels(
  models: CustomModel[],
  token: string | undefined,
): Promise<CustomModel[]> {
  const res = await safeFetch("/api/settings/custom-models", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(models),
  });
  if (!res.ok) throw new Error("Could not save custom models");
  return (await res.json()) as CustomModel[];
}
