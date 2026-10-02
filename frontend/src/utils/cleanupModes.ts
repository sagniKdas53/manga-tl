/**
 * How cleanup rebuilds the art under erased lettering. The backend and worker accept exactly these
 * values (`settings::CLEANUP_MODES`, `cleanup_reconstruct.RECONSTRUCTION_MODES` plus "off"); a
 * chapter or series may override the global choice. A new mode applies to pages cleaned after it
 * is set — redo OCR on a page to clean it again under the new mode.
 */
export const CLEANUP_MODE_OPTIONS = [
  {
    value: "auto",
    label: "Auto — TELEA on flat, AOT on detailed",
  },
  { value: "telea", label: "TELEA only (fast, flat fill)" },
  { value: "aot", label: "AOT-GAN only (detailed art)" },
  { value: "off", label: "Off — no erasing, text over art" },
] as const;

export type CleanupMode = (typeof CLEANUP_MODE_OPTIONS)[number]["value"];
