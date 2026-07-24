package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "layers")
public class Layer {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "page_id", nullable = false)
  @com.fasterxml.jackson.annotation.JsonIgnore
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
  private Page page;

  @Column(nullable = false)
  private String type; // translation | ocr | notes | mask | sfx

  @Column(name = "target_language")
  private String targetLanguage;

   private Boolean visible = true;

  @Column(name = "z_order", nullable = false)
  
  private Integer zOrder = 0;

  @Column(name = "created_at", nullable = false, updatable = false)
  private OffsetDateTime createdAt;

  @Column(name = "metadata_json", columnDefinition = "jsonb")
  @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
  private com.fasterxml.jackson.databind.JsonNode metadataJson;

  @PrePersist
  protected void onCreate() {
    createdAt = OffsetDateTime.now();
  }

  public Layer() {}

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

  public String getType() {
    return this.type;
  }

  public void setType(String type) {
    this.type = type;
  }

  public String getTargetLanguage() {
    return this.targetLanguage;
  }

  public void setTargetLanguage(String targetLanguage) {
    this.targetLanguage = targetLanguage;
  }

  public Boolean getVisible() {
    return this.visible;
  }

  public void setVisible(Boolean visible) {
    this.visible = visible;
  }

  public Integer getZOrder() {
    return this.zOrder;
  }

  public void setZOrder(Integer zOrder) {
    this.zOrder = zOrder;
  }

  public OffsetDateTime getCreatedAt() {
    return this.createdAt;
  }

  public void setCreatedAt(OffsetDateTime createdAt) {
    this.createdAt = createdAt;
  }

  public com.fasterxml.jackson.databind.JsonNode getMetadataJson() {
    return this.metadataJson;
  }

  public void setMetadataJson(com.fasterxml.jackson.databind.JsonNode metadataJson) {
    this.metadataJson = metadataJson;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Layer)) return false;
    Layer that = (Layer) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
