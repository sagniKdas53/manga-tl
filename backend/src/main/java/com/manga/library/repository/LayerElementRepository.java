package com.manga.library.repository;

import com.manga.library.model.LayerElement;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface LayerElementRepository extends JpaRepository<LayerElement, UUID> {
  List<LayerElement> findByLayerId(UUID layerId);

  List<LayerElement> findByRegionId(UUID regionId);

  // The region is LEFT JOIN FETCHed (it is nullable) so LayerElement's serialized layerType /
  // layerVisible / regionType read from memory instead of triggering a query per element.
  @org.springframework.data.jpa.repository.Query(
      "SELECT le FROM LayerElement le JOIN FETCH le.layer l"
          + " LEFT JOIN FETCH le.region WHERE l.page.id = :pageId")
  List<LayerElement> findByLayerPageId(
      @org.springframework.data.repository.query.Param("pageId") UUID pageId);
}
