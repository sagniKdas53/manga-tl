import { useEffect, useRef, useState } from "react";

/**
 * Drop a chapter archive anywhere on the page (UI overhaul, #217). Returns whether files are
 * being dragged over the window, so the page can show what a drop will do.
 *
 * Only file drags count, and only while `enabled`. The chapter page has its own window drop
 * handler for loose page images; this hook is for the library and series pages.
 */
export const useArchiveDrop = (
  enabled: boolean,
  onFile: (file: File) => void,
): boolean => {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const onFileRef = useRef(onFile);
  useEffect(() => {
    onFileRef.current = onFile;
  }, [onFile]);

  useEffect(() => {
    if (!enabled) return;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const handleEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const handleLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const handleOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const handleDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) onFileRef.current(file);
    };

    window.addEventListener("dragenter", handleEnter);
    window.addEventListener("dragleave", handleLeave);
    window.addEventListener("dragover", handleOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragenter", handleEnter);
      window.removeEventListener("dragleave", handleLeave);
      window.removeEventListener("dragover", handleOver);
      window.removeEventListener("drop", handleDrop);
      depth.current = 0;
      setDragging(false);
    };
  }, [enabled]);

  return dragging;
};
