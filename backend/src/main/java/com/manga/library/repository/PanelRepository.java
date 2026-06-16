package com.manga.library.repository;

import com.manga.library.model.Panel;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PanelRepository extends JpaRepository<Panel, UUID> {
  List<Panel> findByImageId(UUID imageId);

  @org.springframework.data.jpa.repository.Modifying
  @org.springframework.data.jpa.repository.Query("delete from Panel p where p.image.id = :imageId")
  void deleteByImageId(@org.springframework.data.repository.query.Param("imageId") UUID imageId);
}
