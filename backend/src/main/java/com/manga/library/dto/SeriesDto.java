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
}
