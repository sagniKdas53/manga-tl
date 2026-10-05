import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PipelineStrip } from "../../components/QueueParts";

describe("PipelineStrip", () => {
  it("names the stage and its position for a known job type", () => {
    render(
      <PipelineStrip
        jobType="translation"
        state="running"
      />,
    );
    expect(
      screen.getByRole("img", { name: "Stage 4 of 6: Translation" }),
    ).toBeInTheDocument();
  });

  it("does not announce a stage number for a job type it does not know", () => {
    render(
      <PipelineStrip
        jobType="brand-new-stage"
        state="running"
      />,
    );
    expect(
      screen.getByRole("img", { name: "Stage: brand-new-stage" }),
    ).toBeInTheDocument();
  });

  it("pulses the running stage only when asked to", () => {
    // jsdom computes no animations, so read the rule Emotion generated for the segment.
    const pulses = (el: HTMLElement) => {
      const css = [...document.querySelectorAll("style")]
        .map((tag) => tag.textContent)
        .join("\n");
      return [...el.classList].some((cls) =>
        new RegExp(`\\.${cls}\\{[^}]*animation:`).test(css),
      );
    };
    const { rerender } = render(
      <PipelineStrip
        jobType="ocr"
        state="running"
      />,
    );
    expect(pulses(screen.getByTitle("OCR"))).toBe(true);
    rerender(
      <PipelineStrip
        jobType="ocr"
        state="running"
        animate={false}
      />,
    );
    expect(pulses(screen.getByTitle("OCR"))).toBe(false);
  });
});
