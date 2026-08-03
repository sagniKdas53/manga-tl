package com.manga.library.service;

import com.manga.library.model.Image;
import com.manga.library.repository.ImageRepository;
import java.io.InputStream;
import java.util.Iterator;
import java.util.List;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

/**
 * Backfills {@code images.width} / {@code images.height} for rows written before those values were
 * captured at upload.
 *
 * <p>They cannot be derived in SQL, so this reads each object's header. Only the header — {@link
 * ImageReader#getWidth} does not decode pixel data, so the cost is roughly one ranged read per
 * image rather than a full download.
 *
 * <p>Idempotent and self-retiring: it selects only rows that are still null, so once the backlog is
 * cleared it does nothing on subsequent boots and can be deleted. It deliberately does not take
 * {@code PageService.WEBP_LOCK} — it runs single-threaded on one background thread, and is the only
 * thing decoding at that point.
 */
@Component
public class ImageDimensionBackfill {

  private static final Logger log = LoggerFactory.getLogger(ImageDimensionBackfill.class);

  private final ImageRepository imageRepository;
  private final MinioService minioService;

  public ImageDimensionBackfill(ImageRepository imageRepository, MinioService minioService) {
    this.imageRepository = imageRepository;
    this.minioService = minioService;
  }

  @Async("thumbnailExecutor")
  @EventListener(ApplicationReadyEvent.class)
  public void backfill() {
    List<Image> pending;
    try {
      pending = imageRepository.findByWidthIsNullOrHeightIsNull();
    } catch (RuntimeException e) {
      log.warn("Image dimension backfill could not query for pending rows", e);
      return;
    }
    if (pending.isEmpty()) {
      return;
    }

    log.info("Backfilling dimensions for {} image(s) with no recorded size", pending.size());
    int done = 0;
    int failed = 0;
    for (Image image : pending) {
      try {
        if (readAndApplyDimensions(image)) {
          done++;
        } else {
          failed++;
        }
      } catch (RuntimeException e) {
        failed++;
        log.debug("Dimension backfill failed for image {}", image.getId(), e);
      }
    }
    log.info("Image dimension backfill complete: {} updated, {} skipped", done, failed);
  }

  private boolean readAndApplyDimensions(Image image) {
    String path = image.getStoragePath();
    if (path == null || path.isBlank()) {
      return false;
    }
    try (InputStream in = minioService.getFileStream(path);
        ImageInputStream iis = ImageIO.createImageInputStream(in)) {
      if (iis == null) {
        return false;
      }
      Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
      if (!readers.hasNext()) {
        return false;
      }
      ImageReader reader = readers.next();
      try {
        reader.setInput(iis, true, true);
        int width = reader.getWidth(0);
        int height = reader.getHeight(0);
        if (width <= 0 || height <= 0) {
          return false;
        }
        image.setWidth(width);
        image.setHeight(height);
        imageRepository.save(image);
        return true;
      } finally {
        reader.dispose();
      }
    } catch (Exception e) {
      log.debug("Could not read dimensions for image {} at {}", image.getId(), path, e);
      return false;
    }
  }
}
