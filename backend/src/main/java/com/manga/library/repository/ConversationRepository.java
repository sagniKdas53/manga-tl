package com.manga.library.repository;

import com.manga.library.model.Conversation;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ConversationRepository extends JpaRepository<Conversation, UUID> {
  List<Conversation> findByPageId(UUID pageId);

  @org.springframework.data.jpa.repository.Modifying
  @org.springframework.data.jpa.repository.Query(
      "delete from Conversation c where c.page.id = :pageId")
  void deleteByPageId(@org.springframework.data.repository.query.Param("pageId") UUID pageId);
}

