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
public class PageService {

  private final ImageRepository imageRepository;
  private final PageRepository pageRepository;

  @Transactional
  public Page createPageAndImage(
      Chapter chapter, String filename, String storagePath, String thumbnailStoragePath, Integer pageNumber, User user) {
    Image image =
        Image.builder()
            .filename(filename)
            .storagePath(storagePath)
            .thumbnailStoragePath(thumbnailStoragePath)
            .createdBy(user)
            .build();
    Objects.requireNonNull(image, "image cannot be null");
    image = imageRepository.save(image);

    Page page = Page.builder().chapter(chapter).pageNumber(pageNumber).image(image).build();
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
}
