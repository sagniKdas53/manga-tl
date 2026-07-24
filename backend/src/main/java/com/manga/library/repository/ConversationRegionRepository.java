package com.manga.library.repository;

import com.manga.library.model.ConversationRegion;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ConversationRegionRepository
    extends JpaRepository<ConversationRegion, ConversationRegion.ConversationRegionId> {

  List<ConversationRegion> findByConversationId(UUID conversationId);

  List<ConversationRegion> findByConversationIdIn(List<UUID> conversationIds);

  @Modifying
  @Query(
      "delete from ConversationRegion cr where cr.conversationId in (select c.id from Conversation c where c.page.id = :pageId)")
  void deleteByPageId(@Param("pageId") UUID pageId);
}
