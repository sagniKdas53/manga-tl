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

}
