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

  @Modifying
  @Query(
      "delete from ConversationRegion cr where cr.conversationId in (select c.id from Conversation c where c.image.id = :imageId)")
  void deleteByImageId(@Param("imageId") UUID imageId);
}
