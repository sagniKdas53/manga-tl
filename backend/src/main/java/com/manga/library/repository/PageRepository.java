package com.manga.library.repository;

import com.manga.library.model.Page;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PageRepository extends JpaRepository<Page, UUID> {
  List<Page> findByChapterIdOrderByPageNumberAsc(UUID chapterId);

  List<Page> findByImageId(UUID imageId);

  Optional<Page> findByChapterIdAndPageNumber(UUID chapterId, Integer pageNumber);

  Optional<Page> findByChapterIdAndImageId(UUID chapterId, UUID imageId);

  @org.springframework.data.jpa.repository.Query(
      "SELECT c.series.id, p.image.id "
          + "FROM Page p JOIN p.chapter c "
          + "WHERE p.pageNumber = (SELECT MIN(p2.pageNumber) FROM Page p2 WHERE p2.chapter.id = c.id) "
          + "AND c.chapterNumber = (SELECT MIN(c2.chapterNumber) FROM Chapter c2 WHERE c2.series.id = c.series.id)")
  List<Object[]> findDefaultCoverImageIds();

  @org.springframework.data.jpa.repository.Query(
      "SELECT p.chapter.id, p.image.id FROM Page p WHERE p.chapter.series.id = :seriesId "
          + "AND p.pageNumber = (SELECT MIN(p2.pageNumber) FROM Page p2 WHERE p2.chapter.id = p.chapter.id)")
  List<Object[]> findFirstPageImageIdsBySeriesId(
      @org.springframework.data.repository.query.Param("seriesId") UUID seriesId);
}
