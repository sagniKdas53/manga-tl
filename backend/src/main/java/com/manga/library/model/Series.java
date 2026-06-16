package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;
import lombok.*;

@Entity
@Table(name = "series")
@Getter
@Setter
@ToString
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Series {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  @EqualsAndHashCode.Include
  private UUID id;

  @Column(nullable = false)
  private String title;

  @Column(name = "original_language", nullable = false)
  private String originalLanguage;

  @Column(name = "reading_direction", nullable = false)
  private String readingDirection; // rtl | ltr | ttb

  @Column(name = "cover_image_url")
  private String coverImageUrl;

  @Column(name = "metadata_json")
  @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
  private String metadataJson;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "created_by")
  @com.fasterxml.jackson.annotation.JsonIgnore
  private User createdBy;

  @Column(name = "created_at", nullable = false, updatable = false)
  private OffsetDateTime createdAt;

  @PrePersist
  protected void onCreate() {
    createdAt = OffsetDateTime.now();
  }
}
