import { useEffect, useState } from "react";
import { fontSpecs, loadFontSpecs, type FontRef } from "../utils/fitText";

/**
 * A number that changes whenever web fonts finish loading (G1).
 *
 * The editor fits text while it renders, measuring on a canvas, and measuring never makes the
 * browser fetch a web font. A page opened before its face is ready is fitted in the fallback face
 * (ch. 6 p. 1: eight lines in the editor, six in the export) and stays that way until something
 * re-renders. This hook asks for the page's faces as soon as it sees them and changes its value
 * when they, or any other font, finish loading. Use the value as a dependency of anything that
 * caches a fit; a component that fits during render re-renders on the change by itself.
 */
export function useFontsVersion(elements: Iterable<FontRef>): number {
  const [version, setVersion] = useState(0);
  const key = fontSpecs(elements).join("|");

  useEffect(() => {
    if (!key) return;
    let live = true;
    void loadFontSpecs(key.split("|")).then(() => {
      if (live) setVersion((v) => v + 1);
    });
    return () => {
      live = false;
    };
  }, [key]);

  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    const fonts = document.fonts;
    const bump = () => setVersion((v) => v + 1);
    fonts.addEventListener("loadingdone", bump);
    return () => fonts.removeEventListener("loadingdone", bump);
  }, []);

  return version;
}
