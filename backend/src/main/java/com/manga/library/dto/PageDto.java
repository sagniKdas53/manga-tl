package com.manga.library.dto;

import lombok.Data;
import java.util.UUID;

@Data
public class PageDto {
    private UUID id;
    private Integer pageNumber;
    private UUID imageId;
    private String filename;
    private String url;
}
