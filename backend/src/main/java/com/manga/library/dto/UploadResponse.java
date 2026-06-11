package com.manga.library.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import java.util.UUID;

@Data
@AllArgsConstructor
public class UploadResponse {
    private UUID pageId;
    private UUID imageId;
    private String status;
}
