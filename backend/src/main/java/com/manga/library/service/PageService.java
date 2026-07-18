package com.manga.library.service;

import com.manga.library.model.*;
import com.manga.library.repository.*;
import io.minio.errors.MinioException;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@lombok.extern.slf4j.Slf4j
public class PageService {

  private final ImageRepository imageRepository;
  private final PageRepository pageRepository;
  private final SeriesRepository seriesRepository;
  private final ChapterRepository chapterRepository;
  private final MinioService minioService;

  @Transactional
  public Page createPageAndImage(
      Chapter chapter,
      String filename,
      String storagePath,
      String thumbnailStoragePath,
      Integer pageNumber,
      String hash,
      User user) {
    Optional<Page> existingPageOpt =
        pageRepository.findByChapterIdAndPageNumber(chapter.getId(), pageNumber);
    if (existingPageOpt.isPresent()) {
      shiftPagesUp(chapter.getId(), pageNumber);
    }

    Image image =
        Image.builder()
            .filename(filename)
            .storagePath(storagePath)
            .thumbnailStoragePath(thumbnailStoragePath)
            .hash(hash)
            .createdBy(user)
            .build();
    Objects.requireNonNull(image, "image cannot be null");
    image = imageRepository.save(Objects.requireNonNull(image));

    Page page = Page.builder().chapter(chapter).pageNumber(pageNumber).image(image).build();
    Objects.requireNonNull(page, "page cannot be null");
    page = pageRepository.save(Objects.requireNonNull(page));

    if (pageNumber == 1) {
      pageRepository.flush();
      recalculateChapterCover(chapter.getId());
    }

    return page;
  }

  @Transactional
  public Page createPageWithExistingImage(
      Chapter chapter, Image existingImage, Integer pageNumber, User user) {
    Optional<Page> existingPageOpt =
        pageRepository.findByChapterIdAndPageNumber(chapter.getId(), pageNumber);
    if (existingPageOpt.isPresent()) {
      Page existingPage = existingPageOpt.get();
      if (existingPage.getImage().getId().equals(existingImage.getId())) {
        return existingPage;
      } else {
        shiftPagesUp(chapter.getId(), pageNumber);
      }
    }

    Page page = Page.builder().chapter(chapter).pageNumber(pageNumber).image(existingImage).build();
    Objects.requireNonNull(page, "page cannot be null");
    page = pageRepository.save(Objects.requireNonNull(page));

    if (pageNumber == 1) {
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

  @org.springframework.scheduling.annotation.Async("thumbnailExecutor")
  public void generateAndSaveThumbnailAsync(UUID imageId, String uuid, byte[] originalBytes) {
    try (java.io.ByteArrayInputStream in = new java.io.ByteArrayInputStream(originalBytes)) {
      in.mark(Integer.MAX_VALUE);
      javax.imageio.stream.ImageInputStream iis = javax.imageio.ImageIO.createImageInputStream(in);
      java.util.Iterator<javax.imageio.ImageReader> readers =
          javax.imageio.ImageIO.getImageReaders(iis);
      if (!readers.hasNext()) {
        log.warn("No image reader found for image {}", imageId);
        iis.close();
        return;
      }
      javax.imageio.ImageReader reader = readers.next();
      reader.setInput(iis, true, true);

      int originalWidth = reader.getWidth(0);
      int originalHeight = reader.getHeight(0);

      int targetWidth = 512;
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

      java.awt.image.BufferedImage subsampledImage = reader.read(0, param);
      reader.dispose();
      iis.close();

      // High-quality area-averaging scaling
      java.awt.Image scaled =
          subsampledImage.getScaledInstance(targetWidth, targetHeight, java.awt.Image.SCALE_SMOOTH);

      java.awt.image.BufferedImage thumbnail =
          new java.awt.image.BufferedImage(
              targetWidth, targetHeight, java.awt.image.BufferedImage.TYPE_INT_RGB);

      java.awt.Graphics2D g = thumbnail.createGraphics();
      g.drawImage(scaled, 0, 0, null);
      g.dispose();

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
      byte[] thumbBytes = out.toByteArray();

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
    } catch (IOException | RuntimeException | MinioException e) {
      log.error("Failed to generate async thumbnail for image {}", imageId, e);
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
    Page page = pageRepository.findById(pageId)
            .orElseThrow(() -> new IllegalArgumentException("Page not found: " + pageId));
    
    int oldPageNumber = page.getPageNumber();
    if (oldPageNumber == newPageNumber) return;

    UUID chapterId = page.getChapter().getId();
    List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
    int totalPages = pages.size();

    // Clamp newPageNumber
    if (newPageNumber < 1) {
        newPageNumber = 1;
    } else if (newPageNumber > totalPages || newPageNumber == -1) {
        newPageNumber = totalPages;
    }

    if (oldPageNumber == newPageNumber) return;

    // Temporarily set to a high number to avoid unique constraint violations
    page.setPageNumber(10000 + newPageNumber);
    pageRepository.save(Objects.requireNonNull(page));
    pageRepository.flush();

    // Shift other pages
    if (newPageNumber > oldPageNumber) {
        for (Page p : pages) {
            if (p.getId().equals(pageId)) continue;
            if (p.getPageNumber() > oldPageNumber && p.getPageNumber() <= newPageNumber) {
                p.setPageNumber(p.getPageNumber() - 1);
                pageRepository.save(Objects.requireNonNull(p));
            }
        }
    } else {
        for (Page p : pages) {
            if (p.getId().equals(pageId)) continue;
            if (p.getPageNumber() >= newPageNumber && p.getPageNumber() < oldPageNumber) {
                p.setPageNumber(p.getPageNumber() + 1);
                pageRepository.save(Objects.requireNonNull(p));
            }
        }
    }
    pageRepository.flush();

    page.setPageNumber(newPageNumber);
    pageRepository.save(Objects.requireNonNull(page));
    pageRepository.flush();

    if (oldPageNumber == 1 || newPageNumber == 1) {
        recalculateChapterCover(chapterId);
    }
  }
}
