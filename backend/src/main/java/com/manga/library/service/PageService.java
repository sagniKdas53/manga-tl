package com.manga.library.service;

import com.manga.library.model.*;
import com.manga.library.repository.*;
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
    image = imageRepository.save(image);

    Page page = Page.builder().chapter(chapter).pageNumber(pageNumber).image(image).build();
    Objects.requireNonNull(page, "page cannot be null");
    return pageRepository.save(page);
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
    return pageRepository.save(page);
  }

  private void shiftPagesUp(UUID chapterId, Integer startingPageNumber) {
    List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
    for (int i = pages.size() - 1; i >= 0; i--) {
      Page p = pages.get(i);
      if (p.getPageNumber() >= startingPageNumber) {
        p.setPageNumber(p.getPageNumber() + 1);
        pageRepository.save(p);
      }
    }
    pageRepository.flush();
  }

  @Transactional
  public List<String> deletePageDb(UUID pageId) {
    Objects.requireNonNull(pageId, "pageId cannot be null");
    Page page =
        pageRepository
            .findById(pageId)
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
    pageRepository.delete(page);

    // 2. Delete image (triggers cascade delete in Postgres to panels, OCR, layers, etc.) only if
    // last reference
    if (remainingReferences == 1) {
      imageRepository.delete(image);
    }

    // 3. Flush deletions to DB
    pageRepository.flush();

    // 4. Re-sequence remaining pages in chapter to maintain sequence 1..N
    List<Page> remainingPages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
    for (int i = 0; i < remainingPages.size(); i++) {
      Page p = remainingPages.get(i);
      Objects.requireNonNull(p, "page cannot be null");
      p.setPageNumber(i + 1);
      pageRepository.save(p);
    }
    pageRepository.flush();

    return pathsToDelete;
  }

  @org.springframework.scheduling.annotation.Async("thumbnailExecutor")
  public void generateAndSaveThumbnailAsync(UUID imageId, String uuid, byte[] originalBytes) {
    try (java.io.ByteArrayInputStream in = new java.io.ByteArrayInputStream(originalBytes)) {
      in.mark(Integer.MAX_VALUE);
      javax.imageio.stream.ImageInputStream iis = javax.imageio.ImageIO.createImageInputStream(in);
      java.util.Iterator<javax.imageio.ImageReader> readers = javax.imageio.ImageIO.getImageReaders(iis);
      if (!readers.hasNext()) {
        log.warn("No image reader found for image {}", imageId);
        iis.close();
        return;
      }
      javax.imageio.ImageReader reader = readers.next();
      reader.setInput(iis, true, true);

      int originalWidth = reader.getWidth(0);
      int originalHeight = reader.getHeight(0);

      int targetWidth = 300;
      double ratio = (double) originalHeight / originalWidth;
      int targetHeight = (int) (targetWidth * ratio);
      if (targetHeight <= 0) targetHeight = 1;

      // Subsampling
      javax.imageio.ImageReadParam param = reader.getDefaultReadParam();
      int scale = originalWidth / targetWidth;
      if (scale > 1) {
        param.setSourceSubsampling(scale, scale, 0, 0);
      }

      java.awt.image.BufferedImage subsampledImage = reader.read(0, param);
      reader.dispose();
      iis.close();

      java.awt.image.BufferedImage thumbnail = new java.awt.image.BufferedImage(
          targetWidth, targetHeight, java.awt.image.BufferedImage.TYPE_INT_RGB);

      java.awt.Graphics2D g = thumbnail.createGraphics();
      g.setRenderingHint(
          java.awt.RenderingHints.KEY_INTERPOLATION,
          java.awt.RenderingHints.VALUE_INTERPOLATION_BICUBIC);
      g.drawImage(subsampledImage, 0, 0, targetWidth, targetHeight, null);
      g.dispose();

      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
      javax.imageio.ImageIO.write(thumbnail, "webp", out);
      byte[] thumbBytes = out.toByteArray();

      String thumbnailStoragePath = "thumbnails/" + uuid + ".webp";
      minioService.uploadFile(thumbnailStoragePath, thumbBytes, "image/webp");

      imageRepository.findById(imageId).ifPresent(img -> {
        img.setThumbnailStoragePath(thumbnailStoragePath);
        imageRepository.save(img);
      });
      log.info("Successfully generated and uploaded WebP thumbnail to {}", thumbnailStoragePath);
    } catch (Exception e) {
      log.error("Failed to generate async thumbnail for image {}", imageId, e);
    }
  }

  public String getFileExtension(String filename) {
    if (filename == null) return ".jpg";
    int lastIndex = filename.lastIndexOf('.');
    return lastIndex == -1 ? ".jpg" : filename.substring(lastIndex);
  }
}
