package com.manga.library.repository;

import com.manga.library.model.Conversation;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface ConversationRepository extends JpaRepository<Conversation, UUID> {
    List<Conversation> findByImageId(UUID imageId);

    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.data.jpa.repository.Query("delete from Conversation c where c.image.id = :imageId")
    void deleteByImageId(@org.springframework.data.repository.query.Param("imageId") UUID imageId);
}
