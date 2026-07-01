package com.manga.library.service;

import com.manga.library.model.*;
import com.manga.library.repository.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
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

  @Transactional
  public Page createPageAndImage(
      Chapter chapter,
      String filename,
      String storagePath,
      String thumbnailStoragePath,
      Integer pageNumber,
      String hash,
      User user) {
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
    Page page = Page.builder().chapter(chapter).pageNumber(pageNumber).image(existingImage).build();
    Objects.requireNonNull(page, "page cannot be null");
    return pageRepository.save(page);
  }

  @Transactional
  public List<String> deletePageDb(UUID pageId) {
    Objects.requireNonNull(pageId, "pageId cannot be null");
    Page page =
        pageRepository
            .findById(pageId)
            .orElseThrow(() -> new IllegalArgumentException("Page not found: " + pageId));

    Image image = page.getImage();
    List<String> pathsToDelete = new ArrayList<>();
    if (image.getStoragePath() != null) {
      pathsToDelete.add(image.getStoragePath());
    }
    if (image.getThumbnailStoragePath() != null) {
      pathsToDelete.add(image.getThumbnailStoragePath());
    }
    UUID chapterId = page.getChapter().getId();
    UUID imageId = image != null ? image.getId() : null;

    if (page.getChapter() != null && page.getChapter().getSeries() != null && imageId != null) {
      Series series = page.getChapter().getSeries();
      if (series.getCoverImageUrl() != null && series.getCoverImageUrl().contains(imageId.toString())) {
        series.setCoverImageUrl(null);
        seriesRepository.save(series);
      }
    }

    // 1. Delete page first
    pageRepository.delete(page);

    // 2. Delete image (triggers cascade delete in Postgres to panels, OCR, layers, etc.)
    imageRepository.delete(image);

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

  public byte[] generateThumbnail(byte[] originalBytes) {
    try (java.io.ByteArrayInputStream in = new java.io.ByteArrayInputStream(originalBytes)) {
      java.awt.image.BufferedImage originalImage = javax.imageio.ImageIO.read(in);
      if (originalImage == null) {
        log.warn("Unsupported image format or failed to read image for thumbnail generation.");
        return null;
      }

      int targetWidth = 300;
      double ratio = (double) originalImage.getHeight() / originalImage.getWidth();
      int targetHeight = (int) (targetWidth * ratio);
      if (targetHeight <= 0) {
        targetHeight = 1;
      }

      java.awt.image.BufferedImage thumbnail =
          new java.awt.image.BufferedImage(
              targetWidth, targetHeight, java.awt.image.BufferedImage.TYPE_INT_RGB);

      java.awt.Graphics2D g = thumbnail.createGraphics();
      g.setRenderingHint(
          java.awt.RenderingHints.KEY_INTERPOLATION,
          java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
      g.drawImage(originalImage, 0, 0, targetWidth, targetHeight, null);
      g.dispose();

      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
      javax.imageio.ImageIO.write(thumbnail, "jpg", out);
      return out.toByteArray();
    } catch (Exception e) {
      log.error("Failed to generate thumbnail", e);
      return null;
    }
  }

  public String getFileExtension(String filename) {
    if (filename == null) return ".jpg";
    int lastIndex = filename.lastIndexOf('.');
    return lastIndex == -1 ? ".jpg" : filename.substring(lastIndex);
  }
}
