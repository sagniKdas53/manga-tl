package com.manga.library.model;

import jakarta.persistence.*;
import java.util.UUID;
import lombok.*;

@Entity
@Table(name = "ocr_regions")
@Getter
@Setter
@ToString(exclude = {"image", "panel"})
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
@NoArgsConstructor
@AllArgsConstructor
@Builder
@com.fasterxml.jackson.annotation.JsonIgnoreProperties({"hibernateLazyInitializer", "handler"})
public class OcrRegion {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  @EqualsAndHashCode.Include
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "image_id", nullable = false)
  @com.fasterxml.jackson.annotation.JsonIgnore
  private Image image;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "panel_id")
  @com.fasterxml.jackson.annotation.JsonIgnore
  private Panel panel;

  private String text;

  @Column(name = "translated_text")
  private String translatedText;

  @Column(name = "approved")
  @Builder.Default
  private Boolean approved = false;

  @Column(name = "translation_failed")
  @Builder.Default
  private Boolean translationFailed = false;

  @Column(name = "detected_language", nullable = false)
  private String detectedLanguage;

  private Double confidence;

  @Builder.Default private Double rotation = 0.0;

  @Column(name = "bbox_x", nullable = false)
  private Integer bboxX;

  @Column(name = "bbox_y", nullable = false)
  private Integer bboxY;

  @Column(name = "bbox_w", nullable = false)
  private Integer bboxW;

  @Column(name = "bbox_h", nullable = false)
  private Integer bboxH;

  @Column(name = "panel_reading_order")
  private Integer panelReadingOrder;

  @Column(name = "bubble_reading_order")
  private Integer bubbleReadingOrder;

  @Column(name = "region_type")
  @Builder.Default
  private String regionType = "speech";

  @Column(name = "background_color")
  private String backgroundColor;

  @Column(name = "bubble_x")
  private Integer bubbleX;

  @Column(name = "bubble_y")
  private Integer bubbleY;

  @Column(name = "bubble_w")
  private Integer bubbleW;

  @Column(name = "bubble_h")
  private Integer bubbleH;

  @Column(name = "ocr_score")
  private Double ocrScore;

  @Column(name = "translation_score")
  private Double translationScore;

  @Column(name = "qa_score")
  private Double qaScore;

  @Column(name = "qa_feedback")
  private String qaFeedback;

  @Column(name = "qa_status")
  @Builder.Default
  private String qaStatus = "pending";

  @Column(name = "bubble_id")
  private String bubbleId;

  @Column(name = "detection_confidence")
  private Double detectionConfidence;

  @Column(name = "mask_polygon")
  @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
  private String maskPolygon;

  @Column(name = "safe_text_x")
  private Integer safeTextX;

  @Column(name = "safe_text_y")
  private Integer safeTextY;

  @Column(name = "safe_text_w")
  private Integer safeTextW;

  @Column(name = "safe_text_h")
  private Integer safeTextH;

  public UUID getPanelId() {
    return panel != null ? panel.getId() : null;
  }
}
