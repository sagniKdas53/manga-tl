package com.manga.library.dto;

import lombok.Data;
import java.util.UUID;

@Data
public class SeriesDto {
    private UUID id;
    private String title;
    private String originalLanguage;
    private String readingDirection;
}
