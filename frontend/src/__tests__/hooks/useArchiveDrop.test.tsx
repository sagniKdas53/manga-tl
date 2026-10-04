import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useArchiveDrop } from "../../hooks/useArchiveDrop";

/** A window drag event carrying files (or not), as the browser sends it. */
const dragEvent = (type: string, files: File[] = [], withFiles = true) => {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: { types: withFiles ? ["Files"] : ["text/plain"], files },
  });
  return event;
};

describe("useArchiveDrop", () => {
  it("reports a file drag over the window and hands over the dropped file", () => {
    const onFile = vi.fn();
    const { result } = renderHook(() => useArchiveDrop(true, onFile));
    expect(result.current).toBe(false);

    act(() => {
      window.dispatchEvent(dragEvent("dragenter"));
    });
    expect(result.current).toBe(true);

    const file = new File(["zip"], "chapter.zip");
    const drop = dragEvent("drop", [file]);
    act(() => {
      window.dispatchEvent(drop);
    });
    expect(result.current).toBe(false);
    expect(drop.defaultPrevented).toBe(true); // the browser must not open the file
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("ignores drags that carry no files, such as moving a page tile", () => {
    const onFile = vi.fn();
    const { result } = renderHook(() => useArchiveDrop(true, onFile));
    act(() => {
      window.dispatchEvent(dragEvent("dragenter", [], false));
      window.dispatchEvent(dragEvent("drop", [], false));
    });
    expect(result.current).toBe(false);
    expect(onFile).not.toHaveBeenCalled();
  });

  it("stays out of the way while disabled (a dialog is open)", () => {
    const onFile = vi.fn();
    const { result } = renderHook(() => useArchiveDrop(false, onFile));
    act(() => {
      window.dispatchEvent(dragEvent("dragenter"));
      window.dispatchEvent(dragEvent("drop", [new File(["x"], "a.zip")]));
    });
    expect(result.current).toBe(false);
    expect(onFile).not.toHaveBeenCalled();
  });

  it("only hides the overlay once the drag has left every nested element", () => {
    const { result } = renderHook(() => useArchiveDrop(true, vi.fn()));
    act(() => {
      window.dispatchEvent(dragEvent("dragenter")); // page
      window.dispatchEvent(dragEvent("dragenter")); // a card inside it
      window.dispatchEvent(dragEvent("dragleave")); // left the card
    });
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(dragEvent("dragleave")); // left the page
    });
    expect(result.current).toBe(false);
  });
});
