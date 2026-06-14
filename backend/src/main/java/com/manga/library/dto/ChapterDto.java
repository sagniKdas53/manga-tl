package com.manga.library.dto;

import lombok.Data;
import java.util.UUID;

@Data
public class ChapterDto {
    private UUID id;
    private UUID seriesId;
    private Integer chapterNumber;
    private String title;
    private String coverImageUrl;
}
