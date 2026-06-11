package com.manga.library.repository;

import com.manga.library.model.Volume;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface VolumeRepository extends JpaRepository<Volume, UUID> {
    List<Volume> findBySeriesId(UUID seriesId);
}
