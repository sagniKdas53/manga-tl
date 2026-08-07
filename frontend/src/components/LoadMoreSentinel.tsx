import React, { useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";

interface LoadMoreSentinelProps {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
}

/**
 * Dropped at the end of an infinite-scroll grid/list. Modeled on `LazyImage.tsx`'s
 * `IntersectionObserver` trigger, but unlike a lazy image (which loads once and is done)
 * this has to keep firing as the user keeps scrolling, so the observer is never
 * disconnected after a single hit. `onLoadMore` is read through a ref so the observer
 * doesn't need to be torn down and recreated every time the callback identity changes —
 * `usePaginatedResource`'s `loadMore` itself dedupes redundant calls, so firing on every
 * intersection is safe.
 */
const LoadMoreSentinel: React.FC<LoadMoreSentinelProps> = ({
  hasMore,
  isLoading,
  onLoadMore,
}) => {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { rootMargin: "300px 0px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore]);

  if (!hasMore) return null;

  return (
    <Box
      ref={sentinelRef}
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        width: "100%",
        py: 3,
      }}
    >
      {isLoading && <CircularProgress size={24} />}
    </Box>
  );
};

export default LoadMoreSentinel;
