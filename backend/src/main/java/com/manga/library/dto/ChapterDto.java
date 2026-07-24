package com.manga.library.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

public record ChapterDto(
  UUID id,
  UUID seriesId,
  Double chapterNumber,
  String title,
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
  Boolean useContextMemory,
  Boolean useFallbackModels,
  Integer pageCount,
  OffsetDateTime createdAt,
  OffsetDateTime updatedAt,
  ResolvedModelSlot resolvedOcr,
  ResolvedModelSlot resolvedTranslation,
  ResolvedQaSlot resolvedQa
) {

  public record ResolvedModelSlot(
    String provider,
    String model,
    String source
  ) {}

  public record ResolvedQaSlot(
    String provider,
    String llmModel,
    String vlmModel,
    String mode,
    String source
  ) {}
}
