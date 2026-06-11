package com.manga.library.repository;

import com.manga.library.model.Panel;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface PanelRepository extends JpaRepository<Panel, UUID> {
    List<Panel> findByImageId(UUID imageId);
    void deleteByImageId(UUID imageId);
}
