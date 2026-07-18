package com.manga.library.dto;

import java.util.UUID;
import lombok.Data;

@Data
public class PageDto {
  private UUID id;
  private Integer pageNumber;
  private UUID imageId;
  private UUID chapterId;
  private String filename;
  private String url;
  private String thumbnailUrl;
}
