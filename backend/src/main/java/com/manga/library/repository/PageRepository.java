package com.manga.library.repository;

import com.manga.library.model.Page;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface PageRepository extends JpaRepository<Page, UUID> {
    List<Page> findByChapterIdOrderByPageNumberAsc(UUID chapterId);
}
