package com.manga.library.repository;

import com.manga.library.model.LayerEditHistory;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface LayerEditHistoryRepository extends JpaRepository<LayerEditHistory, UUID> {
    List<LayerEditHistory> findByLayerElementIdOrderByEditedAtDesc(UUID layerElementId);
}
