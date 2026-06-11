package com.manga.library.repository;

import com.manga.library.model.OcrRegion;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface OcrRegionRepository extends JpaRepository<OcrRegion, UUID> {
    List<OcrRegion> findByImageId(UUID imageId);
    void deleteByImageId(UUID imageId);
}
