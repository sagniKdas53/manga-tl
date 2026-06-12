package com.manga.library.controller;

import com.manga.library.dto.ChapterDto;
import com.manga.library.dto.SeriesDto;
import com.manga.library.model.Chapter;
import com.manga.library.model.Series;
import com.manga.library.model.User;
import com.manga.library.repository.ChapterRepository;
import com.manga.library.repository.SeriesRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/series")
@RequiredArgsConstructor
public class SeriesController {

    private final SeriesRepository seriesRepository;
    private final ChapterRepository chapterRepository;

    @PostMapping
    public ResponseEntity<SeriesDto> createSeries(@RequestBody SeriesDto dto, @AuthenticationPrincipal User user) {
        Series series = Series.builder()
                .title(dto.getTitle())
                .originalLanguage(dto.getOriginalLanguage())
                .readingDirection(dto.getReadingDirection())
                .createdBy(user)
                .build();
        series = seriesRepository.save(series);

        dto.setId(series.getId());
        return ResponseEntity.ok(dto);
    }

    @GetMapping
    public ResponseEntity<List<SeriesDto>> listSeries() {
        List<SeriesDto> list = seriesRepository.findAll().stream().map(s -> {
            SeriesDto dto = new SeriesDto();
            dto.setId(s.getId());
            dto.setTitle(s.getTitle());
            dto.setOriginalLanguage(s.getOriginalLanguage());
            dto.setReadingDirection(s.getReadingDirection());
            return dto;
        }).collect(Collectors.toList());
        return ResponseEntity.ok(list);
    }

    @GetMapping("/{seriesId}")
    public ResponseEntity<SeriesDto> getSeries(@PathVariable UUID seriesId) {
        return seriesRepository.findById(seriesId)
                .map(s -> {
                    SeriesDto dto = new SeriesDto();
                    dto.setId(s.getId());
                    dto.setTitle(s.getTitle());
                    dto.setOriginalLanguage(s.getOriginalLanguage());
                    dto.setReadingDirection(s.getReadingDirection());
                    return ResponseEntity.ok(dto);
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping("/{seriesId}/chapters")
    public ResponseEntity<ChapterDto> createChapter(@PathVariable UUID seriesId, @RequestBody ChapterDto dto) {
        Series series = seriesRepository.findById(seriesId)
                .orElseThrow(() -> new IllegalArgumentException("Series not found: " + seriesId));

        Chapter chapter = Chapter.builder()
                .series(series)
                .chapterNumber(dto.getChapterNumber())
                .title(dto.getTitle())
                .build();
        chapter = chapterRepository.save(chapter);

        dto.setId(chapter.getId());
        dto.setSeriesId(seriesId);
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/{seriesId}/chapters")
    public ResponseEntity<List<ChapterDto>> listChapters(@PathVariable UUID seriesId) {
        List<ChapterDto> list = chapterRepository.findBySeriesId(seriesId).stream().map(c -> {
            ChapterDto dto = new ChapterDto();
            dto.setId(c.getId());
            dto.setSeriesId(c.getSeries().getId());
            dto.setChapterNumber(c.getChapterNumber());
            dto.setTitle(c.getTitle());
            return dto;
        }).collect(Collectors.toList());
        return ResponseEntity.ok(list);
    }

    @GetMapping("/chapters/{chapterId}")
    public ResponseEntity<ChapterDto> getChapter(@PathVariable UUID chapterId) {
        return chapterRepository.findById(chapterId)
                .map(c -> {
                    ChapterDto dto = new ChapterDto();
                    dto.setId(c.getId());
                    dto.setSeriesId(c.getSeries().getId());
                    dto.setChapterNumber(c.getChapterNumber());
                    dto.setTitle(c.getTitle());
                    return ResponseEntity.ok(dto);
                })
                .orElse(ResponseEntity.notFound().build());
    }
}
