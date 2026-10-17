import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OcrAngleNote } from "../../components/ReaderRightSidebar";
import type { OcrRegion } from "../../types";

// E2 (#180): an element turned by OCR says so, and can be levelled or put back.
const turned = {
  id: "r1",
  rotation: -15.6,
  textAreaW: 300,
} as unknown as OcrRegion;

describe("OcrAngleNote", () => {
  it("tags an element still at OCR's angle and levels it", () => {
    const onRotate = vi.fn();
    render(
      <OcrAngleNote
        rotation={-15.6}
        region={turned}
        onRotate={onRotate}
      />,
    );
    expect(screen.getByTestId("ocr-angle-tag")).toHaveTextContent("Auto (OCR)");
    fireEvent.click(screen.getByRole("button", { name: "Level" }));
    expect(onRotate).toHaveBeenCalledWith(0);
  });

  it("offers OCR's angle back once the element was turned away from it", () => {
    const onRotate = vi.fn();
    render(
      <OcrAngleNote
        rotation={0}
        region={turned}
        onRotate={onRotate}
      />,
    );
    expect(screen.queryByTestId("ocr-angle-tag")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Use OCR angle (-15.6°)" }),
    );
    expect(onRotate).toHaveBeenCalledWith(-15.6);
  });

  it("says nothing for a region OCR left level", () => {
    const { container } = render(
      <OcrAngleNote
        rotation={20}
        region={{ id: "r2", rotation: 0 } as unknown as OcrRegion}
        onRotate={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
