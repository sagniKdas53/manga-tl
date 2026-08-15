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

  /**
   * When {@code WorkerDispatcherService} handed this job to a worker that accepted it (HTTP 202), or
   * null while it is still queued.
   *
   * <p>Exists to make queue wait separable from work time. {@code created_at} is enqueue and {@code
   * updated_at} is last touch, so {@code updated_at - created_at} is the only duration the table
   * could previously express and it conflates the two — which is how panel-detection came to look
   * like a 184-second stage when most of that is time spent sitting in Redis. With this column the
   * split is {@code started_at - created_at} for the wait and {@code updated_at - started_at} for
   * the work, which is what the Grafana pipeline dashboard reads.
   *
   * <p>Cleared whenever a job goes back to PENDING (boot reset, stale recovery, worker-requested
   * retry) so the next dispatch times its own attempt rather than inheriting the abandoned one's.
   */
  @Column(name = "started_at")
  private OffsetDateTime startedAt;

  @Column(name = "updated_at")
  private OffsetDateTime updatedAt;

  /**
   * When this job's result callback was first applied, or null if none has been.
   *
   * <p>The dedup key for AUDIT-P4. Two paths requeue a job without telling the worker to stop —
   * {@code resetProcessingJobsToPending} at every backend boot and {@code
   * recoverStaleProcessingJobs} after ten minutes, which is shorter than a slow cloud-VLM OCR pass.
   * The original worker keeps running, so the same job row ends up with two workers producing two
   * result callbacks. No handler was idempotent, so the second one wrote a second full region set,
   * a second layer, and double-counted cost. The drained run of 2026-08-02 logged 277 dispatches
   * for 255 jobs and produced 12 duplicate (subject, type) rows.
   *
   * <p>Claimed through {@code JobRepository.claimCallback}, whose conditional UPDATE makes the
   * check-and-set atomic even when both callbacks land at once.
   */
  @Column(name = "callback_applied_at")
  private OffsetDateTime callbackAppliedAt;

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

  public OffsetDateTime getCallbackAppliedAt() {
    return this.callbackAppliedAt;
  }

  public void setCallbackAppliedAt(OffsetDateTime callbackAppliedAt) {
    this.callbackAppliedAt = callbackAppliedAt;
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

  public OffsetDateTime getStartedAt() {
    return this.startedAt;
  }

  public void setStartedAt(OffsetDateTime startedAt) {
    this.startedAt = startedAt;
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
