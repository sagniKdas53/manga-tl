import type { Notification } from "../components/useNotifications";

/**
 * The queue's Done tab: pages that finished this session, read off the notifications the app
 * already keeps (reader review, 2026-10-04: "just add completed here").
 *
 * The notifications are the source because they are held at the app root for the whole
 * session, while the queue drawer unmounts whenever the Reader is open. A page's last
 * notification says how it ended: Page Processing Complete, or one of QA's warnings (review
 * needed, QA failures, manual review), or QA Failed. Export notifications are not pages.
 */

export interface PageLink {
  chapterId: string;
  pageNumber: number;
}

/**
 * Where each image sits, learned from the job payloads the queue has seen. Notifications carry
 * the series, chapter and page labels but not the chapter's id, so a row can only link to the
 * Reader when the queue saw one of the page's jobs. Session-wide, like the notifications.
 */
const linkByImage = new Map<string, PageLink>();
const MAX_LINKS = 2000;

export const rememberPageLink = (
  imageId: string | undefined,
  chapterId: unknown,
  pageNumber: unknown,
) => {
  if (!imageId || typeof chapterId !== "string" || !chapterId) return;
  const page = Number(pageNumber);
  if (!Number.isInteger(page) || page < 1) return;
  if (linkByImage.size >= MAX_LINKS) linkByImage.clear();
  linkByImage.set(imageId, { chapterId, pageNumber: page });
};

/** For tests: forget every remembered link. */
export const forgetPageLinks = () => linkByImage.clear();

export type PageOutcome = "done" | "review" | "failed";

export interface FinishedPage {
  /** The notification's id; also the row key. */
  id: string;
  imageId: string;
  outcome: PageOutcome;
  /** What the last notification said, e.g. "Manual Review Needed". */
  title: string;
  chapterLabel: string | null;
  pageLabel: string;
  /** Epoch milliseconds. */
  at: number;
  link: PageLink | null;
}

const outcomeOf = (type: string): PageOutcome =>
  type === "WARNING" ? "review" : type === "ERROR" ? "failed" : "done";

const chapterLabelOf = (n: Notification): string | null => {
  const c = n.context;
  if (!c) return null;
  const parts: string[] = [];
  if (c.seriesTitle) parts.push(c.seriesTitle);
  if (c.chapterTitle && c.chapterNumber)
    parts.push(`${c.chapterTitle} (Ch.${c.chapterNumber})`);
  else if (c.chapterNumber) parts.push(`Ch.${c.chapterNumber}`);
  return parts.length ? parts.join(" › ") : null;
};

/** One row per page, newest first, from notifications that are themselves newest first. */
export const finishedPages = (
  notifications: Notification[],
): FinishedPage[] => {
  const seen = new Set<string>();
  const rows: FinishedPage[] = [];
  for (const n of notifications) {
    if (!n.imageId || String(n.type).startsWith("EXPORT")) continue;
    if (seen.has(n.imageId)) continue;
    seen.add(n.imageId);
    rows.push({
      id: n.id,
      imageId: n.imageId,
      outcome: outcomeOf(String(n.type)),
      title: n.title,
      chapterLabel: chapterLabelOf(n),
      pageLabel: n.context?.pageNumber
        ? `Page ${n.context.pageNumber}`
        : "Page",
      at: Number(n.timestamp),
      link: linkByImage.get(n.imageId) ?? null,
    });
  }
  return rows;
};
