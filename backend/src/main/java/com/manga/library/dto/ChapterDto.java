package com.manga.library.dto;

import java.util.UUID;
import lombok.Data;

@Data
public class ChapterDto {
  private UUID id;
  private UUID seriesId;
  private Integer chapterNumber;
  private String title;
  private String coverImageUrl;
}
