package com.manga.library.repository;

import com.manga.library.model.Image;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ImageRepository extends JpaRepository<Image, UUID> {
  Optional<Image> findByHash(String hash);

  @org.springframework.data.jpa.repository.Query(
      "SELECT i FROM Image i WHERE i.lastEditedAt IS NOT NULL AND i.lastEditedAt < :threshold AND (i.lastRenderedAt IS NULL OR i.lastEditedAt > i.lastRenderedAt)")
  java.util.List<Image> findImagesNeedingRender(
      @org.springframework.data.repository.query.Param("threshold")
          java.time.OffsetDateTime threshold);
}
