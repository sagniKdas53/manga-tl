import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fitTextInBox } from './fitText';

describe('fitTextInBox', () => {
  let originalCreateElement: typeof document.createElement;
  let mockMeasureText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalCreateElement = document.createElement.bind(document);
    mockMeasureText = vi.fn().mockImplementation((text: string) => {
      // Mock width as 10 pixels per character for predictable testing
      return { width: text.length * 10 };
    });

    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          getContext: (contextId: string) => {
            if (contextId === '2d') {
              return {
                measureText: mockMeasureText,
                font: '',
              };
            }
            return null;
          }
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fits short text in a large box without overflow', () => {
    const result = fitTextInBox('Hello', 200, 100, 'Arial');
    expect(result.overflow).toBe(false);
    expect(result.lines).toEqual(['Hello']);
    expect(result.fontSize).toBeGreaterThan(10);
  });

  it('wraps long text into multiple lines', () => {
    // 20 chars total => 200 width. If maxWidth is 100, it should split.
    const result = fitTextInBox('This is a long text', 100, 200, 'Arial');
    expect(result.lines.length).toBeGreaterThan(1);
    expect(result.overflow).toBe(false);
  });

  it('reports overflow if text cannot fit within maxHeight even at minimum font size', () => {
    const longText = 'A '.repeat(100);
    const result = fitTextInBox(longText, 20, 20, 'Arial');
    expect(result.overflow).toBe(true);
  });

  it('handles elliptical shape wrapping', () => {
    const result = fitTextInBox('Test elliptical shape wrapping', 100, 100, 'Arial', 16, 'elliptical');
    expect(result).toBeDefined();
    expect(Array.isArray(result.lines)).toBe(true);
  });

  it('handles polygon shape wrapping', () => {
    const polygon = JSON.stringify([[0,0], [100,0], [100,100], [0,100]]);
    const result = fitTextInBox('Test polygon shape wrapping', 100, 100, 'Arial', 16, 'rectangular', 0, 0, polygon);
    expect(result).toBeDefined();
    expect(Array.isArray(result.lines)).toBe(true);
  });
});
