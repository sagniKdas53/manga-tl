package com.manga.library.repository;

import com.manga.library.model.OcrRegion;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface OcrRegionRepository extends JpaRepository<OcrRegion, UUID> {
    List<OcrRegion> findByImageId(UUID imageId);

    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.data.jpa.repository.Query("delete from OcrRegion o where o.image.id = :imageId")
    void deleteByImageId(@org.springframework.data.repository.query.Param("imageId") UUID imageId);
}
