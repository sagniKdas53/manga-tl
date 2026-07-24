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
    private UUID conversationId;
    private UUID regionId;

    public ConversationRegionId() {}

    public UUID getConversationId() {
      return conversationId;
    }

    public void setConversationId(UUID conversationId) {
      this.conversationId = conversationId;
    }

    public UUID getRegionId() {
      return regionId;
    }

    public void setRegionId(UUID regionId) {
      this.regionId = regionId;
    }

    @Override
    public boolean equals(Object o) {
      if (this == o) return true;
      if (!(o instanceof ConversationRegionId)) return false;
      ConversationRegionId that = (ConversationRegionId) o;
      if (conversationId != null ? !conversationId.equals(that.conversationId) : that.conversationId != null) return false;
      return regionId != null ? regionId.equals(that.regionId) : that.regionId == null;
    }

    @Override
    public int hashCode() {
      int result = conversationId != null ? conversationId.hashCode() : 0;
      result = 31 * result + (regionId != null ? regionId.hashCode() : 0);
      return result;
    }
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
