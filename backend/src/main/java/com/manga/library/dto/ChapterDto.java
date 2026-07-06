package com.manga.library.dto;

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
}
