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
});
