package com.manga.library.dto;

import java.util.UUID;
import lombok.Data;

@Data
public class SeriesDto {
  private UUID id;
  private String title;
  private String originalLanguage;
  private String sourceLanguage;
  private String targetLanguage;
  private String readingDirection;
  private String coverImageUrl;
  private String ocrProvider;
  private String ocrModel;
  private String tlProvider;
  private String tlModel;
  private String qaProvider;
  private String qaLlmModel;
  private String qaVlmModel;
  private String qaMode;
  private String routingStrategy;
  private java.time.OffsetDateTime createdAt;
  private java.time.OffsetDateTime updatedAt;
}
