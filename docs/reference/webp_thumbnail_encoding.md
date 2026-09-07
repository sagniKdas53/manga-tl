# WebP Thumbnail Encoding

This document describes thumbnail generation in the Rust backend (`backend-rust/src/thumbnails.rs`) and how original and rendered thumbnails are served to clients.

## Architecture

The Rust rewrite replaced the JVM ImageIO + `webp-imageio` stack with native Rust libraries (`image` and `webp` crates).

### Key Characteristics

1. **Native libwebp compilation**: The `webp` crate compiles and statically links libwebp via Cargo. The multi-stage Docker build for Alpine musl JNI libraries is eliminated.
2. **Concurrent generation**: Unlike the Java service, which serialized WebP writes behind a global lock, Rust's `thumbnails::generate_thumbnail` is thread-safe and executes across Tokio `spawn_blocking` pools without serialization bottlenecks.
3. **Dimensions and Quality**:
   - Target width: 512px (`THUMBNAIL_WIDTH = 512`), preserving aspect ratio for height.
   - Quality: 85.0 (`THUMBNAIL_QUALITY = 85.0`, equivalent to 0.85 lossy compression).
   - Pixel format: Opaque RGB8 buffer (`image.to_rgb8()`), since manga page thumbnails do not require alpha transparency.

## Endpoints and Serving

### 1. Source Page Thumbnails

- **Route**: `GET /api/images/{id}/thumbnail`
- **Storage**: Generated asynchronously during image upload and stored in MinIO (`thumbnails/{hash}.webp`).
- **Response**: Passthrough streaming from object storage with `Content-Type: image/webp`.

### 2. Rendered Page Thumbnails (`AUDIT-F26`)

- **Route**: `GET /api/pages/{id}/rendered/thumbnail`
- **Purpose**: Provides a lightweight 512px thumbnail of the final rendered translation PNG (~1.7MB full-size vs ~30KB WebP).
- **Generation**:
  - Eager: Generated on worker completion callback when `status == COMPLETED` for a render stage.
  - Lazy: If missing on request, the backend fetches the rendered image from storage, encodes the 512px WebP, stores it, and serves it.
- **Cache-Busting**: `PageDto` exposes `renderedThumbnailUrl` suffixed with `?v=<timestamp>` based on `lastRenderedAt`. The frontend uses this to display completion markers and updated thumbnails in the gallery grid without full-page reloads.
