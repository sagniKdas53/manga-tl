package com.manga.library.repository;

import com.manga.library.model.Chapter;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface ChapterRepository extends JpaRepository<Chapter, UUID> {
    List<Chapter> findBySeriesId(UUID seriesId);
}
