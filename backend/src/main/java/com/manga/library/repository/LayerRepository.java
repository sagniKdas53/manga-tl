package com.manga.library.repository;

import com.manga.library.model.Layer;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface LayerRepository extends JpaRepository<Layer, UUID> {
  List<Layer> findByPageId(UUID pageId);

  /**
   * Returns all layers for the given page whose zOrder is strictly greater than the given value.
   * Used during clone to shift layers above the source up by +1. Uses explicit @Query because
   * Spring Data's derived query parser mis-capitalises 'zOrder' as 'ZOrder' and cannot resolve the
   * attribute automatically.
   */
  @Query("SELECT l FROM Layer l WHERE l.page.id = :pageId AND l.zOrder > :zOrder")
  List<Layer> findByPageIdAndZOrderGreaterThan(
      @Param("pageId") UUID pageId, @Param("zOrder") int zOrder);
}
