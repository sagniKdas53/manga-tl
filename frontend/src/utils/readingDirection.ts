/**
 * Reading direction in words. Older series store it as `rightToLeft` and newer ones as `rtl`,
 * so both spellings are accepted.
 */
export const readingDirectionLabel = (direction?: string | null): string => {
  switch ((direction ?? "").toLowerCase()) {
    case "rtl":
    case "righttoleft":
      return "Right to left";
    case "ltr":
    case "lefttoright":
      return "Left to right";
    case "ttb":
    case "toptobottom":
    case "vertical":
    case "webtoon":
      return "Top to bottom";
    default:
      return direction || "Not set";
  }
};

/** The same, as a short tag for a card: "RTL", "LTR", "Vertical". */
export const readingDirectionShort = (direction?: string | null): string => {
  const label = readingDirectionLabel(direction);
  if (label === "Right to left") return "RTL";
  if (label === "Left to right") return "LTR";
  if (label === "Top to bottom") return "Vertical";
  return label;
};
