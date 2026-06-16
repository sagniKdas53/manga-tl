package com.manga.library.repository;

import com.manga.library.model.Series;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SeriesRepository extends JpaRepository<Series, UUID> {}
