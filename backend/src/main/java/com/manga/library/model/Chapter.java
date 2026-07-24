package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(
    name = "chapters",
    uniqueConstraints = {@UniqueConstraint(columnNames = {"series_id", "chapter_number"})})
public class Chapter {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "series_id", nullable = false)
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
  private Series series;

  @Column(name = "chapter_number", nullable = false)
  private Double chapterNumber;

  private String title;

  @Column(name = "cover_image_id")
  private UUID coverImageId;

  @Column(name = "summary_json")
  @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
  private String summaryJson;

  @Column(name = "summary_generated_at")
  private OffsetDateTime summaryGeneratedAt;

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

  
  @Column(name = "use_context_memory", nullable = false, columnDefinition = "boolean default true")
  private Boolean useContextMemory = true;

  /** When null: inherit from series then global settings. When false: skip fallback cascade. */
  @Column(name = "use_fallback_models")
  private Boolean useFallbackModels;

  @Column(name = "created_at", nullable = false, updatable = false)
  private OffsetDateTime createdAt;

  @Column(name = "updated_at", nullable = false)
  private OffsetDateTime updatedAt;

  @PrePersist
  protected void onCreate() {
    OffsetDateTime now = OffsetDateTime.now();
    createdAt = now;
    updatedAt = now;
  }

  @PreUpdate
  protected void onUpdate() {
    updatedAt = OffsetDateTime.now();
  }

  public Chapter() {}

  public UUID getId() {
    return this.id;
  }

  public void setId(UUID id) {
    this.id = id;
  }

  public Series getSeries() {
    return this.series;
  }

  public void setSeries(Series series) {
    this.series = series;
  }

  public Double getChapterNumber() {
    return this.chapterNumber;
  }

  public void setChapterNumber(Double chapterNumber) {
    this.chapterNumber = chapterNumber;
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

  public String getSummaryJson() {
    return this.summaryJson;
  }

  public void setSummaryJson(String summaryJson) {
    this.summaryJson = summaryJson;
  }

  public OffsetDateTime getSummaryGeneratedAt() {
    return this.summaryGeneratedAt;
  }

  public void setSummaryGeneratedAt(OffsetDateTime summaryGeneratedAt) {
    this.summaryGeneratedAt = summaryGeneratedAt;
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

  public Boolean getUseContextMemory() {
    return this.useContextMemory;
  }

  public void setUseContextMemory(Boolean useContextMemory) {
    this.useContextMemory = useContextMemory;
  }

  public Boolean getUseFallbackModels() {
    return this.useFallbackModels;
  }

  public void setUseFallbackModels(Boolean useFallbackModels) {
    this.useFallbackModels = useFallbackModels;
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
    if (!(o instanceof Chapter)) return false;
    Chapter that = (Chapter) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
