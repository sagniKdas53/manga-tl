package com.manga.library.dto;

import java.util.List;
import java.util.UUID;
import lombok.Data;

@Data
public class OcrCallbackDto {
  private UUID imageId;
  private UUID pageId;
  private String modelIdentifier;

  private Double confidence;
  private Object cost;
  private List<OcrRegionData> regions;

  @Data
  public static class OcrRegionData {
    private String text;
    private String detectedLanguage;
    private Double confidence;
    private Double rotation;
    private Integer x;
    private Integer y;
    private Integer width;
    private Integer height;
    private Integer panelReadingOrder;
    private Integer bubbleReadingOrder;
    private List<UUID> conversationGroup; // optional list of indexes
    private String backgroundColor;
    private Integer bubbleX;
    private Integer bubbleY;
    private Integer bubbleWidth;
    private Integer bubbleHeight;
    private String bubbleId;
    private Double detectionConfidence;
    private String maskPolygon;
    private Integer safeTextX;
    private Integer safeTextY;
    private Integer safeTextW;
    private Integer safeTextH;
  }
}
