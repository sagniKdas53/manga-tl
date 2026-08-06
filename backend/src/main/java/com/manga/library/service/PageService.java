package com.manga.library.service;

import com.manga.library.model.*;
import com.manga.library.repository.*;
import io.minio.errors.MinioException;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PageService {
  private static final Logger log = LoggerFactory.getLogger(PageService.class);

  // Serializes access to the WebP native codec (webp-imageio). The JNI library is not safe to
  // call concurrently from multiple threads; a racing call can SIGSEGV the whole JVM.
  //
  // The lock is now genuinely scoped to WebP work only -- every WebP *write*, and a *read* just
  // when the chosen ImageReader is the native WebP one. Until AUDIT-B6 the comment claimed this
  // while the code held the lock across the decode of every format, serialising the whole
  // four-thread thumbnailExecutor. The built-in JPEG/PNG/BMP codecs are thread-safe and run in
  // parallel again.
  private static final Object WEBP_LOCK = new Object();
  private final ImageRepository imageRepository;
  private final PageRepository pageRepository;
  private final SeriesRepository seriesRepository;
  private final ChapterRepository chapterRepository;
  private final MinioService minioService;
  private final LayerRepository layerRepository;
  private final LayerElementRepository layerElementRepository;
  private final OcrRegionRepository ocrRegionRepository;

  public PageService(
      ImageRepository imageRepository,
      PageRepository pageRepository,
      SeriesRepository seriesRepository,
      ChapterRepository chapterRepository,
      MinioService minioService,
      LayerRepository layerRepository,
      LayerElementRepository layerElementRepository,
      OcrRegionRepository ocrRegionRepository) {
    this.imageRepository = imageRepository;
    this.pageRepository = pageRepository;
    this.seriesRepository = seriesRepository;
    this.chapterRepository = chapterRepository;
    this.minioService = minioService;
    this.layerRepository = layerRepository;
    this.layerElementRepository = layerElementRepository;
    this.ocrRegionRepository = ocrRegionRepository;
  }

  @Transactional
  public Page createPageAndImage(
      Chapter chapter,
      String filename,
      String storagePath,
      String thumbnailStoragePath,
      Integer pageNumber,
      String hash,
      User user) {
    List<Page> existingPages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapter.getId());
    int maxExisting =
        existingPages.stream()
            .mapToInt(p -> p != null && p.getPageNumber() != null ? p.getPageNumber() : 0)
            .max()
            .orElse(0);
    int safePageNumber =
        Math.max(1, Math.min(pageNumber != null ? pageNumber : maxExisting + 1, maxExisting + 1));

    Optional<Page> existingPageOpt =
        pageRepository.findByChapterIdAndPageNumber(chapter.getId(), safePageNumber);
    if (existingPageOpt.isPresent()) {
      shiftPagesUp(chapter.getId(), safePageNumber);
    }

    Image image = new Image();
    image.setFilename(filename);
    image.setStoragePath(storagePath);
    image.setThumbnailStoragePath(thumbnailStoragePath);
    image.setHash(hash);
    image.setCreatedBy(user);
    Objects.requireNonNull(image, "image cannot be null");
    image = imageRepository.save(Objects.requireNonNull(image));

    Page page = new Page();
    page.setChapter(chapter);
    page.setPageNumber(safePageNumber);
    page.setImage(image);
    Objects.requireNonNull(page, "page cannot be null");
    page = pageRepository.save(Objects.requireNonNull(page));

    if (safePageNumber == 1) {
      pageRepository.flush();
      recalculateChapterCover(chapter.getId());
    }

    return page;
  }

  @Transactional
  public Page createPageWithExistingImage(
      Chapter chapter, Image existingImage, Integer pageNumber, User user) {
    List<Page> existingPages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapter.getId());
    int maxExisting =
        existingPages.stream()
            .mapToInt(p -> p != null && p.getPageNumber() != null ? p.getPageNumber() : 0)
            .max()
            .orElse(0);
    int safePageNumber =
        Math.max(1, Math.min(pageNumber != null ? pageNumber : maxExisting + 1, maxExisting + 1));

    Optional<Page> existingPageOpt =
        pageRepository.findByChapterIdAndPageNumber(chapter.getId(), safePageNumber);
    if (existingPageOpt.isPresent()) {
      Page existingPage = existingPageOpt.get();
      if (existingPage.getImage().getId().equals(existingImage.getId())) {
        return existingPage;
      } else {
        shiftPagesUp(chapter.getId(), safePageNumber);
      }
    }

    Page page = new Page();
    page.setChapter(chapter);
    page.setPageNumber(safePageNumber);
    page.setImage(existingImage);
    Objects.requireNonNull(page, "page cannot be null");
    page = pageRepository.save(Objects.requireNonNull(page));

    if (safePageNumber == 1) {
      pageRepository.flush();
      recalculateChapterCover(chapter.getId());
    }

    return page;
  }

  private void shiftPagesUp(UUID chapterId, Integer startingPageNumber) {
    List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
    for (int i = pages.size() - 1; i >= 0; i--) {
      Page p = pages.get(i);
      if (p.getPageNumber() >= startingPageNumber) {
        p.setPageNumber(p.getPageNumber() + 1);
        pageRepository.save(Objects.requireNonNull(p));
      }
    }
    pageRepository.flush();
  }

  @Transactional
  public List<String> deletePageDb(UUID pageId) {
    Objects.requireNonNull(pageId, "pageId cannot be null");
    Page page =
        pageRepository
            .findById(Objects.requireNonNull(pageId))
            .orElseThrow(() -> new IllegalArgumentException("Page not found: " + pageId));

    Image image = page.getImage();
    UUID chapterId = page.getChapter().getId();
    UUID imageId = image.getId();

    long remainingReferences = pageRepository.findByImageId(imageId).size();

    List<String> pathsToDelete = new ArrayList<>();
    if (remainingReferences == 1) {
      if (image.getStoragePath() != null) {
        pathsToDelete.add(image.getStoragePath());
      }
      if (image.getThumbnailStoragePath() != null) {
        pathsToDelete.add(image.getThumbnailStoragePath());
      }
      if (image.getId() != null) {
        pathsToDelete.add("rendered/" + image.getId() + ".png");
      }
    }

    // 1. Delete page first
    pageRepository.delete(Objects.requireNonNull(page));

    // 2. Delete image (triggers cascade delete in Postgres to panels, OCR, layers, etc.) only if
    // last reference
    if (remainingReferences == 1) {
      imageRepository.delete(Objects.requireNonNull(image));
    }

    // 3. Flush deletions to DB
    pageRepository.flush();

    // 4. Re-sequence remaining pages in chapter to maintain sequence 1..N
    List<Page> remainingPages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
    for (int i = 0; i < remainingPages.size(); i++) {
      Page p = remainingPages.get(i);
      Objects.requireNonNull(p, "page cannot be null");
      p.setPageNumber(i + 1);
      pageRepository.save(Objects.requireNonNull(p));
    }
    pageRepository.flush();

    recalculateChapterCover(chapterId);

    return pathsToDelete;
  }

  /**
   * Records the original pixel dimensions of an image.
   *
   * <p>The reader draws its OCR/panel overlays in original-image coordinates, and until these are
   * known it has to infer them from the {@code naturalWidth} of whatever it happens to have
   * displayed. That is only correct while the displayed bytes are the original — the moment a
   * downscaled reading variant is served, every overlay shifts by the scale factor and any region
   * edited in that state is persisted at the wrong scale.
   */
  void persistImageDimensions(UUID imageId, int width, int height) {
    if (width <= 0 || height <= 0) {
      return;
    }
    imageRepository
        .findById(Objects.requireNonNull(imageId))
        .ifPresent(
            img -> {
              img.setWidth(width);
              img.setHeight(height);
              imageRepository.save(Objects.requireNonNull(img));
            });
  }

  /** Result of the thumbnail source decode. Null image is never returned; see the helper. */
  private record Decoded(
      java.awt.image.BufferedImage image, int width, int height, int targetHeight) {}

  /**
   * True when this reader is the native libwebp-backed one, which is the only codec here that is
   * unsafe to call concurrently.
   *
   * <p>Detected via the originating provider rather than {@link
   * javax.imageio.ImageReader#getFormatName()}, which can itself touch the native library.
   */
  private static boolean isNativeWebpReader(javax.imageio.ImageReader reader) {
    javax.imageio.spi.ImageReaderSpi spi = reader.getOriginatingProvider();
    if (spi == null) {
      return true; // unknown provenance: assume unsafe rather than risk a SIGSEGV
    }
    for (String name : spi.getFormatNames()) {
      if (name != null && name.toLowerCase(java.util.Locale.ROOT).contains("webp")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Decodes the thumbnail source, holding {@code WEBP_LOCK} only for a genuinely WebP source.
   *
   * <p>AUDIT-B6: this decode used to sit wholly inside {@code synchronized (WEBP_LOCK)} despite
   * the lock's comment claiming it was WebP-only, which serialised the entire four-thread
   * {@code thumbnailExecutor} — the known slowdown on 100+ image uploads. JPEG and PNG are 96% of
   * this corpus and their ImageIO codecs are thread-safe, so they no longer wait on each other.
   *
   * <p>Returns null when no reader can handle the bytes.
   */
  private Decoded decodeForThumbnail(UUID imageId, java.io.InputStream in, int targetWidth)
      throws IOException {
    javax.imageio.stream.ImageInputStream iis = javax.imageio.ImageIO.createImageInputStream(in);
    try {
      java.util.Iterator<javax.imageio.ImageReader> readers =
          javax.imageio.ImageIO.getImageReaders(iis);
      if (!readers.hasNext()) {
        log.warn("No image reader found for image {}", imageId);
        return null;
      }
      javax.imageio.ImageReader reader = readers.next();
      try {
        // Chosen before any decoding call, so the branch below cannot itself race the codec.
        if (isNativeWebpReader(reader)) {
          synchronized (WEBP_LOCK) {
            return readSubsampled(reader, iis, targetWidth);
          }
        }
        return readSubsampled(reader, iis, targetWidth);
      } finally {
        reader.dispose();
      }
    } finally {
      iis.close();
    }
  }

  private static Decoded readSubsampled(
      javax.imageio.ImageReader reader, javax.imageio.stream.ImageInputStream iis, int targetWidth)
      throws IOException {
    reader.setInput(iis, true, true);
    int originalWidth = reader.getWidth(0);
    int originalHeight = reader.getHeight(0);

    double ratio = (double) originalHeight / originalWidth;
    int targetHeight = (int) (targetWidth * ratio);
    if (targetHeight <= 0) targetHeight = 1;

    // Subsampling: only subsample if the image is extremely large to save memory,
    // but keep it at least 3x the target width for high-quality downscaling
    javax.imageio.ImageReadParam param = reader.getDefaultReadParam();
    int scale = originalWidth / (targetWidth * 3);
    if (scale > 1) {
      param.setSourceSubsampling(scale, scale, 0, 0);
    }
    return new Decoded(reader.read(0, param), originalWidth, originalHeight, targetHeight);
  }

  @org.springframework.scheduling.annotation.Async("thumbnailExecutor")
  public void generateAndSaveThumbnailAsync(UUID imageId, String uuid, byte[] originalBytes) {
    try (java.io.ByteArrayInputStream in = new java.io.ByteArrayInputStream(originalBytes)) {
      int targetWidth = 512;
      Decoded decoded = decodeForThumbnail(imageId, in, targetWidth);
      if (decoded == null) {
        return;
      }
      java.awt.image.BufferedImage subsampledImage = decoded.image();
      // Used below for the persist: the reader has always computed these and thrown them away,
      // which left images.width/height null for every row.
      int originalWidth = decoded.width();
      int originalHeight = decoded.height();
      int targetHeight = decoded.targetHeight();

      // Persisted here rather than alongside the thumbnail path below, and outside the lock: the
      // reader's overlay geometry depends on these, so they must survive an encode failure (a
      // missing libwebp-imageio takes out the thumbnail, not the dimensions). Best-effort — a
      // failure here must not abort the thumbnail that is already decoded.
      try {
        persistImageDimensions(imageId, originalWidth, originalHeight);
      } catch (RuntimeException e) {
        log.warn("Could not persist dimensions for image {}", imageId, e);
      }

      // High-quality area-averaging scaling
      java.awt.Image scaled =
          subsampledImage.getScaledInstance(targetWidth, targetHeight, java.awt.Image.SCALE_SMOOTH);

      java.awt.image.BufferedImage thumbnail =
          new java.awt.image.BufferedImage(
              targetWidth, targetHeight, java.awt.image.BufferedImage.TYPE_INT_RGB);

      java.awt.Graphics2D g = thumbnail.createGraphics();
      g.drawImage(scaled, 0, 0, null);
      g.dispose();

      byte[] thumbBytes;
      synchronized (WEBP_LOCK) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        java.util.Iterator<javax.imageio.ImageWriter> writers =
            javax.imageio.ImageIO.getImageWritersByFormatName("webp");
        if (writers.hasNext()) {
          javax.imageio.ImageWriter writer = writers.next();
          javax.imageio.ImageWriteParam writeParam = writer.getDefaultWriteParam();
          if (writeParam.canWriteCompressed()) {
            writeParam.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT);
            String[] types = writeParam.getCompressionTypes();
            if (types != null && types.length > 0) {
              writeParam.setCompressionType(types[0]); // Lossy
            }
            writeParam.setCompressionQuality(0.85f);
          }
          javax.imageio.stream.ImageOutputStream ios =
              javax.imageio.ImageIO.createImageOutputStream(out);
          writer.setOutput(ios);
          writer.write(null, new javax.imageio.IIOImage(thumbnail, null, null), writeParam);
          ios.close();
          writer.dispose();
        } else {
          javax.imageio.ImageIO.write(thumbnail, "webp", out);
        }
        thumbBytes = out.toByteArray();
      }

      String thumbnailStoragePath = "thumbnails/" + uuid + ".webp";
      minioService.uploadFile(thumbnailStoragePath, thumbBytes, "image/webp");

      imageRepository
          .findById(Objects.requireNonNull(imageId))
          .ifPresent(
              img -> {
                img.setThumbnailStoragePath(thumbnailStoragePath);
                imageRepository.save(Objects.requireNonNull(img));
              });
      log.info("Successfully generated and uploaded WebP thumbnail to {}", thumbnailStoragePath);
    } catch (IOException | RuntimeException | LinkageError | MinioException e) {
      // LinkageError, not Error: the intent was to log JNI/native load failures (e.g.
      // UnsatisfiedLinkError from a missing musl libwebp-imageio) with context instead of
      // letting them escape to the async uncaught handler. Catching Error also swallowed
      // OutOfMemoryError, which is not recoverable and must not be treated as a failed
      // thumbnail. Thumbnail generation is best-effort; the gallery retries lazily.
      log.error("Failed to generate async thumbnail for image {}", imageId, e);
    }

    // Independent of the thumbnail above: a thumbnail failure must not cost the reader its
    // variant, and vice versa. Both are best-effort and both fall back cleanly when absent.
    generateAndSaveReaderVariant(imageId, uuid, originalBytes);
  }

  /**
   * Encodes and stores the WebP reading variant at native resolution.
   *
   * <p>Measured over the whole 743-image corpus, this takes reader payload from 1.136 GB to
   * 0.274 GB (0.241x) at q90 — JPEG sources to 0.30x, PNG sources to 0.15x. The win is the
   * re-encode, not a resize, so nothing is downscaled here.
   *
   * <p>Two cases store no new object and point {@code readerStoragePath} at the original instead:
   *
   * <ul>
   *   <li><b>Already-WebP sources.</b> Re-encoding them inflates by ~1.19x.
   *   <li><b>Encodes that come out no smaller.</b> Dense screentone is the pathological case for
   *       lossy WebP; the worst page in the corpus reaches only 0.84x, and a handful land above
   *       1.0x. Serving a bigger "optimised" variant than the original would be strictly worse.
   * </ul>
   *
   * <p>Recording the original path rather than leaving null is what lets the backfill retire —
   * see {@link com.manga.library.model.Image#getReaderStoragePath()}.
   */
  void generateAndSaveReaderVariant(UUID imageId, String uuid, byte[] originalBytes) {
    try {
      if (isWebp(originalBytes)) {
        log.debug("Image {} is already WebP; reader will serve the original", imageId);
        useOriginalForReader(imageId);
        return;
      }

      java.awt.image.BufferedImage source;
      try (java.io.ByteArrayInputStream in = new java.io.ByteArrayInputStream(originalBytes)) {
        // No WEBP_LOCK here: WebP sources returned above, so this decode only ever runs the
        // thread-safe built-in JPEG/PNG codecs.
        source = javax.imageio.ImageIO.read(in);
      }
      if (source == null) {
        log.warn("No image reader found for reader variant of image {}", imageId);
        return;
      }

      // The WebP writer wants a plain opaque raster; PNG sources commonly decode to ARGB or a
      // custom/indexed type that it will not accept.
      java.awt.image.BufferedImage rgb =
          new java.awt.image.BufferedImage(
              source.getWidth(), source.getHeight(), java.awt.image.BufferedImage.TYPE_INT_RGB);
      java.awt.Graphics2D g = rgb.createGraphics();
      g.drawImage(source, 0, 0, java.awt.Color.WHITE, null);
      g.dispose();

      byte[] variant = encodeWebp(rgb, 0.90f);
      if (variant == null) {
        return;
      }
      if (variant.length >= originalBytes.length) {
        log.info(
            "Reader variant for image {} not smaller ({} vs {} bytes); keeping the original",
            imageId,
            variant.length,
            originalBytes.length);
        useOriginalForReader(imageId);
        return;
      }

      String readerStoragePath = "reader/" + uuid + ".webp";
      minioService.uploadFile(readerStoragePath, variant, "image/webp");
      imageRepository
          .findById(Objects.requireNonNull(imageId))
          .ifPresent(
              img -> {
                img.setReaderStoragePath(readerStoragePath);
                imageRepository.save(Objects.requireNonNull(img));
              });
      log.info(
          "Generated reader variant {} ({} -> {} bytes, {}x)",
          readerStoragePath,
          originalBytes.length,
          variant.length,
          String.format("%.2f", (double) variant.length / originalBytes.length));
    } catch (IOException | RuntimeException | LinkageError | MinioException e) {
      // See the thumbnail path: LinkageError only, so an OutOfMemoryError from decoding a very
      // large page propagates instead of being logged as a routine variant failure.
      log.error("Failed to generate reader variant for image {}", imageId, e);
    }
  }

  /** Records that the reader should serve this image's original bytes, not a variant. */
  private void useOriginalForReader(UUID imageId) {
    imageRepository
        .findById(Objects.requireNonNull(imageId))
        .ifPresent(
            img -> {
              img.setReaderStoragePath(img.getStoragePath());
              imageRepository.save(Objects.requireNonNull(img));
            });
  }

  /** RIFF....WEBP container sniff — the extension is not trustworthy, one .png here is a JPEG. */
  private static boolean isWebp(byte[] bytes) {
    return bytes != null
        && bytes.length >= 12
        && bytes[0] == 'R'
        && bytes[1] == 'I'
        && bytes[2] == 'F'
        && bytes[3] == 'F'
        && bytes[8] == 'W'
        && bytes[9] == 'E'
        && bytes[10] == 'B'
        && bytes[11] == 'P';
  }

  /** Encodes to lossy WebP. Returns null when no writer is registered. */
  private static byte[] encodeWebp(java.awt.image.BufferedImage image, float quality)
      throws IOException {
    synchronized (WEBP_LOCK) {
      java.util.Iterator<javax.imageio.ImageWriter> writers =
          javax.imageio.ImageIO.getImageWritersByFormatName("webp");
      if (!writers.hasNext()) {
        return null;
      }
      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
      javax.imageio.ImageWriter writer = writers.next();
      javax.imageio.ImageWriteParam writeParam = writer.getDefaultWriteParam();
      if (writeParam.canWriteCompressed()) {
        writeParam.setCompressionMode(javax.imageio.ImageWriteParam.MODE_EXPLICIT);
        String[] types = writeParam.getCompressionTypes();
        if (types != null && types.length > 0) {
          writeParam.setCompressionType(types[0]); // Lossy
        }
        writeParam.setCompressionQuality(quality);
      }
      javax.imageio.stream.ImageOutputStream ios =
          javax.imageio.ImageIO.createImageOutputStream(out);
      writer.setOutput(ios);
      writer.write(null, new javax.imageio.IIOImage(image, null, null), writeParam);
      ios.close();
      writer.dispose();
      return out.toByteArray();
    }
  }

  public String getFileExtension(String filename) {
    if (filename == null) return ".jpg";
    int lastIndex = filename.lastIndexOf('.');
    return lastIndex == -1 ? ".jpg" : filename.substring(lastIndex);
  }

  @Transactional
  public void recalculateSeriesCover(UUID seriesId) {
    Series series = seriesRepository.findById(Objects.requireNonNull(seriesId)).orElse(null);
    if (series == null) return;

    Double minChapterNum = chapterRepository.findMinChapterNumberWithCoverBySeriesId(seriesId);
    UUID coverImageId = null;
    if (minChapterNum != null) {
      Optional<Chapter> firstCoverChapter =
          chapterRepository.findBySeriesIdAndChapterNumber(seriesId, minChapterNum);
      if (firstCoverChapter.isPresent()) {
        coverImageId = firstCoverChapter.get().getCoverImageId();
      }
    }

    series.setCoverImageId(coverImageId);
    seriesRepository.save(Objects.requireNonNull(series));
  }

  @Transactional
  public void recalculateChapterCover(UUID chapterId) {
    Chapter chapter = chapterRepository.findById(Objects.requireNonNull(chapterId)).orElse(null);
    if (chapter == null) return;

    Optional<Page> firstPage = pageRepository.findByChapterIdAndPageNumber(chapterId, 1);
    UUID coverImageId = firstPage.map(page -> page.getImage().getId()).orElse(null);

    chapter.setCoverImageId(coverImageId);
    chapterRepository.save(Objects.requireNonNull(chapter));

    recalculateSeriesCover(chapter.getSeries().getId());
  }

  @Transactional
  public void updatePageNumber(UUID pageId, int newPageNumber) {
    Objects.requireNonNull(pageId, "pageId cannot be null");
    Page page =
        pageRepository
            .findById(pageId)
            .orElseThrow(() -> new IllegalArgumentException("Page not found: " + pageId));

    int oldPageNumber = page.getPageNumber();
    if (oldPageNumber == newPageNumber) return;

    UUID chapterId = page.getChapter().getId();
    List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
    int totalPages = pages.size();

    // Enforce bounds and map 0 to end
    if (newPageNumber == 0 || newPageNumber == -1) {
      newPageNumber = totalPages;
    } else if (newPageNumber < 0) {
      throw new IllegalArgumentException("Page number cannot be negative");
    } else if (newPageNumber > totalPages) {
      throw new IllegalArgumentException("Page number cannot be greater than total pages");
    }

    if (oldPageNumber == newPageNumber) return;

    // Temporarily set to a high number to avoid unique constraint violations
    page.setPageNumber(10000 + newPageNumber);
    pageRepository.save(Objects.requireNonNull(page));
    pageRepository.flush();

    // Shift other pages
    if (newPageNumber > oldPageNumber) {
      for (int i = 0; i < pages.size(); i++) {
        Page p = pages.get(i);
        if (p.getId().equals(pageId)) continue;
        if (p.getPageNumber() > oldPageNumber && p.getPageNumber() <= newPageNumber) {
          p.setPageNumber(p.getPageNumber() - 1);
          pageRepository.save(Objects.requireNonNull(p));
          pageRepository.flush();
        }
      }
    } else {
      for (int i = pages.size() - 1; i >= 0; i--) {
        Page p = pages.get(i);
        if (p.getId().equals(pageId)) continue;
        if (p.getPageNumber() >= newPageNumber && p.getPageNumber() < oldPageNumber) {
          p.setPageNumber(p.getPageNumber() + 1);
          pageRepository.save(Objects.requireNonNull(p));
          pageRepository.flush();
        }
      }
    }

    page.setPageNumber(newPageNumber);
    pageRepository.save(Objects.requireNonNull(page));
    pageRepository.flush();

    if (oldPageNumber == 1 || newPageNumber == 1) {
      recalculateChapterCover(chapterId);
    }
  }

  @Transactional
  public Map<UUID, UUID> cloneOcrData(Page sourcePage, Page targetPage) {
    List<Layer> sourceLayers = layerRepository.findByPageId(sourcePage.getId());
    Layer sourceOcrLayer = sourceLayers.stream()
        .filter(l -> "ocr".equals(l.getType()) && Boolean.TRUE.equals(l.getVisible()))
        .max(java.util.Comparator.comparingInt(Layer::getZOrder))
        .orElse(null);

    Map<UUID, UUID> regionIdMap = new HashMap<>();

    if (sourceOcrLayer == null) {
      return regionIdMap; // No OCR layer to clone
    }

    // Clone OcrRegions
    List<OcrRegion> sourceRegions = ocrRegionRepository.findByPageId(sourcePage.getId());
    for (OcrRegion sourceRegion : sourceRegions) {
      OcrRegion clonedRegion = new OcrRegion();
      clonedRegion.setPage(targetPage);
      // Panel relationship is handled via Image, so we don't need to clone panels since they share the Image
      clonedRegion.setPanel(sourceRegion.getPanel());
      clonedRegion.setText(sourceRegion.getText());
      // OcrRegion carries the TL and QA fields too, so cloning OCR alone has to clear them rather
      // than copy them: a clone of the OCR is not a clone of a translation that was never redone.
      // When the caller goes on to clone TL as well, cloneTranslationData writes these same seven
      // fields back from the source.
      clonedRegion.setTranslatedText(null);
      clonedRegion.setApproved(false);
      clonedRegion.setTranslationFailed(false);
      clonedRegion.setTranslationScore(null);
      clonedRegion.setQaScore(null);
      clonedRegion.setQaFeedback(null);
      clonedRegion.setQaStatus("pending");

      clonedRegion.setDetectedLanguage(sourceRegion.getDetectedLanguage());
      clonedRegion.setConfidence(sourceRegion.getConfidence());
      clonedRegion.setRotation(sourceRegion.getRotation());
      clonedRegion.setBboxX(sourceRegion.getBboxX());
      clonedRegion.setBboxY(sourceRegion.getBboxY());
      clonedRegion.setBboxW(sourceRegion.getBboxW());
      clonedRegion.setBboxH(sourceRegion.getBboxH());
      clonedRegion.setPanelReadingOrder(sourceRegion.getPanelReadingOrder());
      clonedRegion.setBubbleReadingOrder(sourceRegion.getBubbleReadingOrder());
      clonedRegion.setRegionType(sourceRegion.getRegionType());
      clonedRegion.setBackgroundColor(sourceRegion.getBackgroundColor());
      clonedRegion.setBubbleX(sourceRegion.getBubbleX());
      clonedRegion.setBubbleY(sourceRegion.getBubbleY());
      clonedRegion.setBubbleW(sourceRegion.getBubbleW());
      clonedRegion.setBubbleH(sourceRegion.getBubbleH());
      clonedRegion.setOcrScore(sourceRegion.getOcrScore());
      clonedRegion.setBubbleId(sourceRegion.getBubbleId());
      clonedRegion.setDetectionConfidence(sourceRegion.getDetectionConfidence());
      clonedRegion.setMaskPolygon(sourceRegion.getMaskPolygon());
      clonedRegion.setSafeTextX(sourceRegion.getSafeTextX());
      clonedRegion.setSafeTextY(sourceRegion.getSafeTextY());
      clonedRegion.setSafeTextW(sourceRegion.getSafeTextW());
      clonedRegion.setSafeTextH(sourceRegion.getSafeTextH());

      clonedRegion = ocrRegionRepository.save(clonedRegion);
      regionIdMap.put(sourceRegion.getId(), clonedRegion.getId());
    }

    ocrRegionRepository.flush();

    // Clone OCR Layer
    Layer clonedOcrLayer = new Layer();
    clonedOcrLayer.setPage(targetPage);
    clonedOcrLayer.setType(sourceOcrLayer.getType());
    clonedOcrLayer.setTargetLanguage(sourceOcrLayer.getTargetLanguage());
    clonedOcrLayer.setVisible(sourceOcrLayer.getVisible());
    clonedOcrLayer.setZOrder(sourceOcrLayer.getZOrder());
    if (sourceOcrLayer.getMetadataJson() != null) {
      clonedOcrLayer.setMetadataJson(sourceOcrLayer.getMetadataJson().deepCopy());
    }
    clonedOcrLayer = layerRepository.save(clonedOcrLayer);

    // Clone OCR LayerElements
    List<LayerElement> sourceElements = layerElementRepository.findByLayerPageId(sourcePage.getId()).stream()
        .filter(e -> e.getLayer().getId().equals(sourceOcrLayer.getId()))
        .toList();

    for (LayerElement sourceEl : sourceElements) {
      layerElementRepository.save(cloneLayerElement(sourceEl, clonedOcrLayer, regionIdMap));
    }

    layerElementRepository.flush();
    return regionIdMap;
  }

  /**
   * Copies every field of a {@link LayerElement} onto a fresh one attached to {@code targetLayer},
   * repointing its region through {@code regionIdMap}.
   *
   * <p>AUDIT-Q3: {@link #cloneOcrData} and {@link #cloneTranslationData} carried this block
   * verbatim, differing only in which layer the clone was attached to. Both copies were complete
   * when this was extracted — the point is that the next field added to {@code LayerElement} now
   * has one place to be forgotten instead of two.
   */
  private LayerElement cloneLayerElement(
      LayerElement sourceEl, Layer targetLayer, Map<UUID, UUID> regionIdMap) {
    LayerElement clonedEl = new LayerElement();
    clonedEl.setLayer(targetLayer);
    if (sourceEl.getRegion() != null && regionIdMap.containsKey(sourceEl.getRegion().getId())) {
      UUID newRegionId = regionIdMap.get(sourceEl.getRegion().getId());
      clonedEl.setRegion(ocrRegionRepository.findById(newRegionId).orElse(null));
    }
    clonedEl.setText(sourceEl.getText());
    clonedEl.setFont(sourceEl.getFont());
    clonedEl.setSize(sourceEl.getSize());
    clonedEl.setAutoSize(sourceEl.getAutoSize());
    clonedEl.setMaxWidth(sourceEl.getMaxWidth());
    clonedEl.setMaxHeight(sourceEl.getMaxHeight());
    clonedEl.setWordWrap(sourceEl.getWordWrap());
    clonedEl.setRotation(sourceEl.getRotation());
    clonedEl.setX(sourceEl.getX());
    clonedEl.setY(sourceEl.getY());
    clonedEl.setVisible(sourceEl.getVisible());
    clonedEl.setOverflow(sourceEl.getOverflow());
    clonedEl.setBackgroundColor(sourceEl.getBackgroundColor());
    clonedEl.setTextColor(sourceEl.getTextColor());
    clonedEl.setFontWeight(sourceEl.getFontWeight());
    clonedEl.setFontStyle(sourceEl.getFontStyle());
    clonedEl.setIsManuallyEdited(sourceEl.getIsManuallyEdited());
    clonedEl.setEditedAt(sourceEl.getEditedAt());
    clonedEl.setBoxShape(sourceEl.getBoxShape());
    clonedEl.setMaskPolygon(sourceEl.getMaskPolygon());
    return clonedEl;
  }

  @Transactional
  public void cloneTranslationData(Page sourcePage, Page targetPage, Map<UUID, UUID> regionIdMap) {
    List<Layer> sourceLayers = layerRepository.findByPageId(sourcePage.getId());
    Layer sourceTlLayer = sourceLayers.stream()
        .filter(l -> "translation".equals(l.getType()) && Boolean.TRUE.equals(l.getVisible()))
        .max(java.util.Comparator.comparingInt(Layer::getZOrder))
        .orElse(null);

    if (sourceTlLayer == null) {
      return; // No TL layer to clone
    }

    // Update OcrRegions with TL/QA data from source
    List<OcrRegion> sourceRegions = ocrRegionRepository.findByPageId(sourcePage.getId());
    for (OcrRegion sourceRegion : sourceRegions) {
      if (regionIdMap.containsKey(sourceRegion.getId())) {
        UUID newRegionId = regionIdMap.get(sourceRegion.getId());
        ocrRegionRepository.findById(newRegionId).ifPresent(targetRegion -> {
          targetRegion.setTranslatedText(sourceRegion.getTranslatedText());
          targetRegion.setApproved(sourceRegion.getApproved());
          targetRegion.setTranslationFailed(sourceRegion.getTranslationFailed());
          targetRegion.setTranslationScore(sourceRegion.getTranslationScore());
          targetRegion.setQaScore(sourceRegion.getQaScore());
          targetRegion.setQaFeedback(sourceRegion.getQaFeedback());
          targetRegion.setQaStatus(sourceRegion.getQaStatus());
          ocrRegionRepository.save(targetRegion);
        });
      }
    }
    ocrRegionRepository.flush();

    // Clone TL Layer
    Layer clonedTlLayer = new Layer();
    clonedTlLayer.setPage(targetPage);
    clonedTlLayer.setType(sourceTlLayer.getType());
    clonedTlLayer.setTargetLanguage(sourceTlLayer.getTargetLanguage());
    clonedTlLayer.setVisible(sourceTlLayer.getVisible());
    clonedTlLayer.setZOrder(sourceTlLayer.getZOrder());
    if (sourceTlLayer.getMetadataJson() != null) {
      clonedTlLayer.setMetadataJson(sourceTlLayer.getMetadataJson().deepCopy());
    }
    clonedTlLayer = layerRepository.save(clonedTlLayer);

    // Clone TL LayerElements
    List<LayerElement> sourceElements = layerElementRepository.findByLayerPageId(sourcePage.getId()).stream()
        .filter(e -> e.getLayer().getId().equals(sourceTlLayer.getId()))
        .toList();

    for (LayerElement sourceEl : sourceElements) {
      layerElementRepository.save(cloneLayerElement(sourceEl, clonedTlLayer, regionIdMap));
    }

    layerElementRepository.flush();
  }
}
