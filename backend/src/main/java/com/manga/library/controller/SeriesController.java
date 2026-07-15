package com.manga.library.controller;

import com.manga.library.dto.ChapterDto;
import com.manga.library.dto.SeriesDto;
import com.manga.library.dto.ZipImageEntry;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import com.manga.library.service.*;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/series")
@RequiredArgsConstructor
@Slf4j
public class SeriesController {

  private final SeriesRepository seriesRepository;
  private final ChapterRepository chapterRepository;
  private final PageRepository pageRepository;
  private final ImageRepository imageRepository;
  private final LayerRepository layerRepository;
  private final LayerElementRepository layerElementRepository;
  private final PageService pageService;
  private final MinioService minioService;
  private final JobCoordinatorService jobCoordinatorService;
  private final ChapterExportService chapterExportService;
  private final com.fasterxml.jackson.databind.ObjectMapper objectMapper;

  @org.springframework.beans.factory.annotation.Value("${server.servlet.context-path:}")
  private String contextPath;

  private String getImageUrl(UUID imageId) {
    String cleanContext = contextPath == null ? "" : contextPath;
    if (cleanContext.endsWith("/")) {
      cleanContext = cleanContext.substring(0, cleanContext.length() - 1);
    }
    return cleanContext + "/api/images/" + imageId + "/thumbnail";
  }

  private SeriesDto toDto(Series s) {
    SeriesDto dto = new SeriesDto();
    dto.setId(s.getId());
    dto.setTitle(s.getTitle());
    dto.setOriginalLanguage(s.getOriginalLanguage());
    dto.setSourceLanguage(s.getSourceLanguage());
    dto.setTargetLanguage(s.getTargetLanguage());
    dto.setReadingDirection(s.getReadingDirection());
    dto.setOcrProvider(s.getOcrProvider());
    dto.setOcrModel(s.getOcrModel());
    dto.setTlProvider(s.getTlProvider());
    dto.setTlModel(s.getTlModel());
    dto.setQaProvider(s.getQaProvider());
    dto.setQaLlmModel(s.getQaLlmModel());
    dto.setQaVlmModel(s.getQaVlmModel());
    dto.setQaMode(s.getQaMode());
    // Find default cover image (first page of first chapter)
    try {
      List<Chapter> chapters = chapterRepository.findBySeriesId(s.getId());
      if (chapters != null && !chapters.isEmpty()) {
        chapters.sort(Comparator.comparing(Chapter::getChapterNumber));
        Chapter firstChapter = chapters.get(0);
        List<Page> pages =
            pageRepository.findByChapterIdOrderByPageNumberAsc(firstChapter.getId());
        if (pages != null && !pages.isEmpty()) {
          Image firstImg = pages.get(0).getImage();
          if (firstImg.getThumbnailStoragePath() != null) {
            dto.setCoverImageUrl(getImageUrl(firstImg.getId()));
          }
        }
      }
    } catch (Exception e) {
      log.debug("Ignore fallback exception in toDto", e);
    }
    return dto;
  }

  private SeriesDto toDtoWithDefaultCovers(Series s, Map<UUID, UUID> defaultCovers) {
    SeriesDto dto = new SeriesDto();
    dto.setId(s.getId());
    dto.setTitle(s.getTitle());
    dto.setOriginalLanguage(s.getOriginalLanguage());
    dto.setSourceLanguage(s.getSourceLanguage());
    dto.setTargetLanguage(s.getTargetLanguage());
    dto.setReadingDirection(s.getReadingDirection());
    dto.setOcrProvider(s.getOcrProvider());
    dto.setOcrModel(s.getOcrModel());
    dto.setTlProvider(s.getTlProvider());
    dto.setTlModel(s.getTlModel());
    dto.setQaProvider(s.getQaProvider());
    dto.setQaLlmModel(s.getQaLlmModel());
    dto.setQaVlmModel(s.getQaVlmModel());
    dto.setQaMode(s.getQaMode());
    UUID imageId = defaultCovers.get(s.getId());
    if (imageId != null) {
      dto.setCoverImageUrl(getImageUrl(imageId));
    }
    return dto;
  }

