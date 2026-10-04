import { useCallback, useMemo, useState } from "react";
import type { RegionIssue } from "../utils/regionIssues";

export interface ReviewRow {
  issue: RegionIssue;
  settled: boolean;
}

interface Tally {
  pageId: string | null;
  /** Every issue seen on this page, by region id: the latest copy while it was open. */
  seen: Map<string, RegionIssue>;
  /** Regions the user settled with a review action, typed text or a redo. */
  actedOn: Set<string>;
}

const freshTally = (
  pageId: string | null,
  issues: RegionIssue[],
  reviewable: boolean,
): Tally => ({
  pageId,
  seen: new Map(reviewable ? issues.map((i) => [i.region.id, i]) : []),
  actedOn: new Set(),
});

/**
 * The page's review progress: every issue seen on this page so far, and which of them are
 * settled.
 *
 * Lives in the Reader, not the Review tab, because the tab unmounts whenever an issue is opened
 * in the inspector, which is exactly where issues get settled (reader review, 2026-10-04).
 *
 * "Settled" is kept honest in two cases that would otherwise inflate it:
 * - Hiding every translation layer empties the issue list. `reviewable` is false then, and the
 *   tally is frozen rather than read as everything fixed.
 * - Redo page OCR replaces every region. A seen issue whose region is gone counts as settled
 *   only if the user acted on it (Delete region may remove it); otherwise its row is dropped.
 */
export function useReviewTally({
  pageId,
  issues,
  regionIds,
  reviewable,
}: {
  pageId: string | null;
  issues: RegionIssue[];
  regionIds: Set<string>;
  reviewable: boolean;
}): {
  rows: ReviewRow[];
  openCount: number;
  settledCount: number;
  markActedOn: (regionId: string) => void;
} {
  const [tally, setTally] = useState<Tally>(() =>
    freshTally(pageId, issues, reviewable),
  );

  // Adjusted during render (React's pattern for state that follows props), so the tally is
  // never a frame behind the list. Only a new page or a newly seen region updates it; issue
  // objects are rebuilt on every layer change and comparing them would re-render the Reader.
  if (tally.pageId !== pageId) {
    setTally(freshTally(pageId, issues, reviewable));
  } else if (
    reviewable &&
    issues.some((issue) => !tally.seen.has(issue.region.id))
  ) {
    const seen = new Map(tally.seen);
    issues.forEach((issue) => {
      if (!seen.has(issue.region.id)) seen.set(issue.region.id, issue);
    });
    setTally({ ...tally, seen });
  }

  const markActedOn = useCallback((regionId: string) => {
    setTally((current) =>
      current.actedOn.has(regionId)
        ? current
        : { ...current, actedOn: new Set(current.actedOn).add(regionId) },
    );
  }, []);

  const rows = useMemo(() => {
    if (!reviewable) return [];
    const open = new Map(issues.map((issue) => [issue.region.id, issue]));
    const result: ReviewRow[] = [];
    tally.seen.forEach((stored, regionId) => {
      const current = open.get(regionId);
      if (current) result.push({ issue: current, settled: false });
      else if (regionIds.has(regionId) || tally.actedOn.has(regionId))
        result.push({ issue: stored, settled: true });
    });
    return result.sort(
      (a, b) =>
        (a.issue.region.bubbleReadingOrder ?? Infinity) -
        (b.issue.region.bubbleReadingOrder ?? Infinity),
    );
  }, [tally, issues, regionIds, reviewable]);

  const openCount = rows.filter((row) => !row.settled).length;
  return {
    rows,
    openCount,
    settledCount: rows.length - openCount,
    markActedOn,
  };
}
