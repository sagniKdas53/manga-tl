package com.manga.library.dto;

import java.util.List;
import java.util.UUID;

/**
 * @param jobId the id of the job row this callback reports on, echoed back by the worker from the
 *     payload the backend enqueued. Resolving the row by id instead of guessing "newest job of this
 *     type for this image" is AUDIT-P5; null when the callback comes from a worker predating it.
 */
public record OcrCallbackDto(
    String jobId,
    UUID imageId,
    UUID pageId,
    String modelIdentifier,
    Double confidence,
    Object cost,
    List<OcrRegionData> regions) {

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
      Integer safeTextH) {}
}
