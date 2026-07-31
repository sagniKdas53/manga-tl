import React, { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";

interface LazyImageProps extends Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  "src"
> {
  src?: string | null;
  sx?: SxProps<Theme>;
}

/** Defers thumbnail network requests until an image is close to the viewport. */
const LazyImage: React.FC<LazyImageProps> = ({ src, sx, alt, ...props }) => {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(
    () => typeof IntersectionObserver === "undefined",
  );

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

  return (
    <Box
      {...props}
      ref={imageRef}
      component="img"
      alt={alt}
      src={shouldLoad && src ? src : undefined}
      loading="lazy"
      decoding="async"
      sx={sx}
    />
  );
};

export default LazyImage;
