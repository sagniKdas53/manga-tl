package com.manga.library.repository;

import com.manga.library.model.LayerElement;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface LayerElementRepository extends JpaRepository<LayerElement, UUID> {
  List<LayerElement> findByLayerId(UUID layerId);

  List<LayerElement> findByRegionId(UUID regionId);

  @org.springframework.data.jpa.repository.Query(
      "SELECT le FROM LayerElement le JOIN FETCH le.layer l WHERE l.page.id = :pageId")
  List<LayerElement> findByLayerPageId(
      @org.springframework.data.repository.query.Param("pageId") UUID pageId);
}
