import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useFontsVersion } from "../../hooks/useFontsVersion";

/** A stand-in for `document.fonts`: jsdom has no Font Loading API. */
function fakeFontSet() {
  const target = new EventTarget();
  let resolveLoad: () => void = () => {};
  const load = vi.fn(
    () =>
      new Promise<FontFace[]>((resolve) => {
        resolveLoad = () => resolve([]);
      }),
  );
  return {
    set: {
      load,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: vi.fn(target.removeEventListener.bind(target)),
    },
    finishLoad: () => resolveLoad(),
    fireLoadingDone: () => target.dispatchEvent(new Event("loadingdone")),
  };
}

function installFonts(value: unknown) {
  Object.defineProperty(document, "fonts", { value, configurable: true });
}

const comic = [{ font: "Comic Neue", fontWeight: "bold", fontStyle: "normal" }];

describe("useFontsVersion", () => {
  afterEach(() => {
    installFonts(undefined);
  });

  it("asks for the page's faces at once and bumps when they arrive", async () => {
    // A page opened before its web font is ready: the first fit runs in the fallback face, so
    // the version must change once the face loads, or the canvas keeps the fallback's line breaks.
    const fonts = fakeFontSet();
    installFonts(fonts.set);

    const { result } = renderHook(() => useFontsVersion(comic));
    expect(fonts.set.load).toHaveBeenCalledWith('bold 16px "Comic Neue"');
    const before = result.current;

    await act(async () => {
      fonts.finishLoad();
    });
    await waitFor(() => expect(result.current).toBeGreaterThan(before));
  });

  it("bumps when any font finishes loading, not only the ones it asked for", async () => {
    // A face can arrive through the stylesheet (Google Fonts) rather than through our request.
    const fonts = fakeFontSet();
    installFonts(fonts.set);
    const { result } = renderHook(() => useFontsVersion(comic));
    const before = result.current;

    act(() => {
      fonts.fireLoadingDone();
    });
    expect(result.current).toBeGreaterThan(before);
  });

  it("does not ask again when the elements change but their faces do not", () => {
    const fonts = fakeFontSet();
    installFonts(fonts.set);
    const { rerender } = renderHook(({ els }) => useFontsVersion(els), {
      initialProps: { els: comic },
    });
    rerender({
      els: [
        ...comic,
        { font: "Comic Neue", fontWeight: "bold", fontStyle: "normal" },
      ],
    });
    expect(fonts.set.load).toHaveBeenCalledTimes(1);

    rerender({
      els: [{ font: "Bangers", fontWeight: "bold", fontStyle: "normal" }],
    });
    expect(fonts.set.load).toHaveBeenCalledWith('bold 16px "Bangers"');
  });

  it("stops listening on unmount", () => {
    const fonts = fakeFontSet();
    installFonts(fonts.set);
    const { unmount } = renderHook(() => useFontsVersion(comic));
    unmount();
    expect(fonts.set.removeEventListener).toHaveBeenCalledWith(
      "loadingdone",
      expect.any(Function),
    );
  });

  it("stays put without the Font Loading API", () => {
    installFonts(undefined);
    const { result } = renderHook(() => useFontsVersion(comic));
    expect(result.current).toBe(0);
  });
});
