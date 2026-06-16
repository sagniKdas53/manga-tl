package com.manga.library.repository;

import com.manga.library.model.LayerEditHistory;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface LayerEditHistoryRepository extends JpaRepository<LayerEditHistory, UUID> {
  List<LayerEditHistory> findByLayerElementIdOrderByEditedAtDesc(UUID layerElementId);
}
