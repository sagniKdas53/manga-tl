import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fitTextInBox } from "../../utils/fitText";

describe("fitTextInBox", () => {
  let originalCreateElement: typeof document.createElement;
  let mockMeasureText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalCreateElement = document.createElement.bind(document);
    mockMeasureText = vi.fn().mockImplementation((text: string) => {
      // Mock width as 10 pixels per character for predictable testing
      return { width: text.length * 10 };
    });

    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string, options?: ElementCreationOptions) => {
        if (tagName === "canvas") {
          return {
            getContext: (contextId: string) => {
              if (contextId === "2d") {
                return {
                  measureText: mockMeasureText,
                  font: "",
                };
              }
              return null;
            },
          } as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName, options);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fits short text in a large box without overflow", () => {
    const result = fitTextInBox("Hello", 200, 100, "Arial");
    expect(result.overflow).toBe(false);
    expect(result.lines).toEqual(["Hello"]);
    expect(result.fontSize).toBeGreaterThan(10);
  });

  it("wraps long text into multiple lines", () => {
    // 20 chars total => 200 width. If maxWidth is 100, it should split.
    const result = fitTextInBox("This is a long text", 100, 200, "Arial");
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.overflow).toBe(false);
  });

  it("reports overflow if text cannot fit within maxHeight even at minimum font size", () => {
    const longText = "A ".repeat(100);
    const result = fitTextInBox(longText, 20, 20, "Arial");
    expect(result.overflow).toBe(true);
  });

  it("handles elliptical shape wrapping", () => {
    const result = fitTextInBox(
      "Test elliptical shape wrapping",
      100,
      100,
      "Arial",
      16,
      "elliptical",
    );
    expect(result).toBeDefined();
    expect(Array.isArray(result.lines)).toBe(true);
  });

  it("handles polygon shape wrapping", () => {
    const polygon = JSON.stringify([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
    const result = fitTextInBox(
      "Test polygon shape wrapping",
      100,
      100,
      "Arial",
      16,
      "rectangular",
      0,
      0,
      polygon,
    );
    expect(result).toBeDefined();
    expect(Array.isArray(result.lines)).toBe(true);
  });
});

/**
 * The size search used to test height and the explicit fallback flag only.
 *
 * A word wider than the line it lands on is split per character *inside* an otherwise successful
 * wrap, and that split was invisible to the search — so it kept growing the font until the height
 * ran out and returned the largest size that mangles the text. The exported page showed it as
 * "CLOTHE/S", "IMMEDI/ATELY", "colle/cted", while the same page rendered by the worker was clean.
 *
 * These use a measurer whose width scales with the font size, since that is the relationship the
 * search depends on and the suite's fixed 10px-per-character mock cannot express it.
 */
describe("fitTextInBox sizing against the width of the box", () => {
  beforeEach(() => {
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tagName: string, options?: ElementCreationOptions) => {
        if (tagName !== "canvas")
          return originalCreateElement(tagName, options);
        const ctx = {
          font: "",
          measureText(text: string) {
            const size = Number(/(\d+)px/.exec(ctx.font)?.[1] ?? 16);
            return { width: text.length * size * 0.5 };
          },
        };
        return {
          getContext: (id: string) => (id === "2d" ? ctx : null),
        } as unknown as HTMLCanvasElement;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const text = "...How did I become a target for collection...??";

  it("shrinks to fit the width instead of breaking a word", () => {
    const result = fitTextInBox(text, 95, 1180, "Arial", 12, "rectangular");

    expect(result.lines.join(" ").split(/\s+/).filter(Boolean)).toEqual(
      text.split(" "),
    );
  });

  it("never returns a line wider than the box", () => {
    const result = fitTextInBox(text, 95, 1180, "Arial", 12, "rectangular");

    for (const line of result.lines) {
      expect(line.length * result.fontSize * 0.5).toBeLessThanOrEqual(95);
    }
  });

  it("still uses the largest legible size when no size can set the text whole", () => {
    // One word wider than the box even at the minimum size: splitting is the only option left.
    const result = fitTextInBox(
      "Onomatopoeia",
      18,
      300,
      "Arial",
      12,
      "rectangular",
    );

    expect(result.fontSize).toBeGreaterThan(6);
    expect(result.lines.length).toBeGreaterThan(1);
  });

  it("ignores a mask narrower than the box it is flowing into", () => {
    // The tight rectangle round a vertical Japanese column, against the squared-up box the backend
    // chose for it. Wrapping to the mask would set the English straight back down the column.
    const inkColumn = JSON.stringify([
      [71, 675],
      [120, 675],
      [120, 1164],
      [71, 1164],
    ]);

    const result = fitTextInBox(
      text,
      163,
      185,
      "Arial",
      12,
      "rectangular",
      13,
      822,
      inkColumn,
    );

    const widest = Math.max(
      ...result.lines.map((l) => l.length * result.fontSize * 0.5),
    );
    expect(widest).toBeGreaterThan(49);
    expect(widest).toBeLessThanOrEqual(163);
  });
});
