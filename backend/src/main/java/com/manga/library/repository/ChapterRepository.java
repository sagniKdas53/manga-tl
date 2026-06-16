package com.manga.library.repository;

import com.manga.library.model.Chapter;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ChapterRepository extends JpaRepository<Chapter, UUID> {
  List<Chapter> findBySeriesId(UUID seriesId);

  Optional<Chapter> findBySeriesIdAndChapterNumber(UUID seriesId, Integer chapterNumber);
}
