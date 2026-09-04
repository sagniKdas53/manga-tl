import React, { useEffect, useRef } from "react";
import { useNotifications } from "./useNotifications";

/**
 * Re-reads the grids when the pipeline finishes work on them.
 *
 * AUDIT-F19. Every grid rendered whatever its first fetch returned and nothing ever asked again:
 * no subscription, no background poll. A chapter that finished translating while its page was open
 * kept showing untranslated thumbnails, and the chapter and series cards kept their old counts and
 * statuses, until the user reloaded by hand.
 *
 * This lives in its own component, like `TranslationToastWatcher`, because the pagination hooks are
 * created *outside* `NotificationProvider` and so cannot call `useNotifications` themselves.
 *
 * `refresh` (not `reload`) is what the callers pass: it re-fetches the batches already loaded and
 * swaps them in place, so a grid the user has scrolled halfway down does not jump back to the top
 * or flash empty every time a page finishes.
 */

/** How long to wait for a burst to settle before re-reading. */
const COALESCE_MS = 4000;

/**
 * The floor on how often a re-read may actually happen.
 *
 * AUDIT-F27. `COALESCE_MS` alone assumes completions arrive close together, and for a burst they
 * do. But `AUDIT-W13` deliberately made a context-injecting chapter translate strictly in page
 * order, so its completions are now *serialized* and land tens of seconds apart — further apart
 * than the coalesce window. Every one of them then settled its own timer and fired its own
 * refresh, and `refresh()` re-requests every loaded pagination batch. A long chapter turned into
 * one full loaded-window re-read per page for the length of the run, which is precisely the
 * hammering the debounce existed to prevent.
 *
 * Debouncing cannot fix that on its own: no settle window is both short enough to feel live during
 * a burst and longer than the gap between serialized pages. So the two limits are separate. The
 * burst still collapses on the 4s window, and on top of that no re-read may follow another inside
 * this interval — a slow drip coalesces into one refresh per interval instead of one per page.
 *
 * Nothing is dropped. A completion that arrives inside the cooldown leaves the timer armed for the
 * remainder, so the last page of a chapter is always followed by a re-read.
 */
const MIN_REFRESH_INTERVAL_MS = 30000;

export interface PipelineRefreshWatcherProps {
  /** Called after a burst of job activity settles. Should be `usePaginatedResource.refresh`. */
  onPipelineActivity: () => void;
}

const PipelineRefreshWatcher: React.FC<PipelineRefreshWatcherProps> = ({
  onPipelineActivity,
}) => {
  const { subscribe } = useNotifications();
  const callbackRef = useRef(onPipelineActivity);
  useEffect(() => {
    callbackRef.current = onPipelineActivity;
  }, [onPipelineActivity]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Epoch, so the first completion after mount refreshes immediately rather than serving out a
    // cooldown it was never part of.
    let lastRefreshAt = 0;

    // Runs when the burst window expires. Either the cooldown has passed and we re-read, or it has
    // not and we re-arm for whatever is left of it and ask again then.
    const settle = () => {
      timer = null;
      const waited = Date.now() - lastRefreshAt;
      if (waited >= MIN_REFRESH_INTERVAL_MS) {
        lastRefreshAt = Date.now();
        callbackRef.current();
        return;
      }
      timer = setTimeout(settle, MIN_REFRESH_INTERVAL_MS - waited);
    };

    const unsubscribe = subscribe((event) => {
      // A chapter run emits hundreds of these — one per stage per page. Refreshing on each would
      // put the grid's whole loaded window back on the wire dozens of times a minute for no extra
      // information, so a burst collapses into one read once it goes quiet.
      if (event.type !== "job_update") return;
      let status: string | undefined;
      try {
        status = JSON.parse(event.data)?.status;
      } catch {
        return;
      }
      if (status !== "COMPLETED" && status !== "FAILED") return;

      if (timer) clearTimeout(timer);
      timer = setTimeout(settle, COALESCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe]);

  return null;
};

export default PipelineRefreshWatcher;
