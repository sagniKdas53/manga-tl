package com.manga.library.dto;

import java.util.UUID;

public record PageDto(
  UUID id,
  Integer pageNumber,
  UUID imageId,
  UUID chapterId,
  String filename,
  String url,
  String thumbnailUrl
) {
}
