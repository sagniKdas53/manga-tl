package com.manga.library.dto;

import java.util.UUID;

public record SeriesDto(
  UUID id,
  String title,
  String originalLanguage,
  String sourceLanguage,
  String targetLanguage,
  String readingDirection,
  String coverImageUrl,
  String ocrProvider,
  String ocrModel,
  String tlProvider,
  String tlModel,
  String qaProvider,
  String qaLlmModel,
  String qaVlmModel,
  String qaMode,
  String routingStrategy,
  Boolean useFallbackModels,
  java.time.OffsetDateTime createdAt,
  java.time.OffsetDateTime updatedAt
) {
}
