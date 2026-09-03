import React, { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";

interface LazyImageProps extends Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  "src" | "onError"
> {
  src?: string | null;
  sx?: SxProps<Theme>;
  /** Max retry attempts when loading fails (e.g. thumbnail not generated yet). */
  maxRetries?: number;
  /** Base delay before the first retry; doubles on each subsequent attempt. */
  retryBaseDelayMs?: number;
  /**
   * Called on every failed load, including attempts this component will go on to retry.
   * Re-declared because the base img attributes are `Omit`ted above so the retry handler can
   * own the DOM `onError`.
   */
  onError?: React.ReactEventHandler<HTMLImageElement>;
}

interface RetryState {
  src: string | null;
  attempts: number;
}

/** Defers thumbnail network requests until an image is close to the viewport. */
const LazyImage: React.FC<LazyImageProps> = ({
  src,
  sx,
  alt,
  maxRetries = 5,
  retryBaseDelayMs = 400,
  onError,
  ...props
}) => {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const [retryState, setRetryState] = useState<RetryState>({
    src: src ?? null,
    attempts: 0,
  });
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Give a changed src a fresh retry budget. Adjusting state during render is
  // the idiomatic React pattern for resetting derived state on prop change.
  if (retryState.src !== (src ?? null)) {
    setRetryState({ src: src ?? null, attempts: 0 });
  }

  useEffect(() => {
    if (!src || shouldLoad) return;

    const image = imageRef.current;
    if (!image) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );

    observer.observe(image);
    return () => observer.disconnect();
  }, [src, shouldLoad]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const handleError: React.ReactEventHandler<HTMLImageElement> = useCallback(
    (event) => {
      onError?.(event);
      if (retryState.attempts >= maxRetries) return;
      const delay = retryBaseDelayMs * 2 ** retryState.attempts;
      retryTimerRef.current = setTimeout(() => {
        // Only bump the budget if this src is still the one currently rendered;
        // otherwise the timer belongs to a stale, replaced image.
        setRetryState((s) =>
          s.src !== src ? s : { ...s, attempts: s.attempts + 1 },
        );
      }, delay);
    },
    [onError, retryState.attempts, maxRetries, retryBaseDelayMs, src],
  );

  // A failed <img> request is not re-issued for the same src in all browsers,
  // so append a cache-busting query param on each retry to force a refetch.
  const retrySrc =
    src && retryState.attempts > 0
      ? `${src}${src.includes("?") ? "&" : "?"}retry=${retryState.attempts}`
      : src;

  return (
    <Box
      {...props}
      ref={imageRef}
      component="img"
      alt={alt}
      src={shouldLoad && retrySrc ? retrySrc : undefined}
      onError={handleError}
      loading="lazy"
      decoding="async"
      sx={sx}
    />
  );
};

export default LazyImage;
