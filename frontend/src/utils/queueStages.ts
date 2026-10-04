/**
 * The pipeline strip (UI overhaul, #215): one thin bar per page, split into the pipeline's
 * stages, so a whole chapter's progress reads at a glance instead of from a column of
 * identical "PENDING" chips.
 *
 * Cleanup runs beside layout and translation once OCR is done, so "before the current stage"
 * is a fair reading of the order, not an exact one. The strip says where the page's newest job
 * is; it does not claim cleanup has finished when translation is running.
 */
export const STRIP_STAGES = [
  { key: "panels", label: "Panels", types: ["panel-detection"] },
  {
    key: "ocr",
    label: "OCR",
    types: ["ocr", "qa-re-ocr", "region-redo-ocr", "region-redo"],
  },
  { key: "cleanup", label: "Cleanup", types: ["cleanup", "manual-cleanup"] },
  {
    key: "translation",
    label: "Translation",
    types: ["layout", "translation", "region-redo-tl"],
  },
  { key: "render", label: "Render", types: ["render"] },
  { key: "qa", label: "QA", types: ["qa"] },
] as const;

export const stageIndexOf = (jobType: string): number =>
  STRIP_STAGES.findIndex((stage) =>
    (stage.types as readonly string[]).includes(jobType),
  );

export const stageLabelOf = (jobType: string): string => {
  const index = stageIndexOf(jobType);
  return index >= 0 ? STRIP_STAGES[index].label : jobType;
};

export type StripState = "running" | "waiting" | "done" | "failed" | "paused";

/** "42 s", "3 min", "1 h 5 min": how long a page has been in its current state. */
export const formatElapsed = (fromIso: string, now: number): string | null => {
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return null;
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
};
