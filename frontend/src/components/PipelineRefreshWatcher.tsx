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
      timer = setTimeout(() => {
        timer = null;
        callbackRef.current();
      }, COALESCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [subscribe]);

  return null;
};

export default PipelineRefreshWatcher;
