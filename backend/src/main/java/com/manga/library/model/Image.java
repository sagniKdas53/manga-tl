package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "images")
public class Image {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  private UUID id;

  @Column(nullable = false)
  private String filename;

  private Integer width;
  private Integer height;
  private String hash;

  @Column(name = "storage_path", nullable = false)
  private String storagePath;

  @Column(name = "thumbnail_storage_path")
  private String thumbnailStoragePath;

  /**
   * The object {@code /api/images/{id}/reader} should serve — <em>not</em> necessarily a WebP.
   *
   * <p>Usually a stored WebP variant at native resolution. When re-encoding is not worth it
   * (already-WebP sources, or dense screentone pages where q90 comes out no smaller) this is set
   * to the original {@code storagePath} instead.
   *
   * <p>That distinction matters: null means "generation has not run yet", so the backfill can
   * select on it and still retire itself. Encoding a "no variant" outcome as null would make the
   * backfill retry those images on every boot, forever.
   */
  @Column(name = "reader_storage_path")
  private String readerStoragePath;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "created_by")
  @com.fasterxml.jackson.annotation.JsonIgnore
  private User createdBy;

  @Column(name = "created_at", nullable = false, updatable = false)
  private OffsetDateTime createdAt;

  @Column(name = "last_edited_at")
  private OffsetDateTime lastEditedAt;

  @Column(name = "last_rendered_at")
  private OffsetDateTime lastRenderedAt;

  @PrePersist
  protected void onCreate() {
    createdAt = OffsetDateTime.now();
  }

  public Image() {}

  public UUID getId() {
    return this.id;
  }

  public void setId(UUID id) {
    this.id = id;
  }

  public String getFilename() {
    return this.filename;
  }

  public void setFilename(String filename) {
    this.filename = filename;
  }

  public Integer getWidth() {
    return this.width;
  }

  public void setWidth(Integer width) {
    this.width = width;
  }

  public Integer getHeight() {
    return this.height;
  }

  public void setHeight(Integer height) {
    this.height = height;
  }

  public String getHash() {
    return this.hash;
  }

  public void setHash(String hash) {
    this.hash = hash;
  }

  public String getStoragePath() {
    return this.storagePath;
  }

  public void setStoragePath(String storagePath) {
    this.storagePath = storagePath;
  }

  public String getThumbnailStoragePath() {
    return this.thumbnailStoragePath;
  }

  public void setThumbnailStoragePath(String thumbnailStoragePath) {
    this.thumbnailStoragePath = thumbnailStoragePath;
  }

  public String getReaderStoragePath() {
    return this.readerStoragePath;
  }

  public void setReaderStoragePath(String readerStoragePath) {
    this.readerStoragePath = readerStoragePath;
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

  public OffsetDateTime getLastEditedAt() {
    return this.lastEditedAt;
  }

  public void setLastEditedAt(OffsetDateTime lastEditedAt) {
    this.lastEditedAt = lastEditedAt;
  }

  public OffsetDateTime getLastRenderedAt() {
    return this.lastRenderedAt;
  }

  public void setLastRenderedAt(OffsetDateTime lastRenderedAt) {
    this.lastRenderedAt = lastRenderedAt;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Image)) return false;
    Image that = (Image) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
