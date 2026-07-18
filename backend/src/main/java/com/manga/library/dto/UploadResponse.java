package com.manga.library.dto;

import java.util.UUID;
import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
@SuppressWarnings("null")
public class UploadResponse {
  private UUID pageId;
  private UUID imageId;
  private String status;
}
