package com.manga.library.repository;

import com.manga.library.model.ModelRate;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface ModelRateRepository extends JpaRepository<ModelRate, String> {
}
