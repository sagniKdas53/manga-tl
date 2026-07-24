package com.manga.library.dto;

import java.util.List;
import java.util.UUID;

public record OcrCallbackDto(
  UUID imageId,
  UUID pageId,
  String modelIdentifier,
  Double confidence,
  Object cost,
  List<OcrRegionData> regions
) {

  public record OcrRegionData(
    String text,
    String detectedLanguage,
    Double confidence,
    Double rotation,
    Integer x,
    Integer y,
    Integer width,
    Integer height,
    Integer panelReadingOrder,
    Integer bubbleReadingOrder,
    List<UUID> conversationGroup,
    String backgroundColor,
    Integer bubbleX,
    Integer bubbleY,
    Integer bubbleWidth,
    Integer bubbleHeight,
    String bubbleId,
    Double detectionConfidence,
    String maskPolygon,
    Integer safeTextX,
    Integer safeTextY,
    Integer safeTextW,
    Integer safeTextH
  ) {}
}
