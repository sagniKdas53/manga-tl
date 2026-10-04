import { beforeEach, describe, expect, it } from "vitest";
import {
  finishedPages,
  forgetPageLinks,
  rememberPageLink,
} from "../../utils/finishedPages";
import type { Notification } from "../../components/useNotifications";

const note = (
  id: string,
  imageId: string | undefined,
  type: string,
  title: string,
  timestamp: number,
  context: Notification["context"] = {
    seriesTitle: "4Oct",
    chapterNumber: "1",
    chapterTitle: "Test",
    pageNumber: "7",
  },
): Notification =>
  ({
    id,
    imageId,
    type,
    title,
    message: "",
    timestamp,
    read: false,
    context,
  }) as Notification;

describe("finishedPages", () => {
  beforeEach(() => forgetPageLinks());

  it("keeps each page's newest outcome, and leaves exports out", () => {
    const rows = finishedPages([
      note("n3", "img1", "WARNING", "Manual Review Needed", 3000),
      note("n2", undefined, "EXPORT_SUCCESS", "Export Ready", 2000),
      note("n1", "img1", "SUCCESS", "Page Processing Complete", 1000),
      note("n0", "img2", "ERROR", "QA Failed", 500),
    ]);
    expect(rows.map((r) => [r.imageId, r.outcome, r.title])).toEqual([
      ["img1", "review", "Manual Review Needed"],
      ["img2", "failed", "QA Failed"],
    ]);
    expect(rows[0].chapterLabel).toBe("4Oct › Test (Ch.1)");
    expect(rows[0].pageLabel).toBe("Page 7");
  });

  it("links a page to the Reader only when its chapter is known", () => {
    rememberPageLink("img1", "ch-1", 7);
    rememberPageLink("img2", undefined, 3);
    const rows = finishedPages([
      note("a", "img1", "SUCCESS", "Page Processing Complete", 2),
      note("b", "img2", "SUCCESS", "Page Processing Complete", 1),
    ]);
    expect(rows[0].link).toEqual({ chapterId: "ch-1", pageNumber: 7 });
    expect(rows[1].link).toBeNull();
  });
});
