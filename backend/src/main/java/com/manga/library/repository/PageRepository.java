package com.manga.library.repository;

import com.manga.library.model.Page;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.repository.query.Param;

public interface PageRepository extends JpaRepository<Page, UUID> {
  List<Page> findByChapterIdOrderByPageNumberAsc(UUID chapterId);

  org.springframework.data.domain.Page<Page> findByChapterIdOrderByPageNumberAsc(
      UUID chapterId, org.springframework.data.domain.Pageable pageable);

  /**
   * Ordering comes from the {@link org.springframework.data.domain.Pageable} rather than the
   * method name, so the caller can serve either direction. The {@code OrderByPageNumberAsc}
   * variant above is fixed ascending and silently wins over any sort a caller supplies.
   */
  org.springframework.data.domain.Page<Page> findByChapterId(
      UUID chapterId, org.springframework.data.domain.Pageable pageable);

  List<Page> findByImageId(UUID imageId);

  Optional<Page> findByChapterIdAndPageNumber(UUID chapterId, Integer pageNumber);

  Optional<Page> findByChapterIdAndImageId(UUID chapterId, UUID imageId);

  long countByChapterId(UUID chapterId);

  @org.springframework.data.jpa.repository.Query(
      "SELECT p FROM Page p WHERE p.lastEditedAt IS NOT NULL AND p.lastEditedAt < :threshold AND (p.lastRenderedAt IS NULL OR p.lastEditedAt > p.lastRenderedAt)")
  List<Page> findPagesNeedingRender(@Param("threshold") OffsetDateTime threshold);
}
