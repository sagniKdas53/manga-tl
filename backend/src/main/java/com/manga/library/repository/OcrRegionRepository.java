package com.manga.library.repository;

import com.manga.library.model.OcrRegion;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OcrRegionRepository extends JpaRepository<OcrRegion, UUID> {
  List<OcrRegion> findByPageId(UUID pageId);

  @org.springframework.data.jpa.repository.Modifying
  @org.springframework.data.jpa.repository.Query(
      "delete from OcrRegion o where o.page.id = :pageId")
  void deleteByPageId(@org.springframework.data.repository.query.Param("pageId") UUID pageId);
}

