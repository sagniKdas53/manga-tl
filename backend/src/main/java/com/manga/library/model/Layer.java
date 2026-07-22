package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;
import lombok.*;

@Entity
@Table(name = "layers")
@Getter
@Setter
@ToString(exclude = {"page"})
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Layer {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  @EqualsAndHashCode.Include
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

  @Builder.Default private Boolean visible = true;

  @Column(name = "z_order", nullable = false)
  @Builder.Default
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
}
