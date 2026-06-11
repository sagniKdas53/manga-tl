package com.manga.library.repository;

import com.manga.library.model.LayerElement;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface LayerElementRepository extends JpaRepository<LayerElement, UUID> {
    List<LayerElement> findByLayerId(UUID layerId);
}
