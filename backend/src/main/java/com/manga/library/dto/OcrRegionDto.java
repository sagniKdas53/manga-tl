package com.manga.library.dto;

import com.manga.library.model.OcrRegion;
import java.util.UUID;

public record OcrRegionDto(
  UUID id,
  String text,
  String translatedText,
  Boolean approved,
  Boolean translationFailed,
  String detectedLanguage,
  Double confidence,
  Double rotation,
  Integer bboxX,
  Integer bboxY,
  Integer bboxW,
  Integer bboxH,
  Integer panelReadingOrder,
  Integer bubbleReadingOrder,
  String regionType,
  String backgroundColor,
  Integer bubbleX,
  Integer bubbleY,
  Integer bubbleW,
  Integer bubbleH,
  Double ocrScore,
  Double translationScore,
  Double qaScore,
  String qaFeedback,
  String qaStatus,
  String bubbleId,
  Double detectionConfidence,
  String maskPolygon,
  Integer safeTextX,
  Integer safeTextY,
  Integer safeTextW,
  Integer safeTextH,
  UUID panelId
) {

  public static OcrRegionDto fromEntity(OcrRegion region) {
    if (region == null) {
      return null;
    }
    return new OcrRegionDto(
        region.getId(),
        region.getText(),
        region.getTranslatedText(),
        region.getApproved(),
        region.getTranslationFailed(),
        region.getDetectedLanguage(),
        region.getConfidence(),
        region.getRotation(),
        region.getBboxX(),
        region.getBboxY(),
        region.getBboxW(),
        region.getBboxH(),
        region.getPanelReadingOrder(),
        region.getBubbleReadingOrder(),
        region.getRegionType(),
        region.getBackgroundColor(),
        region.getBubbleX(),
        region.getBubbleY(),
        region.getBubbleW(),
        region.getBubbleH(),
        region.getOcrScore(),
        region.getTranslationScore(),
        region.getQaScore(),
        region.getQaFeedback(),
        region.getQaStatus(),
        region.getBubbleId(),
        region.getDetectionConfidence(),
        region.getMaskPolygon(),
        region.getSafeTextX(),
        region.getSafeTextY(),
        region.getSafeTextW(),
        region.getSafeTextH(),
        region.getPanelId()
    );
  }
}
