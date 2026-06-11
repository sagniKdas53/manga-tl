package com.manga.library.repository;

import com.manga.library.model.Series;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface SeriesRepository extends JpaRepository<Series, UUID> {
}
