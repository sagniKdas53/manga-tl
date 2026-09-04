import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";
import { theme } from "../theme";

/**
 * `colorSchemes` is typed `Partial<Record<SupportedColorScheme, ...>>` because a theme may define
 * only one scheme. This one defines both, and a test that silently skipped a missing scheme would
 * be worse than one that fails loudly.
 */
const paletteFor = (mode: "light" | "dark") => {
  const scheme = theme.colorSchemes[mode];
  if (!scheme) throw new Error(`theme defines no ${mode} colour scheme`);
  return scheme.palette;
};

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

/**
 * AUDIT-F21: an upper bound, which is the unusual half. Contrast has a comfortable band, not a
 * "more is better" axis — past roughly 15:1 on an emissive panel the glyph edges bloom, and on a
 * tablet read at night that is what "harsh" means. The dark scheme was at 19.0:1, nearly triple
 * the AAA threshold it only has to clear once. Kept alongside the AA floor deliberately: the
 * failure this guards against is someone "improving" contrast back to pure white on pure black.
 */
const HALATION_CEILING = 15;

/** WCAG AAA for normal-size body text — the floor the dark scheme should still clear. */
const AAA_NORMAL_TEXT = 7;

/** HSL saturation, 0–100, of an #rrggbb colour. */
const saturation = (hex: string) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a six-digit hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map(
    (i) => parseInt(m[1].slice(i, i + 2), 16) / 255,
  );
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (100 * (max - min)) / (l > 0.5 ? 2 - max - min : max + min);
};

describe("theme colour contrast (AUDIT-F4)", () => {
  it("computes known contrast ratios correctly", () => {
    // Sanity-check the helper itself before trusting its verdicts.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  (["light", "dark"] as const).forEach((mode) => {
    describe(`${mode} mode`, () => {
      const palette = paletteFor(mode);

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

describe("dark mode is readable rather than merely high-contrast (AUDIT-F21)", () => {
  const palette = paletteFor("dark");

  it("keeps body text inside the comfortable band, not above it", () => {
    for (const surface of [
      palette.background.default,
      palette.background.paper,
    ]) {
      const ratio = contrastRatio(palette.text.primary, surface);
      expect(ratio, `text.primary on ${surface}`).toBeGreaterThanOrEqual(
        AAA_NORMAL_TEXT,
      );
      expect(ratio, `text.primary on ${surface}`).toBeLessThanOrEqual(
        HALATION_CEILING,
      );
    }
  });

  it("separates paper from the page behind it", () => {
    // 1.15:1 before, which is close enough to nothing that a card had no edge of its own and
    // the whole page read as one black field. Material's dark baseline (#121212 / #1e1e1e) is
    // 1.24:1; asking for much more than that stops looking raised and starts looking grey.
    expect(
      contrastRatio(palette.background.paper, palette.background.default),
    ).toBeGreaterThan(1.18);
  });

  it("does not put a fully saturated accent on a near-black field", () => {
    // Every accent was 84–100% saturated, which is the combination that appears to vibrate
    // against a dark surface. Hues are unchanged — only the saturation came down.
    const accents = {
      primary: palette.primary.main,
      secondary: palette.secondary.main,
      error: palette.error.main,
      warning: palette.warning.main,
      success: palette.success.main,
      info: palette.info.main,
    };
    for (const [name, colour] of Object.entries(accents)) {
      expect(saturation(colour), `${name} (${colour})`).toBeLessThanOrEqual(80);
    }
  });

  it("keeps every accent legible as text on both surfaces", () => {
    // Desaturating can cost contrast, so the floor is re-checked after the fact rather than
    // assumed. `primary` is the tight one: it is the link and button colour.
    const accents = [
      palette.primary.main,
      palette.secondary.main,
      palette.error.main,
      palette.success.main,
      palette.info.main,
    ];
    for (const colour of accents) {
      for (const surface of [
        palette.background.default,
        palette.background.paper,
      ]) {
        expect(
          contrastRatio(colour, surface),
          `${colour} on ${surface}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    }
  });
});

describe("the two dark palettes agree (AUDIT-F21)", () => {
  // `index.css` carries a second, hand-maintained copy of the dark palette for the parts of the
  // app styled with plain CSS variables rather than MUI's `sx`. Nothing kept them in step and
  // they had drifted: base was #111111 there against #0f0f0f in the theme, body text #f3f4f6
  // against #fefefe. Neither file is wrong on its own, which is exactly why the drift survived —
  // each looks self-consistent. This test is the missing link between them.
  // Read off disk rather than imported. `import.meta.url` is not a file URL under Vite's
  // transform, and `import css from "../index.css?raw"` returns an empty string because Vitest
  // stubs CSS modules by default. `process.cwd()` is the Vite root, which is `frontend/`.
  const cssPath = resolve(process.cwd(), "src/index.css");
  const css = readFileSync(cssPath, "utf8");

  /** Read a custom property out of the base `:root` block, which is the dark scheme. */
  const cssVar = (name: string) => {
    // Whitespace-agnostic on purpose: `?raw` hands back the CSS after Vite has processed it,
    // which may or may not have preserved the newlines the source file is written with.
    // `:root.light` does not match — the selector has to be followed by whitespace then `{`.
    const root = /:root\s*\{([^}]*)\}/.exec(css);
    if (!root) throw new Error("could not find the :root block in index.css");
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(root[1]);
    if (!m) throw new Error(`--${name} is not defined in :root`);
    return m[1].trim();
  };

  const palette = paletteFor("dark");

  it.each([
    ["bg-base", palette.background.default],
    ["bg-surface", palette.background.paper],
    ["text-main", palette.text.primary],
    ["text-muted", palette.text.secondary],
    ["text-dim", palette.text.disabled],
    ["primary", palette.primary.main],
  ])("--%s matches the theme", (name, expected) => {
    expect(cssVar(name)).toBe(expected);
  });
});
