package com.manga.library.model;

import jakarta.persistence.*;
import java.io.Serializable;
import java.util.UUID;

@Entity
@Table(name = "conversation_regions")
@IdClass(ConversationRegion.ConversationRegionId.class)
public class ConversationRegion {

  @Id
  @Column(name = "conversation_id")
  @SuppressWarnings("PMD.UnusedPrivateField")
    private UUID conversationId;

  @Id
  @Column(name = "region_id")
  @SuppressWarnings("PMD.UnusedPrivateField")
    private UUID regionId;

  @Column(nullable = false)
  private Integer position;

              public static class ConversationRegionId implements Serializable {
    @SuppressWarnings("PMD.UnusedPrivateField")
    private UUID conversationId;
    @SuppressWarnings("PMD.UnusedPrivateField")
    private UUID regionId;
  }

  public ConversationRegion() {}

  public UUID getConversationId() {
    return this.conversationId;
  }

  public void setConversationId(UUID conversationId) {
    this.conversationId = conversationId;
  }

  public UUID getRegionId() {
    return this.regionId;
  }

  public void setRegionId(UUID regionId) {
    this.regionId = regionId;
  }

  public Integer getPosition() {
    return this.position;
  }

  public void setPosition(Integer position) {
    this.position = position;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof ConversationRegion)) return false;
    ConversationRegion that = (ConversationRegion) o;
    return regionId != null && regionId.equals(that.getRegionId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
