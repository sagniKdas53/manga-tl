package com.manga.library.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "jobs")
public class Job {
  @Id
  @Column(name = "id")
  private String id;

  @Column(name = "trace_id")
  private String traceId;

  @Column(nullable = false)
  private String type;

  @Column(name = "image_id", columnDefinition = "uuid")
  private UUID imageId;

  @Column(name = "page_id", columnDefinition = "uuid")
  private UUID pageId;

  @Column(nullable = false)
  private String status; // PENDING, PROCESSING, COMPLETED, FAILED, PAUSED

  @Column(columnDefinition = "text")
  private String payload;

  @Column(columnDefinition = "text")
  private String error;

  private Integer attempt;

  @Column(name = "max_attempts")
  private Integer maxAttempts;

  @Column(name = "created_at")
  private OffsetDateTime createdAt;

  @Column(name = "updated_at")
  private OffsetDateTime updatedAt;

  @PrePersist
  protected void onCreate() {
    createdAt = OffsetDateTime.now();
    updatedAt = createdAt;
  }

  @PreUpdate
  protected void onUpdate() {
    updatedAt = OffsetDateTime.now();
  }

  public Job() {}

  public String getId() {
    return this.id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getTraceId() {
    return this.traceId;
  }

  public void setTraceId(String traceId) {
    this.traceId = traceId;
  }

  public String getType() {
    return this.type;
  }

  public void setType(String type) {
    this.type = type;
  }

  public UUID getImageId() {
    return this.imageId;
  }

  public void setImageId(UUID imageId) {
    this.imageId = imageId;
  }

  public UUID getPageId() {
    return this.pageId;
  }

  public void setPageId(UUID pageId) {
    this.pageId = pageId;
  }

  public String getStatus() {
    return this.status;
  }

  public void setStatus(String status) {
    this.status = status;
  }

  public String getPayload() {
    return this.payload;
  }

  public void setPayload(String payload) {
    this.payload = payload;
  }

  public String getError() {
    return this.error;
  }

  public void setError(String error) {
    this.error = error;
  }

  public Integer getAttempt() {
    return this.attempt;
  }

  public void setAttempt(Integer attempt) {
    this.attempt = attempt;
  }

  public Integer getMaxAttempts() {
    return this.maxAttempts;
  }

  public void setMaxAttempts(Integer maxAttempts) {
    this.maxAttempts = maxAttempts;
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
    if (!(o instanceof Job)) return false;
    Job that = (Job) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
