package com.manga.library.model;

import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(
    name = "pages",
    uniqueConstraints = {@UniqueConstraint(columnNames = {"chapter_id", "page_number"})})
public class Page {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "chapter_id", nullable = false)
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
  private Chapter chapter;

  @Column(name = "page_number", nullable = false)
  private Integer pageNumber;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "image_id", nullable = false)
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
  private Image image;

  @Column(name = "last_edited_at")
  private java.time.OffsetDateTime lastEditedAt;

  @Column(name = "last_rendered_at")
  private java.time.OffsetDateTime lastRenderedAt;

  public Page() {}

  public UUID getId() {
    return this.id;
  }

  public void setId(UUID id) {
    this.id = id;
  }

  public Chapter getChapter() {
    return this.chapter;
  }

  public void setChapter(Chapter chapter) {
    this.chapter = chapter;
  }

  public Integer getPageNumber() {
    return this.pageNumber;
  }

  public void setPageNumber(Integer pageNumber) {
    this.pageNumber = pageNumber;
  }

  public Image getImage() {
    return this.image;
  }

  public void setImage(Image image) {
    this.image = image;
  }

  public java.time.OffsetDateTime getLastEditedAt() {
    return this.lastEditedAt;
  }

  public void setLastEditedAt(java.time.OffsetDateTime lastEditedAt) {
    this.lastEditedAt = lastEditedAt;
  }

  public java.time.OffsetDateTime getLastRenderedAt() {
    return this.lastRenderedAt;
  }

  public void setLastRenderedAt(java.time.OffsetDateTime lastRenderedAt) {
    this.lastRenderedAt = lastRenderedAt;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Page)) return false;
    Page that = (Page) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