  @PostMapping
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<SeriesDto> createSeries(
      @RequestBody SeriesDto dto, @AuthenticationPrincipal User user) {
    String sourceLang =
        dto.getSourceLanguage() != null ? dto.getSourceLanguage() : dto.getOriginalLanguage();
    String targetLang = dto.getTargetLanguage() != null ? dto.getTargetLanguage() : "en";
    Series series =
        Series.builder()
            .title(dto.getTitle())
            .originalLanguage(sourceLang != null ? sourceLang : "ja")
            .sourceLanguage(sourceLang != null ? sourceLang : "ja")
            .targetLanguage(targetLang)
            .readingDirection(dto.getReadingDirection())
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
    boolean needsDefaultCovers = true;
    if (needsDefaultCovers) {
      try {
        List<Object[]> covers = pageRepository.findDefaultCoverImageIds();
        for (Object[] row : covers) {
          String thumbPath = (String) row[2];
          if (thumbPath != null) {
            defaultCovers.put((UUID) row[0], (UUID) row[1]);
          }
        }
      } catch (Exception e) {
        log.debug("Ignore query exception in listSeries", e);
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
  public ResponseEntity<?> createChapter(@PathVariable UUID seriesId, @RequestBody ChapterDto dto) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    Series series =
        seriesRepository
            .findById(seriesId)
            .orElseThrow(() -> new IllegalArgumentException("Series not found: " + seriesId));

    if (chapterRepository
        .findBySeriesIdAndChapterNumber(seriesId, dto.getChapterNumber())
        .isPresent()) {
      return ResponseEntity.status(409)
          .body(
              Map.of(
                  "message",
                  "Chapter "
                      + dto.getChapterNumber()
                      + " already exists in this series. Please select a different chapter number."));
    }

    Chapter chapter =
        Chapter.builder()
            .series(series)
            .chapterNumber(dto.getChapterNumber())
            .title(dto.getTitle())
            .ocrProvider(dto.getOcrProvider())
            .ocrModel(dto.getOcrModel())
            .tlProvider(dto.getTlProvider())
            .tlModel(dto.getTlModel())
            .qaProvider(dto.getQaProvider())
            .qaLlmModel(dto.getQaLlmModel())
            .qaVlmModel(dto.getQaVlmModel())
            .qaMode(dto.getQaMode())
            .useContextMemory(dto.getUseContextMemory() == null || dto.getUseContextMemory())
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
        String thumbPath = (String) row[2];
        if (thumbPath != null) {
          chapterCovers.put((UUID) row[0], (UUID) row[1]);
        }
      }
    } catch (Exception e) {
      log.debug("Ignore query exception in listChapters", e);
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
                  dto.setOcrProvider(c.getOcrProvider());
                  dto.setOcrModel(c.getOcrModel());
                  dto.setTlProvider(c.getTlProvider());
                  dto.setTlModel(c.getTlModel());
                  dto.setQaProvider(c.getQaProvider());
                  dto.setQaLlmModel(c.getQaLlmModel());
                  dto.setQaVlmModel(c.getQaVlmModel());
                  dto.setQaMode(c.getQaMode());
                  dto.setUseContextMemory(c.getUseContextMemory());
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
              dto.setOcrProvider(c.getOcrProvider());
              dto.setOcrModel(c.getOcrModel());
              dto.setTlProvider(c.getTlProvider());
              dto.setTlModel(c.getTlModel());
              dto.setQaProvider(c.getQaProvider());
              dto.setQaLlmModel(c.getQaLlmModel());
              dto.setQaVlmModel(c.getQaVlmModel());
              dto.setQaMode(c.getQaMode());
              dto.setUseContextMemory(c.getUseContextMemory());
              try {
                List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(c.getId());
                if (pages != null && !pages.isEmpty()) {
                  Image firstImg = pages.get(0).getImage();
                  if (firstImg.getThumbnailStoragePath() != null) {
                    dto.setCoverImageUrl(getImageUrl(firstImg.getId()));
                  }
                }
              } catch (Exception e) {
                log.debug("Ignore fallback exception in getChapter", e);
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
              String sourceLang =
                  dto.getSourceLanguage() != null
                      ? dto.getSourceLanguage()
                      : dto.getOriginalLanguage();
              String targetLang = dto.getTargetLanguage() != null ? dto.getTargetLanguage() : "en";
              s.setOriginalLanguage(sourceLang != null ? sourceLang : "ja");
              s.setSourceLanguage(sourceLang != null ? sourceLang : "ja");
              s.setTargetLanguage(targetLang);
              s.setReadingDirection(dto.getReadingDirection());
              s.setOcrProvider(dto.getOcrProvider());
              s.setOcrModel(dto.getOcrModel());
              s.setTlProvider(dto.getTlProvider());
              s.setTlModel(dto.getTlModel());
              s.setQaProvider(dto.getQaProvider());
              s.setQaLlmModel(dto.getQaLlmModel());
              s.setQaVlmModel(dto.getQaVlmModel());
              s.setQaMode(dto.getQaMode());
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
  public ResponseEntity<?> updateChapter(
      @PathVariable UUID chapterId, @RequestBody ChapterDto dto) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    return chapterRepository
        .findById(chapterId)
        .map(
            c -> {
              java.util.Optional<Chapter> existing =
                  chapterRepository.findBySeriesIdAndChapterNumber(
                      c.getSeries().getId(), dto.getChapterNumber());
              if (existing.isPresent() && !existing.get().getId().equals(c.getId())) {
                return ResponseEntity.status(409)
                    .body(
                        Map.of(
                            "message",
                            "Chapter "
                                + dto.getChapterNumber()
                                + " already exists in this series. Please select a different chapter number."));
              }
              c.setTitle(dto.getTitle());
              c.setChapterNumber(dto.getChapterNumber());
              c.setOcrProvider(dto.getOcrProvider());
              c.setOcrModel(dto.getOcrModel());
              c.setTlProvider(dto.getTlProvider());
              c.setTlModel(dto.getTlModel());
              c.setQaProvider(dto.getQaProvider());
              c.setQaLlmModel(dto.getQaLlmModel());
              c.setQaVlmModel(dto.getQaVlmModel());
              c.setQaMode(dto.getQaMode());
              if (dto.getUseContextMemory() != null) {
                c.setUseContextMemory(dto.getUseContextMemory());
              }
              Objects.requireNonNull(c, "chapter cannot be null");
              c = chapterRepository.save(c);
              dto.setId(c.getId());
              dto.setSeriesId(c.getSeries().getId());
              try {
                List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(c.getId());
                if (pages != null && !pages.isEmpty()) {
                  Image firstImg = pages.get(0).getImage();
                  if (firstImg.getThumbnailStoragePath() != null) {
                    dto.setCoverImageUrl(getImageUrl(firstImg.getId()));
                  }
                }
              } catch (Exception e) {
                log.debug("Ignore fallback exception in updateChapter", e);
              }
              return ResponseEntity.ok(dto);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @DeleteMapping("/chapters/{chapterId}")
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  @org.springframework.transaction.annotation.Transactional
  public ResponseEntity<Void> deleteChapter(@PathVariable UUID chapterId) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    return chapterRepository
        .findById(chapterId)
        .map(
            chapter -> {
              chapterRepository.delete(chapter);
              return ResponseEntity.ok().<Void>build();
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/{seriesId}/chapters/import")
  @org.springframework.security.access.prepost.PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<?> importChapter(
      @PathVariable UUID seriesId,
      @RequestParam("file") MultipartFile file,
      @RequestParam("chapterNumber") Double chapterNumber,
      @RequestParam("title") String title,
      @RequestParam(value = "ocrProvider", required = false) String ocrProvider,
      @RequestParam(value = "ocrModel", required = false) String ocrModel,
      @RequestParam(value = "tlProvider", required = false) String tlProvider,
      @RequestParam(value = "tlModel", required = false) String tlModel,
      @RequestParam(value = "qaProvider", required = false) String qaProvider,
      @RequestParam(value = "qaLlmModel", required = false) String qaLlmModel,
      @RequestParam(value = "qaVlmModel", required = false) String qaVlmModel,
      @RequestParam(value = "qaMode", required = false) String qaMode,
      @AuthenticationPrincipal User user) {
    Objects.requireNonNull(seriesId, "seriesId cannot be null");
    log.info("Importing chapter {} (num={}) for series {}", title, chapterNumber, seriesId);

    try {
      Series series =
          seriesRepository
              .findById(seriesId)
              .orElseThrow(() -> new IllegalArgumentException("Series not found: " + seriesId));

      if (chapterRepository.findBySeriesIdAndChapterNumber(seriesId, chapterNumber).isPresent()) {
        return ResponseEntity.status(409)
            .body(
                Map.of("message", "Chapter " + chapterNumber + " already exists in this series."));
      }

      // 1. Create the Chapter
      Chapter chapter =
          Chapter.builder()
              .series(series)
              .chapterNumber(chapterNumber)
              .title(title)
              .ocrProvider(ocrProvider)
              .ocrModel(ocrModel)
              .tlProvider(tlProvider)
              .tlModel(tlModel)
              .qaProvider(qaProvider)
              .qaLlmModel(qaLlmModel)
              .qaVlmModel(qaVlmModel)
              .qaMode(qaMode)
              .build();
      chapter = chapterRepository.save(chapter);

      // 2. Read ZIP/ePub entries
      List<ZipImageEntry> imageEntries = new ArrayList<>();
      try (java.util.zip.ZipInputStream zis =
          new java.util.zip.ZipInputStream(file.getInputStream())) {
        java.util.zip.ZipEntry entry;
        while ((entry = zis.getNextEntry()) != null) {
          if (entry.isDirectory()) continue;
          String name = entry.getName();
          String lowerName = name.toLowerCase();
          if (lowerName.contains("__macosx") || lowerName.contains("/.") || name.startsWith(".")) {
            continue;
          }
          if (lowerName.endsWith(".png")
              || lowerName.endsWith(".jpg")
              || lowerName.endsWith(".jpeg")
              || lowerName.endsWith(".webp")
              || lowerName.endsWith(".gif")) {
            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int len;
            while ((len = zis.read(buffer)) > -1) {
              baos.write(buffer, 0, len);
            }
            imageEntries.add(new ZipImageEntry(name, baos.toByteArray()));
          }
        }
      }

      if (imageEntries.isEmpty()) {
        chapterRepository.delete(chapter);
        return ResponseEntity.badRequest()
            .body(Map.of("message", "Archive contains no valid image files."));
      }

      // Sort alphabetically by filename to maintain order
      imageEntries.sort(Comparator.comparing(ZipImageEntry::getName));

      // 3. Import each page
      int pageNum = 1;
      for (ZipImageEntry imgEntry : imageEntries) {
        log.info(
            "Importing page {}/{} (filename: '{}') for chapter {} (Number {}) of seriesId {}",
            pageNum,
            imageEntries.size(),
            imgEntry.getName(),
            chapter.getId(),
            chapter.getChapterNumber(),
            seriesId);
        byte[] originalBytes = imgEntry.getBytes();

        // SHA-256 hash
        java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
        byte[] encodedhash = digest.digest(originalBytes);
        StringBuilder hexString = new StringBuilder(2 * encodedhash.length);
        for (byte b : encodedhash) {
          String hex = Integer.toHexString(0xff & b);
          if (hex.length() == 1) hexString.append('0');
          hexString.append(hex);
        }
        String fileHash = hexString.toString();

        // Check duplicate
        java.util.Optional<Image> existingImageOpt = imageRepository.findByHash(fileHash);
        if (existingImageOpt.isPresent()) {
          Image existingImage = existingImageOpt.get();
          pageService.createPageWithExistingImage(chapter, existingImage, pageNum, user);

          // Check if target language layer exists
          String targetLang =
              series.getTargetLanguage() != null
                  ? series.getTargetLanguage().trim().toLowerCase()
                  : "en";
          boolean targetTranslationExists =
              layerRepository.findByImageId(existingImage.getId()).stream()
                  .anyMatch(
                      l ->
                          "translation".equalsIgnoreCase(l.getType())
                              && targetLang.equalsIgnoreCase(l.getTargetLanguage()));

          if (!targetTranslationExists) {
            jobCoordinatorService.triggerImageRedo(existingImage.getId(), "translation");
          }
          pageNum++;
          continue;
        }

        String fileExtension = pageService.getFileExtension(imgEntry.getName());
        String uuid = UUID.randomUUID().toString();
        String storagePath = "originals/" + uuid + fileExtension;
        String contentType = "image/png";
        if (fileExtension.equalsIgnoreCase(".jpg") || fileExtension.equalsIgnoreCase(".jpeg")) {
          contentType = "image/jpeg";
        } else if (fileExtension.equalsIgnoreCase(".webp")) {
          contentType = "image/webp";
        } else if (fileExtension.equalsIgnoreCase(".gif")) {
          contentType = "image/gif";
        }

        // Upload to MinIO
        minioService.uploadFile(storagePath, originalBytes, contentType);

        // Generate thumbnail
        String thumbnailStoragePath = null;

        // Save records
        Page page =
            pageService.createPageAndImage(
                chapter,
                imgEntry.getName(),
                storagePath,
                thumbnailStoragePath,
                pageNum,
                fileHash,
                user);
        pageService.generateAndSaveThumbnailAsync(page.getImage().getId(), uuid, originalBytes);

        // Queue pipeline
        jobCoordinatorService.startPipeline(page.getImage().getId(), chapter.getId());
        pageNum++;
      }

      ChapterDto responseDto = new ChapterDto();
      responseDto.setId(chapter.getId());
      responseDto.setSeriesId(seriesId);
      responseDto.setChapterNumber(chapter.getChapterNumber());
      responseDto.setTitle(chapter.getTitle());
      responseDto.setOcrProvider(chapter.getOcrProvider());
      responseDto.setOcrModel(chapter.getOcrModel());
      responseDto.setTlProvider(chapter.getTlProvider());
      responseDto.setTlModel(chapter.getTlModel());
      responseDto.setQaProvider(chapter.getQaProvider());
      responseDto.setQaLlmModel(chapter.getQaLlmModel());
      responseDto.setQaVlmModel(chapter.getQaVlmModel());
      responseDto.setQaMode(chapter.getQaMode());
      responseDto.setUseContextMemory(chapter.getUseContextMemory());
      return ResponseEntity.ok(responseDto);

    } catch (java.io.IOException
        | java.security.NoSuchAlgorithmException
        | java.security.InvalidKeyException
        | io.minio.errors.MinioException
        | RuntimeException e) {
      log.error("Failed to import chapter", e);
      return ResponseEntity.internalServerError().body(Map.of("message", e.getMessage()));
    }
  }

  @GetMapping("/chapters/{chapterId}/export")
  @org.springframework.transaction.annotation.Transactional(readOnly = true)
  public ResponseEntity<?> exportChapter(
      @PathVariable UUID chapterId,
      @RequestParam(name = "format", defaultValue = "zip") String format,
      @AuthenticationPrincipal User user) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");

    // Verify chapter exists before exporting
    chapterRepository
        .findById(chapterId)
        .orElseThrow(() -> new IllegalArgumentException("Chapter not found: " + chapterId));

    List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
    if (pages == null || pages.isEmpty()) {
      return ResponseEntity.badRequest().body(Map.of("message", "No pages in chapter"));
    }

    String exportId = UUID.randomUUID().toString();
    UUID userId = user != null ? user.getId() : null;

    java.util.concurrent.CompletableFuture.runAsync(
        () -> {
          chapterExportService.buildAndUploadExport(chapterId, userId, exportId);
        });

    Map<String, String> response = new HashMap<>();
    response.put("status", "accepted");
    response.put("exportId", exportId);
    response.put(
        "message", "Export started in the background. You will be notified when it is ready.");

    return ResponseEntity.status(202).body(response);
  }

  @GetMapping("/chapters/exports/{exportId}/download")
  public ResponseEntity<byte[]> downloadExport(@PathVariable String exportId) {
    Objects.requireNonNull(exportId, "exportId cannot be null");

    try {
      byte[] zipBytes;
      try (java.io.InputStream is = minioService.downloadFile("exports/" + exportId + ".zip")) {
        zipBytes = is.readAllBytes();
      }

      org.springframework.http.HttpHeaders headers = new org.springframework.http.HttpHeaders();
      headers.set(
          org.springframework.http.HttpHeaders.CONTENT_DISPOSITION,
          "attachment; filename=export_" + exportId + ".zip");
      headers.set(org.springframework.http.HttpHeaders.CONTENT_TYPE, "application/zip");

      return ResponseEntity.ok().headers(headers).body(zipBytes);
    } catch (Exception e) {
      log.error("Failed to download export", e);
      return ResponseEntity.notFound().build();
    }
  }
}
