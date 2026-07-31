# WebP Thumbnail Encoding

This document records why the backend uses its current WebP stack — `com.github.gotson:webp-imageio`
over the JVM's own libwebp — and the benchmark data comparing the Alpine/musl deployment against a
non-Alpine/glibc one.

## Why this approach

### Codec choice

The backend generates 512px-wide WebP thumbnails asynchronously in
`PageService.generateAndSaveThumbnailAsync` (`backend/src/main/java/com/manga/library/service/PageService.java:208`).

- `com.github.gotson:webp-imageio:0.2.2` is the actively maintained fork of the abandoned
  `org.sejda.imageio:webp-imageio`. The sejda 0.1.6 native decoder could SIGSEGV the JVM
  (`UpsampleBgraLinePair_SSE2`) on certain WebP inputs and under concurrent thumbnail generation.
  The fork ships newer libwebp with those crash fixes, and exposes the same ImageIO SPI, so registry
  usage (`ImageIO.getImageReaders` / `getImageWritersByFormatName`) is unaffected.
- The alternative — Pillow (Python) — was used by `scripts/migrate_thumbnails.py` for the one-off
  backfill of the 514 pre-existing thumbnails. It is not used at runtime because the Java service owns
  the upload path and generating thumbnails in-process avoids a cross-language hop.
- WebP beats JPEG for manga: same quality at a fraction of the file size, and lossless support. PNG
  thumbnails were tried earlier and dropped for size.

### musl / Alpine native build

`webp-imageio` 0.2.2 only bundles **glibc** native builds (`native/Linux/<arch>/libwebp-imageio.so`).
The runtime image is `eclipse-temurin:25-jre-alpine` (musl), so `NativeLoader`/`OSInfo` looks for
`native/Linux-Alpine/x86_64/...`, fails, falls back to `java.library.path` — which has no copy — and
throws `java.lang.UnsatisfiedLinkError` at the first `writer.getDefaultWriteParam()` call. Because that
is an `Error`, not an `Exception`, it escaped the thumbnail generator's catch block, leaving every
uploaded image without a thumbnail (404 on `/api/images/{id}/thumbnail`).

The fix (see the webp-native-build stage in `backend/Dockerfile`):

1. A build stage compiles the vendored wrapper (`backend/src/main/c/webp-imageio.c`, copied from the
   gotson/webp-imageio `maven-central` branch) against Alpine's musl `libwebp-dev` into
   `libwebp-imageio.so`.
2. The runtime stage installs `libwebp` (`libwebp.so.7`, a runtime dependency of the wrapper) and
   copies the `.so` to `/usr/lib/libwebp-imageio.so` so it lands on `java.library.path`.
3. `PageService` now catches `Error` alongside `IOException | RuntimeException | MinioException` so any
   future native-load failure is logged with context instead of escaping to the async uncaught handler.

The sejda 0.1.6 `.so` had the same glibc-only limitation, so Java-side thumbnailing never worked in the
Alpine container — the musl wrapper is a genuine functional fix, not just a performance choice.

## Benchmark: musl (Alpine) vs glibc (non-Alpine)

Both runs execute the same `webp-imageio-0.2.2.jar`; only the JNI `libwebp-imageio.so` differs.

| | glibc (non-Alpine) | musl (Alpine) |
| --- | --- | --- |
| Native lib | Bundled `native/Linux/x86_64/libwebp-imageio.so` (707 KB, statically linked libwebp ~1.2, built 2021) | 31 KB wrapper, dynamically links Alpine libwebp 1.6.0 (`libwebp.so.7`) |
| JVM | Temurin 25 (host, glibc) | `eclipse-temurin:25-jre-alpine` |

Method: interleaved runs on the same host, 30 iterations each, 320×512 source at q0.85, JNI lib already
warm (3 warmup iterations).

| Metric | glibc | musl |
| --- | --- | --- |
| Pure WebP encode | 42.5 ms/op (40.6 / 44.5 / 42.6) | 43.8 ms/op (40.6 / 45.8 / 44.9) |
| Full resize+encode pipeline (2000×3200 source) | ~95 ms (85 / 106) | ~90 ms (89 / 91) |
| Output size @ q0.85 | 28,522 B | 28,576 B |

**Verdict: statistically identical.** Differences are within run-to-run noise. The wrapper is a thin JNI
shim — the real work is libwebp either way, and Alpine's newer libwebp (1.6.0) encodes slightly better
per byte (0.2% smaller at the same quality). Switching away from Alpine would buy no performance.

### Where the real latency lives

The encoder is not the bottleneck. The 2000×3200 full-pipeline numbers (~90 ms) vs pure encode
(~44 ms) show most of the time is spent in the resize step:

- `getScaledInstance(targetWidth, targetHeight, Image.SCALE_SMOOTH)` (`PageService.java:249`) is a slow
  AWT scaling path; a `Graphics2D` LANCZOS draw fitted to aspect ratio is faster and yields smaller files.
- `synchronized (WEBP_LOCK)` (`PageService.java:215` and `:260`) wraps both decode and encode, so the
  4-thread `thumbnailExecutor` still processes thumbnails one at a time globally. Throughput is bounded
  by the lock, not CPU.

## Misc observations

- The thumbnail serve endpoint and the `/file` endpoint now derive `Content-Type` from the stored
  object path's extension (`resolveImageContentType` in `PageController.java`), so WebP thumbnails are
  served as `image/webp` instead of the previous hardcoded `image/jpeg`/`image/png`.
- The thumbnail path is pure MinIO passthrough (no decode/re-encode on read), so serving costs are just
  object storage I/O.
