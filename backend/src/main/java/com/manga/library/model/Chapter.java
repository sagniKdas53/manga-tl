package com.manga.library.model;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.util.UUID;
import lombok.*;

@Entity
@Table(
    name = "chapters",
    uniqueConstraints = {@UniqueConstraint(columnNames = {"series_id", "chapter_number"})})
@Getter
@Setter
@ToString(exclude = {"series"})
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Chapter {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  @EqualsAndHashCode.Include
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

  @Builder.Default
  @Column(name = "use_context_memory", nullable = false, columnDefinition = "boolean default true")
  private Boolean useContextMemory = true;
}
