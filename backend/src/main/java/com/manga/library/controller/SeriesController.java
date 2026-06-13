package com.manga.library.controller;

import com.manga.library.dto.ChapterDto;
import com.manga.library.dto.SeriesDto;
import com.manga.library.model.Chapter;
import com.manga.library.model.Page;
import com.manga.library.model.Series;
import com.manga.library.model.User;
import com.manga.library.repository.ChapterRepository;
import com.manga.library.repository.PageRepository;
import com.manga.library.repository.SeriesRepository;
import com.manga.library.service.MinioService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/series")
@RequiredArgsConstructor
public class SeriesController {

    private final SeriesRepository seriesRepository;
    private final ChapterRepository chapterRepository;
    private final PageRepository pageRepository;
    private final MinioService minioService;

    private SeriesDto toDto(Series s) {
        SeriesDto dto = new SeriesDto();
        dto.setId(s.getId());
        dto.setTitle(s.getTitle());
        dto.setOriginalLanguage(s.getOriginalLanguage());
        dto.setReadingDirection(s.getReadingDirection());
        if (s.getCoverImageUrl() != null && !s.getCoverImageUrl().trim().isEmpty()) {
            dto.setCoverImageUrl(s.getCoverImageUrl());
        } else {
            // Find default cover image (first page of first chapter)
            try {
                List<Chapter> chapters = chapterRepository.findBySeriesId(s.getId());
                if (chapters != null && !chapters.isEmpty()) {
                    chapters.sort(Comparator.comparing(Chapter::getChapterNumber));
                    Chapter firstChapter = chapters.get(0);
                    List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(firstChapter.getId());
                    if (pages != null && !pages.isEmpty()) {
                        dto.setCoverImageUrl(minioService.generatePresignedUrl(pages.get(0).getImage().getStoragePath()));
                    }
                }
            } catch (Exception e) {
                // Ignore fallback exceptions
            }
        }
        return dto;
    }

    @PostMapping
    public ResponseEntity<SeriesDto> createSeries(@RequestBody SeriesDto dto, @AuthenticationPrincipal User user) {
        Series series = Series.builder()
                .title(dto.getTitle())
                .originalLanguage(dto.getOriginalLanguage())
                .readingDirection(dto.getReadingDirection())
                .coverImageUrl(dto.getCoverImageUrl())
                .createdBy(user)
                .build();
        series = seriesRepository.save(series);

        return ResponseEntity.ok(toDto(series));
    }

    @GetMapping
    public ResponseEntity<List<SeriesDto>> listSeries() {
        List<SeriesDto> list = seriesRepository.findAll().stream()
                .map(this::toDto)
                .collect(Collectors.toList());
        return ResponseEntity.ok(list);
    }

    @GetMapping("/{seriesId}")
    public ResponseEntity<SeriesDto> getSeries(@PathVariable UUID seriesId) {
        return seriesRepository.findById(seriesId)
                .map(s -> ResponseEntity.ok(toDto(s)))
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

    @PutMapping("/{seriesId}")
    public ResponseEntity<SeriesDto> updateSeries(@PathVariable UUID seriesId, @RequestBody SeriesDto dto) {
        return seriesRepository.findById(seriesId)
                .map(s -> {
                    s.setTitle(dto.getTitle());
                    s.setOriginalLanguage(dto.getOriginalLanguage());
                    s.setReadingDirection(dto.getReadingDirection());
                    s.setCoverImageUrl(dto.getCoverImageUrl());
                    s = seriesRepository.save(s);
                    return ResponseEntity.ok(toDto(s));
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{seriesId}")
    public ResponseEntity<Void> deleteSeries(@PathVariable UUID seriesId) {
        if (seriesRepository.existsById(seriesId)) {
            seriesRepository.deleteById(seriesId);
            return ResponseEntity.ok().build();
        }
        return ResponseEntity.notFound().build();
    }

    @PutMapping("/chapters/{chapterId}")
    public ResponseEntity<ChapterDto> updateChapter(@PathVariable UUID chapterId, @RequestBody ChapterDto dto) {
        return chapterRepository.findById(chapterId)
                .map(c -> {
                    c.setTitle(dto.getTitle());
                    c.setChapterNumber(dto.getChapterNumber());
                    c = chapterRepository.save(c);
                    dto.setId(c.getId());
                    dto.setSeriesId(c.getSeries().getId());
                    return ResponseEntity.ok(dto);
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/chapters/{chapterId}")
    public ResponseEntity<Void> deleteChapter(@PathVariable UUID chapterId) {
        if (chapterRepository.existsById(chapterId)) {
            chapterRepository.deleteById(chapterId);
            return ResponseEntity.ok().build();
        }
        return ResponseEntity.notFound().build();
    }
}
