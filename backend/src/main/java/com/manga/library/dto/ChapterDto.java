package com.manga.library.dto;

import java.time.OffsetDateTime;
import java.util.UUID;
import lombok.Data;

@Data
public class ChapterDto {
  private UUID id;
  private UUID seriesId;
  private Double chapterNumber;
  private String title;
  private String coverImageUrl;
  private String ocrProvider;
  private String ocrModel;
  private String tlProvider;
  private String tlModel;
  private String qaProvider;
  private String qaLlmModel;
  private String qaVlmModel;
  private String qaMode;
  private Boolean useContextMemory;
  private Integer pageCount;
  private OffsetDateTime createdAt;
  private OffsetDateTime updatedAt;
  private ResolvedModelSlot resolvedOcr;
  private ResolvedModelSlot resolvedTranslation;
  private ResolvedQaSlot resolvedQa;

  @Data
  public static class ResolvedModelSlot {
    private String provider;
    private String model;
    private String source;

    public ResolvedModelSlot() {}

    public ResolvedModelSlot(String provider, String model, String source) {
      this.provider = provider;
      this.model = model;
      this.source = source;
    }
  }

  @Data
  public static class ResolvedQaSlot {
    private String provider;
    private String llmModel;
    private String vlmModel;
    private String mode;
    private String source;

    public ResolvedQaSlot() {}

    public ResolvedQaSlot(
        String provider, String llmModel, String vlmModel, String mode, String source) {
      this.provider = provider;
      this.llmModel = llmModel;
      this.vlmModel = vlmModel;
      this.mode = mode;
      this.source = source;
    }
  }
}
