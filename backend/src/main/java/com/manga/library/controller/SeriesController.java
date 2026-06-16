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
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/series")
@RequiredArgsConstructor
public class SeriesController {

  private final SeriesRepository seriesRepository;
  private final ChapterRepository chapterRepository;
  private final PageRepository pageRepository;

  @org.springframework.beans.factory.annotation.Value("${server.servlet.context-path:}")
  private String contextPath;

  private String getImageUrl(java.util.UUID imageId) {
    String cleanContext = contextPath == null ? "" : contextPath;
    if (cleanContext.endsWith("/")) {
      cleanContext = cleanContext.substring(0, cleanContext.length() - 1);
    }
    return cleanContext + "/api/images/" + imageId + "/file";
  }

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
          List<Page> pages =
              pageRepository.findByChapterIdOrderByPageNumberAsc(firstChapter.getId());
          if (pages != null && !pages.isEmpty()) {
            dto.setCoverImageUrl(getImageUrl(pages.get(0).getImage().getId()));
          }
        }
      } catch (Exception e) {
        // Ignore fallback exceptions
      }
    }
    return dto;
  }

  private SeriesDto toDtoWithDefaultCovers(Series s, Map<UUID, UUID> defaultCovers) {
    SeriesDto dto = new SeriesDto();
    dto.setId(s.getId());
    dto.setTitle(s.getTitle());
    dto.setOriginalLanguage(s.getOriginalLanguage());
    dto.setReadingDirection(s.getReadingDirection());
    if (s.getCoverImageUrl() != null && !s.getCoverImageUrl().trim().isEmpty()) {
      dto.setCoverImageUrl(s.getCoverImageUrl());
    } else {
      UUID imageId = defaultCovers.get(s.getId());
      if (imageId != null) {
        dto.setCoverImageUrl(getImageUrl(imageId));
      }
    }
    return dto;
  }

  @PostMapping
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<SeriesDto> createSeries(
      @RequestBody SeriesDto dto, @AuthenticationPrincipal User user) {
    Series series =
        Series.builder()
            .title(dto.getTitle())
            .originalLanguage(dto.getOriginalLanguage())
            .readingDirection(dto.getReadingDirection())
            .coverImageUrl(dto.getCoverImageUrl())
            .createdBy(user)
            .build();
    Objects.requireNonNull(series, "series cannot be null");
    series = seriesRepository.save(series);

    return ResponseEntity.ok(toDto(series));
  }

  @GetMapping
  public ResponseEntity<List<SeriesDto>> listSeries() {
    List<Series> seriesList = seriesRepository.findAll();

    Map<UUID, UUID> defaultCovers = new HashMap<>();
    boolean needsDefaultCovers =
        seriesList.stream()
            .anyMatch(s -> s.getCoverImageUrl() == null || s.getCoverImageUrl().trim().isEmpty());
    if (needsDefaultCovers) {
      try {
        List<Object[]> covers = pageRepository.findDefaultCoverImageIds();
        for (Object[] row : covers) {
          defaultCovers.put((UUID) row[0], (UUID) row[1]);
        }
      } catch (Exception e) {
        // Ignore query exceptions
      }
    }

    List<SeriesDto> list =
        seriesList.stream()
            .map(s -> toDtoWithDefaultCovers(s, defaultCovers))
            .collect(Collectors.toList());
    return ResponseEntity.ok(list);
  }

  @GetMapping("/{seriesId}")
  public ResponseEntity<SeriesDto> getSeries(@PathVariable UUID seriesId) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    return seriesRepository
        .findById(seriesId)
        .map(s -> ResponseEntity.ok(toDto(s)))
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/{seriesId}/chapters")
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<ChapterDto> createChapter(
      @PathVariable UUID seriesId, @RequestBody ChapterDto dto) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    Series series =
        seriesRepository
            .findById(seriesId)
            .orElseThrow(() -> new IllegalArgumentException("Series not found: " + seriesId));

    Chapter chapter =
        Chapter.builder()
            .series(series)
            .chapterNumber(dto.getChapterNumber())
            .title(dto.getTitle())
            .build();
    Objects.requireNonNull(chapter, "chapter cannot be null");
    chapter = chapterRepository.save(chapter);

    dto.setId(chapter.getId());
    dto.setSeriesId(seriesId);
    return ResponseEntity.ok(dto);
  }

  @GetMapping("/{seriesId}/chapters")
  public ResponseEntity<List<ChapterDto>> listChapters(@PathVariable UUID seriesId) {
    List<Chapter> chapters = chapterRepository.findBySeriesId(seriesId);

    Map<UUID, UUID> chapterCovers = new HashMap<>();
    try {
      List<Object[]> covers = pageRepository.findFirstPageImageIdsBySeriesId(seriesId);
      for (Object[] row : covers) {
        chapterCovers.put((UUID) row[0], (UUID) row[1]);
      }
    } catch (Exception e) {
      // Ignore query exceptions
    }

    List<ChapterDto> list =
        chapters.stream()
            .map(
                c -> {
                  ChapterDto dto = new ChapterDto();
                  dto.setId(c.getId());
                  dto.setSeriesId(c.getSeries().getId());
                  dto.setChapterNumber(c.getChapterNumber());
                  dto.setTitle(c.getTitle());
                  UUID imageId = chapterCovers.get(c.getId());
                  if (imageId != null) {
                    dto.setCoverImageUrl(getImageUrl(imageId));
                  }
                  return dto;
                })
            .collect(Collectors.toList());
    return ResponseEntity.ok(list);
  }

  @GetMapping("/chapters/{chapterId}")
  public ResponseEntity<ChapterDto> getChapter(@PathVariable UUID chapterId) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    return chapterRepository
        .findById(chapterId)
        .map(
            c -> {
              ChapterDto dto = new ChapterDto();
              dto.setId(c.getId());
              dto.setSeriesId(c.getSeries().getId());
              dto.setChapterNumber(c.getChapterNumber());
              dto.setTitle(c.getTitle());
              try {
                List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(c.getId());
                if (pages != null && !pages.isEmpty()) {
                  dto.setCoverImageUrl(getImageUrl(pages.get(0).getImage().getId()));
                }
              } catch (Exception e) {
                // Ignore fallback exceptions
              }
              return ResponseEntity.ok(dto);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PutMapping("/{seriesId}")
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<SeriesDto> updateSeries(
      @PathVariable UUID seriesId, @RequestBody SeriesDto dto) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    return seriesRepository
        .findById(seriesId)
        .map(
            s -> {
              s.setTitle(dto.getTitle());
              s.setOriginalLanguage(dto.getOriginalLanguage());
              s.setReadingDirection(dto.getReadingDirection());
              s.setCoverImageUrl(dto.getCoverImageUrl());
              Objects.requireNonNull(s, "series cannot be null");
              s = seriesRepository.save(s);
              return ResponseEntity.ok(toDto(s));
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @DeleteMapping("/{seriesId}")
  @org.springframework.security.access.prepost.PreAuthorize("hasRole('ADMIN')")
  public ResponseEntity<Void> deleteSeries(@PathVariable UUID seriesId) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    if (seriesRepository.existsById(seriesId)) {
      seriesRepository.deleteById(seriesId);
      return ResponseEntity.ok().build();
    }
    return ResponseEntity.notFound().build();
  }

  @PutMapping("/chapters/{chapterId}")
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<ChapterDto> updateChapter(
      @PathVariable UUID chapterId, @RequestBody ChapterDto dto) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    return chapterRepository
        .findById(chapterId)
        .map(
            c -> {
              c.setTitle(dto.getTitle());
              c.setChapterNumber(dto.getChapterNumber());
              Objects.requireNonNull(c, "chapter cannot be null");
              c = chapterRepository.save(c);
              dto.setId(c.getId());
              dto.setSeriesId(c.getSeries().getId());
              try {
                List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(c.getId());
                if (pages != null && !pages.isEmpty()) {
                  dto.setCoverImageUrl(getImageUrl(pages.get(0).getImage().getId()));
                }
              } catch (Exception e) {
                // Ignore fallback exceptions
              }
              return ResponseEntity.ok(dto);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @DeleteMapping("/chapters/{chapterId}")
  @org.springframework.security.access.prepost.PreAuthorize("hasRole('ADMIN')")
  public ResponseEntity<Void> deleteChapter(@PathVariable UUID chapterId) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    if (chapterRepository.existsById(chapterId)) {
      chapterRepository.deleteById(chapterId);
      return ResponseEntity.ok().build();
    }
    return ResponseEntity.notFound().build();
  }
}
