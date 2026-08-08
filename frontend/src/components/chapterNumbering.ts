import type { Chapter } from "../types";
import { safeFetch } from "../utils";

/**
 * The highest `chapterNumber` in a series, asked of the server rather than inferred.
 *
 * The chapter list is paginated at 15, so `Math.max` over the loaded array is a max over
 * the *first page*, not the series. On a series of 18 that suggests 15 for the next chapter
 * — a number that already exists.
 *
 * Two things rule out the cheaper shortcuts. `totalElements` is not the answer: chapter
 * numbers are fractional (a `0.5` interlude is normal), so a series of 18 chapters can top
 * out at 17. And the loaded prefix only happens to be right when the list is sorted
 * descending, which is a user preference, not an invariant.
 *
 * One page of one row, ordered descending, is the whole query.
 */
export const fetchHighestChapterNumber = async (
  seriesId: string,
  token: string,
): Promise<number | null> => {
  const res = await safeFetch(
    `/api/series/${seriesId}/chapters?page=0&size=1&sortDir=desc`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;

  const data = (await res.json()) as { content?: Chapter[] };
  const highest = data.content?.[0]?.chapterNumber;
  return typeof highest === "number" ? highest : null;
};

/**
 * Place a chapter in a list that is ordered by the server, honouring the active direction.
 *
 * Appending unconditionally is what put a new chapter at the bottom of a descending list.
 * Replaces by id when the chapter is already present so an edit does not duplicate it.
 */
export const insertChapterInOrder = (
  chapters: Chapter[],
  incoming: Chapter,
  sortAsc: boolean,
): Chapter[] => {
  const without = chapters.filter((c) => c.id !== incoming.id);
  const index = without.findIndex((c) =>
    sortAsc
      ? c.chapterNumber > incoming.chapterNumber
      : c.chapterNumber < incoming.chapterNumber,
  );
  if (index === -1) return [...without, incoming];
  return [...without.slice(0, index), incoming, ...without.slice(index)];
};
