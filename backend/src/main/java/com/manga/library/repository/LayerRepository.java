package com.manga.library.repository;

import com.manga.library.model.Layer;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface LayerRepository extends JpaRepository<Layer, UUID> {
  List<Layer> findByImageId(UUID imageId);

  /**
   * Returns all layers for the given image whose zOrder is strictly greater than the given value.
   * Used during clone to shift layers above the source up by +1. Uses explicit @Query because
   * Spring Data's derived query parser mis-capitalises 'zOrder' as 'ZOrder' and cannot resolve the
   * attribute automatically.
   */
  @Query("SELECT l FROM Layer l WHERE l.image.id = :imageId AND l.zOrder > :zOrder")
  List<Layer> findByImageIdAndZOrderGreaterThan(
      @Param("imageId") UUID imageId, @Param("zOrder") int zOrder);
}
