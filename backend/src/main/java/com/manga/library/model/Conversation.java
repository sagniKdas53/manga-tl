package com.manga.library.model;

import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(name = "conversations")
public class Conversation {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "page_id", nullable = false)
  @com.fasterxml.jackson.annotation.JsonIgnore
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
  private Page page;

  @Column(name = "scene_type", nullable = false)
  
  private String sceneType =
      "dialogue"; // dialogue | monologue | narration | flashback | sfx_cluster

  public Conversation() {}

  public UUID getId() {
    return this.id;
  }

  public void setId(UUID id) {
    this.id = id;
  }

  public Page getPage() {
    return this.page;
  }

  public void setPage(Page page) {
    this.page = page;
  }

  public String getSceneType() {
    return this.sceneType;
  }

  public void setSceneType(String sceneType) {
    this.sceneType = sceneType;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Conversation)) return false;
    Conversation that = (Conversation) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
