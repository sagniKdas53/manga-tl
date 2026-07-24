package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "series")
public class Series {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  
  private UUID id;

  @Column(nullable = false)
  private String title;

  @Column(name = "cover_image_id")
  private UUID coverImageId;

  @Column(name = "original_language", nullable = false)
  private String originalLanguage;

  @Column(name = "source_language")
  private String sourceLanguage;

  @Column(name = "target_language")
  private String targetLanguage;

  @Column(name = "reading_direction", nullable = false)
  private String readingDirection; // rtl | ltr | ttb

  @Column(name = "metadata_json")
  @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
  private String metadataJson;

  @Column(name = "ocr_provider")
  private String ocrProvider;

  @Column(name = "ocr_model")
  private String ocrModel;

  @Column(name = "tl_provider")
  private String tlProvider;

  @Column(name = "tl_model")
  private String tlModel;

  @Column(name = "qa_provider")
  private String qaProvider;

  @Column(name = "qa_llm_model")
  private String qaLlmModel;

  @Column(name = "qa_vlm_model")
  private String qaVlmModel;

  @Column(name = "qa_mode")
  private String qaMode;

  @Column(name = "routing_strategy")
  private String routingStrategy;

  /** When null: inherit from global settings. When false: skip fallback cascade. */
  @Column(name = "use_fallback_models")
  private Boolean useFallbackModels;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "created_by")
  @com.fasterxml.jackson.annotation.JsonIgnore
  private User createdBy;

  @Column(name = "created_at", nullable = false, updatable = false)
  private OffsetDateTime createdAt;

  @Column(name = "updated_at", nullable = false)
  private OffsetDateTime updatedAt;

  @PrePersist
  protected void onCreate() {
    OffsetDateTime now = OffsetDateTime.now();
    createdAt = now;
    updatedAt = now;
    if (sourceLanguage == null) {
      sourceLanguage = originalLanguage != null ? originalLanguage : "ja";
    }
    if (targetLanguage == null) {
      targetLanguage = "en";
    }
  }

  @PreUpdate
  protected void onUpdate() {
    updatedAt = OffsetDateTime.now();
  }

  @PostLoad
  protected void onLoad() {
    if (sourceLanguage == null) {
      sourceLanguage = originalLanguage != null ? originalLanguage : "ja";
    }
    if (targetLanguage == null) {
      targetLanguage = "en";
    }
  }

  public Series() {}

  public UUID getId() {
    return this.id;
  }

  public void setId(UUID id) {
    this.id = id;
  }

  public String getTitle() {
    return this.title;
  }

  public void setTitle(String title) {
    this.title = title;
  }

  public UUID getCoverImageId() {
    return this.coverImageId;
  }

  public void setCoverImageId(UUID coverImageId) {
    this.coverImageId = coverImageId;
  }

  public String getOriginalLanguage() {
    return this.originalLanguage;
  }

  public void setOriginalLanguage(String originalLanguage) {
    this.originalLanguage = originalLanguage;
  }

  public String getSourceLanguage() {
    return this.sourceLanguage;
  }

  public void setSourceLanguage(String sourceLanguage) {
    this.sourceLanguage = sourceLanguage;
  }

  public String getTargetLanguage() {
    return this.targetLanguage;
  }

  public void setTargetLanguage(String targetLanguage) {
    this.targetLanguage = targetLanguage;
  }

  public String getReadingDirection() {
    return this.readingDirection;
  }

  public void setReadingDirection(String readingDirection) {
    this.readingDirection = readingDirection;
  }

  public String getMetadataJson() {
    return this.metadataJson;
  }

  public void setMetadataJson(String metadataJson) {
    this.metadataJson = metadataJson;
  }

  public String getOcrProvider() {
    return this.ocrProvider;
  }

  public void setOcrProvider(String ocrProvider) {
    this.ocrProvider = ocrProvider;
  }

  public String getOcrModel() {
    return this.ocrModel;
  }

  public void setOcrModel(String ocrModel) {
    this.ocrModel = ocrModel;
  }

  public String getTlProvider() {
    return this.tlProvider;
  }

  public void setTlProvider(String tlProvider) {
    this.tlProvider = tlProvider;
  }

  public String getTlModel() {
    return this.tlModel;
  }

  public void setTlModel(String tlModel) {
    this.tlModel = tlModel;
  }

  public String getQaProvider() {
    return this.qaProvider;
  }

  public void setQaProvider(String qaProvider) {
    this.qaProvider = qaProvider;
  }

  public String getQaLlmModel() {
    return this.qaLlmModel;
  }

  public void setQaLlmModel(String qaLlmModel) {
    this.qaLlmModel = qaLlmModel;
  }

  public String getQaVlmModel() {
    return this.qaVlmModel;
  }

  public void setQaVlmModel(String qaVlmModel) {
    this.qaVlmModel = qaVlmModel;
  }

  public String getQaMode() {
    return this.qaMode;
  }

  public void setQaMode(String qaMode) {
    this.qaMode = qaMode;
  }

  public String getRoutingStrategy() {
    return this.routingStrategy;
  }

  public void setRoutingStrategy(String routingStrategy) {
    this.routingStrategy = routingStrategy;
  }

  public Boolean getUseFallbackModels() {
    return this.useFallbackModels;
  }

  public void setUseFallbackModels(Boolean useFallbackModels) {
    this.useFallbackModels = useFallbackModels;
  }

  public User getCreatedBy() {
    return this.createdBy;
  }

  public void setCreatedBy(User createdBy) {
    this.createdBy = createdBy;
  }

  public OffsetDateTime getCreatedAt() {
    return this.createdAt;
  }

  public void setCreatedAt(OffsetDateTime createdAt) {
    this.createdAt = createdAt;
  }

  public OffsetDateTime getUpdatedAt() {
    return this.updatedAt;
  }

  public void setUpdatedAt(OffsetDateTime updatedAt) {
    this.updatedAt = updatedAt;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Series)) return false;
    Series that = (Series) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
