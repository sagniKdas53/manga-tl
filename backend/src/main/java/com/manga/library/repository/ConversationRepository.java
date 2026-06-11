package com.manga.library.repository;

import com.manga.library.model.Conversation;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface ConversationRepository extends JpaRepository<Conversation, UUID> {
    List<Conversation> findByImageId(UUID imageId);
    void deleteByImageId(UUID imageId);
}
