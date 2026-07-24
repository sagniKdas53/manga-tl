package com.manga.library.model;

import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(name = "ocr_regions")
public class OcrRegion {
  @Id
  @GeneratedValue(strategy = GenerationType.AUTO)
  
  private UUID id;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "page_id", nullable = false)
  @com.fasterxml.jackson.annotation.JsonIgnore
  @org.hibernate.annotations.OnDelete(action = org.hibernate.annotations.OnDeleteAction.CASCADE)
  private Page page;

  @ManyToOne(fetch = FetchType.LAZY)
  @JoinColumn(name = "panel_id")
  @com.fasterxml.jackson.annotation.JsonIgnore
  private Panel panel;

  @Column(columnDefinition = "TEXT")
  private String text;

  @Column(name = "translated_text", columnDefinition = "TEXT")
  private String translatedText;

  @Column(name = "approved")
  
  private Boolean approved = false;

  @Column(name = "translation_failed")
  
  private Boolean translationFailed = false;

  @Column(name = "detected_language", nullable = false)
  private String detectedLanguage;

  private Double confidence;

   private Double rotation = 0.0;

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

  @Column(name = "qa_feedback", columnDefinition = "TEXT")
  private String qaFeedback;

  @Column(name = "qa_status")
  
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

  public OcrRegion() {}

  public UUID getId() {
    return this.id;
  }

  public void setId(UUID id) {
    this.id = id;
  }

  public Page getPage() {
    return this.page;
  }

  public void setPage(Page page) {
    this.page = page;
  }

  public Panel getPanel() {
    return this.panel;
  }

  public void setPanel(Panel panel) {
    this.panel = panel;
  }

  public String getText() {
    return this.text;
  }

  public void setText(String text) {
    this.text = text;
  }

  public String getTranslatedText() {
    return this.translatedText;
  }

  public void setTranslatedText(String translatedText) {
    this.translatedText = translatedText;
  }

  public Boolean getApproved() {
    return this.approved;
  }

  public void setApproved(Boolean approved) {
    this.approved = approved;
  }

  public Boolean getTranslationFailed() {
    return this.translationFailed;
  }

  public void setTranslationFailed(Boolean translationFailed) {
    this.translationFailed = translationFailed;
  }

  public String getDetectedLanguage() {
    return this.detectedLanguage;
  }

  public void setDetectedLanguage(String detectedLanguage) {
    this.detectedLanguage = detectedLanguage;
  }

  public Double getConfidence() {
    return this.confidence;
  }

  public void setConfidence(Double confidence) {
    this.confidence = confidence;
  }

  public Double getRotation() {
    return this.rotation;
  }

  public void setRotation(Double rotation) {
    this.rotation = rotation;
  }

  public Integer getBboxX() {
    return this.bboxX;
  }

  public void setBboxX(Integer bboxX) {
    this.bboxX = bboxX;
  }

  public Integer getBboxY() {
    return this.bboxY;
  }

  public void setBboxY(Integer bboxY) {
    this.bboxY = bboxY;
  }

  public Integer getBboxW() {
    return this.bboxW;
  }

  public void setBboxW(Integer bboxW) {
    this.bboxW = bboxW;
  }

  public Integer getBboxH() {
    return this.bboxH;
  }

  public void setBboxH(Integer bboxH) {
    this.bboxH = bboxH;
  }

  public Integer getPanelReadingOrder() {
    return this.panelReadingOrder;
  }

  public void setPanelReadingOrder(Integer panelReadingOrder) {
    this.panelReadingOrder = panelReadingOrder;
  }

  public Integer getBubbleReadingOrder() {
    return this.bubbleReadingOrder;
  }

  public void setBubbleReadingOrder(Integer bubbleReadingOrder) {
    this.bubbleReadingOrder = bubbleReadingOrder;
  }

  public String getRegionType() {
    return this.regionType;
  }

  public void setRegionType(String regionType) {
    this.regionType = regionType;
  }

  public String getBackgroundColor() {
    return this.backgroundColor;
  }

  public void setBackgroundColor(String backgroundColor) {
    this.backgroundColor = backgroundColor;
  }

  public Integer getBubbleX() {
    return this.bubbleX;
  }

  public void setBubbleX(Integer bubbleX) {
    this.bubbleX = bubbleX;
  }

  public Integer getBubbleY() {
    return this.bubbleY;
  }

  public void setBubbleY(Integer bubbleY) {
    this.bubbleY = bubbleY;
  }

  public Integer getBubbleW() {
    return this.bubbleW;
  }

  public void setBubbleW(Integer bubbleW) {
    this.bubbleW = bubbleW;
  }

  public Integer getBubbleH() {
    return this.bubbleH;
  }

  public void setBubbleH(Integer bubbleH) {
    this.bubbleH = bubbleH;
  }

  public Double getOcrScore() {
    return this.ocrScore;
  }

  public void setOcrScore(Double ocrScore) {
    this.ocrScore = ocrScore;
  }

  public Double getTranslationScore() {
    return this.translationScore;
  }

  public void setTranslationScore(Double translationScore) {
    this.translationScore = translationScore;
  }

  public Double getQaScore() {
    return this.qaScore;
  }

  public void setQaScore(Double qaScore) {
    this.qaScore = qaScore;
  }

  public String getQaFeedback() {
    return this.qaFeedback;
  }

  public void setQaFeedback(String qaFeedback) {
    this.qaFeedback = qaFeedback;
  }

  public String getQaStatus() {
    return this.qaStatus;
  }

  public void setQaStatus(String qaStatus) {
    this.qaStatus = qaStatus;
  }

  public String getBubbleId() {
    return this.bubbleId;
  }

  public void setBubbleId(String bubbleId) {
    this.bubbleId = bubbleId;
  }

  public Double getDetectionConfidence() {
    return this.detectionConfidence;
  }

  public void setDetectionConfidence(Double detectionConfidence) {
    this.detectionConfidence = detectionConfidence;
  }

  public String getMaskPolygon() {
    return this.maskPolygon;
  }

  public void setMaskPolygon(String maskPolygon) {
    this.maskPolygon = maskPolygon;
  }

  public Integer getSafeTextX() {
    return this.safeTextX;
  }

  public void setSafeTextX(Integer safeTextX) {
    this.safeTextX = safeTextX;
  }

  public Integer getSafeTextY() {
    return this.safeTextY;
  }

  public void setSafeTextY(Integer safeTextY) {
    this.safeTextY = safeTextY;
  }

  public Integer getSafeTextW() {
    return this.safeTextW;
  }

  public void setSafeTextW(Integer safeTextW) {
    this.safeTextW = safeTextW;
  }

  public Integer getSafeTextH() {
    return this.safeTextH;
  }

  public void setSafeTextH(Integer safeTextH) {
    this.safeTextH = safeTextH;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof OcrRegion)) return false;
    OcrRegion that = (OcrRegion) o;
    return id != null && id.equals(that.getId());
  }

  @Override
  public int hashCode() {
    return getClass().hashCode();
  }
}
