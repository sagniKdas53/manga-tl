import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useReviewTally } from "../../hooks/useReviewTally";
import { regionIssue, type RegionIssue } from "../../utils/regionIssues";
import type { OcrRegion } from "../../types";

const region = (id: string, order: number) =>
  ({
    id,
    text: `source ${order}`,
    bubbleReadingOrder: order,
    bboxX: 0,
    bboxY: 0,
    bboxW: 10,
    bboxH: 10,
    detectedLanguage: "ja",
  }) as unknown as OcrRegion;

const issueOf = (id: string, order: number) =>
  regionIssue(region(id, order), undefined, false)!;

type Props = {
  pageId: string;
  issues: RegionIssue[];
  regionIds: Set<string>;
  reviewable: boolean;
};

const setup = (initial: Props) =>
  renderHook((props: Props) => useReviewTally(props), {
    initialProps: initial,
  });

describe("useReviewTally", () => {
  const a = issueOf("a", 1);
  const b = issueOf("b", 2);
  const both = new Set(["a", "b"]);

  it("ticks off an issue that goes away while its region stays", () => {
    const { result, rerender } = setup({
      pageId: "p1",
      issues: [a, b],
      regionIds: both,
      reviewable: true,
    });
    expect(result.current.openCount).toBe(2);
    rerender({ pageId: "p1", issues: [b], regionIds: both, reviewable: true });
    expect(
      result.current.rows.map((r) => [r.issue.region.id, r.settled]),
    ).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("drops, not ticks, an issue whose region was replaced without an action", () => {
    // Redo page OCR: every region id changes.
    const { result, rerender } = setup({
      pageId: "p1",
      issues: [a, b],
      regionIds: both,
      reviewable: true,
    });
    rerender({
      pageId: "p1",
      issues: [],
      regionIds: new Set(["x", "y"]),
      reviewable: true,
    });
    expect(result.current.rows).toEqual([]);
    expect(result.current.settledCount).toBe(0);
  });

  it("ticks off a region the user deleted", () => {
    const { result, rerender } = setup({
      pageId: "p1",
      issues: [a, b],
      regionIds: both,
      reviewable: true,
    });
    act(() => result.current.markActedOn("a"));
    rerender({
      pageId: "p1",
      issues: [b],
      regionIds: new Set(["b"]),
      reviewable: true,
    });
    expect(result.current.settledCount).toBe(1);
  });

  it("freezes while no translation layer is shown, rather than counting all as settled", () => {
    const { result, rerender } = setup({
      pageId: "p1",
      issues: [a, b],
      regionIds: both,
      reviewable: true,
    });
    rerender({ pageId: "p1", issues: [], regionIds: both, reviewable: false });
    expect(result.current.rows).toEqual([]);
    rerender({
      pageId: "p1",
      issues: [a, b],
      regionIds: both,
      reviewable: true,
    });
    expect(result.current.openCount).toBe(2);
    expect(result.current.settledCount).toBe(0);
  });

  it("starts over on a new page", () => {
    const { result, rerender } = setup({
      pageId: "p1",
      issues: [a, b],
      regionIds: both,
      reviewable: true,
    });
    rerender({ pageId: "p1", issues: [b], regionIds: both, reviewable: true });
    rerender({
      pageId: "p2",
      issues: [],
      regionIds: new Set(),
      reviewable: true,
    });
    expect(result.current.rows).toEqual([]);
  });
});
