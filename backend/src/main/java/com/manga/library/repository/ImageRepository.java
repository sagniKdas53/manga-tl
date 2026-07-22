package com.manga.library.repository;

import com.manga.library.model.Image;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ImageRepository extends JpaRepository<Image, UUID> {
  Optional<Image> findByHash(String hash);
}

