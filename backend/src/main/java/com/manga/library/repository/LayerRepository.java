package com.manga.library.repository;

import com.manga.library.model.Layer;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface LayerRepository extends JpaRepository<Layer, UUID> {
  List<Layer> findByImageId(UUID imageId);
}
