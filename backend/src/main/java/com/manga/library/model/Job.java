package com.manga.library.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.util.UUID;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Table(name = "jobs")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
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
}
