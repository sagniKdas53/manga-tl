import { describe, it, expect } from "vitest";
import { themeObj } from "../theme";

/** Relative luminance of an #rrggbb colour, per WCAG 2.1. */
const luminance = (hex: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a six-digit hex colour: ${hex}`);
  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrastRatio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** WCAG AA for normal-size body text. */
const AA_NORMAL_TEXT = 4.5;

describe("theme colour contrast (AUDIT-F4)", () => {
  it("computes known contrast ratios correctly", () => {
    // Sanity-check the helper itself before trusting its verdicts.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  (["light", "dark"] as const).forEach((mode) => {
    describe(`${mode} mode`, () => {
      const palette = themeObj(mode).palette;

      it.each(["primary", "secondary"] as const)(
        "text.%s meets WCAG AA against both background surfaces",
        (variant) => {
          const colour = palette.text[variant];
          for (const surface of [
            palette.background.paper,
            palette.background.default,
          ]) {
            expect(
              contrastRatio(colour, surface),
              `text.${variant} (${colour}) on ${surface}`,
            ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
          }
        },
      );

      it("does not render secondary text less legibly than disabled text", () => {
        // The state that regressed: light secondary sat at 2.2:1 while disabled was near 5:1,
        // so the colour meaning "de-emphasised" was harder to read than the one meaning "off".
        const paper = palette.background.paper;
        expect(
          contrastRatio(palette.text.secondary, paper),
        ).toBeGreaterThanOrEqual(contrastRatio(palette.text.disabled, paper));
      });
    });
  });
});
