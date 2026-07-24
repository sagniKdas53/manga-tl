package com.manga.library.dto;

import java.util.UUID;

public record UploadResponse(
  UUID pageId,
  UUID imageId,
  String status
) {
}
