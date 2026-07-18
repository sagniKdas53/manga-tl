package com.manga.library.dto;

import com.manga.library.model.OcrRegion;
import java.util.UUID;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class OcrRegionDto {
  private UUID id;
  private String text;
  private String translatedText;
  private Boolean approved;
  private Boolean translationFailed;
  private String detectedLanguage;
  private Double confidence;
  private Double rotation;
  private Integer bboxX;
  private Integer bboxY;
  private Integer bboxW;
  private Integer bboxH;
  private Integer panelReadingOrder;
  private Integer bubbleReadingOrder;
  private String regionType;
  private String backgroundColor;
  private Integer bubbleX;
  private Integer bubbleY;
  private Integer bubbleW;
  private Integer bubbleH;
  private Double ocrScore;
  private Double translationScore;
  private Double qaScore;
  private String qaFeedback;
  private String qaStatus;
  private String bubbleId;
  private Double detectionConfidence;
  private String maskPolygon;
  private Integer safeTextX;
  private Integer safeTextY;
  private Integer safeTextW;
  private Integer safeTextH;
  private UUID panelId;

  public static OcrRegionDto fromEntity(OcrRegion region) {
    if (region == null) {
      return null;
    }
    return OcrRegionDto.builder()
        .id(region.getId())
        .text(region.getText())
        .translatedText(region.getTranslatedText())
        .approved(region.getApproved())
        .translationFailed(region.getTranslationFailed())
        .detectedLanguage(region.getDetectedLanguage())
        .confidence(region.getConfidence())
        .rotation(region.getRotation())
        .bboxX(region.getBboxX())
        .bboxY(region.getBboxY())
        .bboxW(region.getBboxW())
        .bboxH(region.getBboxH())
        .panelReadingOrder(region.getPanelReadingOrder())
        .bubbleReadingOrder(region.getBubbleReadingOrder())
        .regionType(region.getRegionType())
        .backgroundColor(region.getBackgroundColor())
        .bubbleX(region.getBubbleX())
        .bubbleY(region.getBubbleY())
        .bubbleW(region.getBubbleW())
        .bubbleH(region.getBubbleH())
        .ocrScore(region.getOcrScore())
        .translationScore(region.getTranslationScore())
        .qaScore(region.getQaScore())
        .qaFeedback(region.getQaFeedback())
        .qaStatus(region.getQaStatus())
        .bubbleId(region.getBubbleId())
        .detectionConfidence(region.getDetectionConfidence())
        .maskPolygon(region.getMaskPolygon())
        .safeTextX(region.getSafeTextX())
        .safeTextY(region.getSafeTextY())
        .safeTextW(region.getSafeTextW())
        .safeTextH(region.getSafeTextH())
        .panelId(region.getPanelId())
        .build();
  }
}
