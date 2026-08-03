package com.manga.library.service;

import com.manga.library.model.Image;
import com.manga.library.repository.ImageRepository;
import java.io.InputStream;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

/**
 * Generates the WebP reading variant for rows uploaded before variants existed.
 *
 * <p>Unlike {@link ImageDimensionBackfill} this cannot read headers only — it has to download,
 * decode and re-encode each original in full. Measured on this corpus that is roughly 1 s per
 * image at q90, so ~12 minutes for 743 images, all on one background thread.
 *
 * <p>Idempotent and self-retiring: it selects only rows whose {@code readerStoragePath} is still
 * null. Images that legitimately get no variant are recorded pointing at their original rather
 * than left null, so they are not retried on the next boot.
 *
 * <p>Runs single-threaded, so it does not contend for {@code PageService.WEBP_LOCK} beyond the one
 * encode at a time it performs itself.
 */
@Component
public class ReaderVariantBackfill {

  private static final Logger log = LoggerFactory.getLogger(ReaderVariantBackfill.class);

  private final ImageRepository imageRepository;
  private final MinioService minioService;
  private final PageService pageService;

  public ReaderVariantBackfill(
      ImageRepository imageRepository, MinioService minioService, PageService pageService) {
    this.imageRepository = imageRepository;
    this.minioService = minioService;
    this.pageService = pageService;
  }

  @Async("thumbnailExecutor")
  @EventListener(ApplicationReadyEvent.class)
  public void backfill() {
    List<Image> pending;
    try {
      pending = imageRepository.findByReaderStoragePathIsNull();
    } catch (RuntimeException e) {
      log.warn("Reader variant backfill could not query for pending rows", e);
      return;
    }
    if (pending.isEmpty()) {
      return;
    }

    log.info("Backfilling reader variants for {} image(s)", pending.size());
    long startedAt = System.currentTimeMillis();
    int done = 0;
    int failed = 0;
    for (Image image : pending) {
      try {
        if (generateFor(image)) {
          done++;
        } else {
          failed++;
        }
      } catch (RuntimeException e) {
        failed++;
        log.debug("Reader variant backfill failed for image {}", image.getId(), e);
      }
    }
    log.info(
        "Reader variant backfill complete: {} processed, {} skipped, {} s",
        done,
        failed,
        (System.currentTimeMillis() - startedAt) / 1000);
  }

  private boolean generateFor(Image image) {
    String path = image.getStoragePath();
    if (path == null || path.isBlank()) {
      return false;
    }
    byte[] original;
    try (InputStream in = minioService.getFileStream(path)) {
      original = in.readAllBytes();
    } catch (Exception e) {
      log.debug("Could not read original for image {} at {}", image.getId(), path, e);
      return false;
    }
    // The stored object name carries the uuid the variant should be keyed by, so the backfill
    // and the upload path agree on where a variant lives.
    String uuid = baseName(path);
    pageService.generateAndSaveReaderVariant(image.getId(), uuid, original);
    return true;
  }

  /** "originals/<uuid>.jpg" -> "<uuid>". */
  private static String baseName(String path) {
    String name = path.substring(path.lastIndexOf('/') + 1);
    int dot = name.lastIndexOf('.');
    return dot == -1 ? name : name.substring(0, dot);
  }
}
