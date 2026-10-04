import type { Notification } from "../components/useNotifications";

/**
 * The queue's Done tab: pages that finished this session, read off the notifications the app
 * already keeps (reader review, 2026-10-04: "just add completed here").
 *
 * The notifications are the source because they are held at the app root for the whole
 * session, while the queue drawer unmounts whenever the Reader is open.
 *
 * Only notifications that end a page's run count (FINAL_TITLES). The backend also sends page
 * warnings mid-run, "Cleanup Review Required" and "No Translatable Text", and listing those
 * would put a page under Done while it is still being worked on.
 */

/**
 * The titles that end a page's run, as the backend sends them: QA's callback outcomes
 * (backend-rust/src/routes/internal.rs) and the failed re-render after a QA correction.
 * The queue already keys off "Page Processing Complete" the same way.
 */
const FINAL_TITLES = new Set([
  "Page Processing Complete",
  "Processing Complete, QA Skipped",
  "QA Incomplete — Review Needed",
  "Processing Finished With QA Failures",
  "Manual Review Needed",
  "QA Failed",
  "Re-render Failed",
]);

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
  // Evict the oldest (a Map iterates in insertion order), so recent rows keep their links.
  if (linkByImage.size >= MAX_LINKS && !linkByImage.has(imageId)) {
    const oldest = linkByImage.keys().next().value;
    if (oldest !== undefined) linkByImage.delete(oldest);
  }
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
    if (!n.imageId || !FINAL_TITLES.has(n.title)) continue;
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
