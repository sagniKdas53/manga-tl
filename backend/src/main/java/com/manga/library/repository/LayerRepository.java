package com.manga.library.repository;

import com.manga.library.model.Layer;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface LayerRepository extends JpaRepository<Layer, UUID> {
    List<Layer> findByImageId(UUID imageId);
}
