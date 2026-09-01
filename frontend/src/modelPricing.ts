import type { ModelEntry } from "./types";

const formatPrice = (value: number) => {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toPrecision(2)}`;
};

export const modelPriceLabel = (model: ModelEntry) => {
  const pricing = model.pricing;
  if (pricing?.note) return pricing.note;
  if (model.free) return "Free";

  const parts: string[] = [];
  if (pricing?.promptPerMillion != null) {
    parts.push(`${formatPrice(pricing.promptPerMillion)}/M input`);
  }
  if (pricing?.completionPerMillion != null) {
    parts.push(`${formatPrice(pricing.completionPerMillion)}/M output`);
  }
  if (pricing?.request != null && pricing.request > 0) {
    parts.push(`${formatPrice(pricing.request)}/request`);
  }
  if (pricing?.image != null && pricing.image > 0) {
    parts.push(`${formatPrice(pricing.image)}/image`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Cost unknown";
};

export const modelOptionLabel = (model: ModelEntry) =>
  `${model.name} · ${modelPriceLabel(model)}`;
