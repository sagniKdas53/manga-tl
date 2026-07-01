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
  private final com.fasterxml.jackson.databind.ObjectMapper objectMapper;

  @org.springframework.beans.factory.annotation.Value("${server.servlet.context-path:}")
  private String contextPath;

  private String getImageUrl(UUID imageId) {
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
    dto.setSourceLanguage(s.getSourceLanguage());
    dto.setTargetLanguage(s.getTargetLanguage());
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
        log.debug("Ignore fallback exception in toDto", e);
      }
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
                log.debug("Ignore fallback exception in updateChapter", e);
              }
              return ResponseEntity.ok(dto);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @DeleteMapping("/chapters/{chapterId}")
  @org.springframework.security.access.prepost.PreAuthorize("hasRole('ADMIN')")
  public ResponseEntity<Void> deleteChapter(@PathVariable UUID chapterId) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    return chapterRepository.findById(chapterId)
        .map(chapter -> {
          Series series = chapter.getSeries();
          if (series != null && series.getCoverImageUrl() != null) {
            List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
            if (pages != null) {
              for (Page page : pages) {
                if (page.getImage() != null) {
                  String imageIdStr = page.getImage().getId().toString();
                  if (series.getCoverImageUrl().contains(imageIdStr)) {
                    series.setCoverImageUrl(null);
                    seriesRepository.save(series);
                    break;
                  }
                }
              }
            }
          }
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
          Chapter.builder().series(series).chapterNumber(chapterNumber).title(title).build();
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
        try {
          byte[] thumbBytes = pageService.generateThumbnail(originalBytes);
          if (thumbBytes != null) {
            thumbnailStoragePath = "thumbnails/" + uuid + ".jpg";
            minioService.uploadFile(thumbnailStoragePath, thumbBytes, "image/jpeg");
          }
        } catch (Exception e) {
          log.error("Failed to generate/upload thumbnail in ZIP chapter import", e);
        }

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

        // Queue pipeline
        jobCoordinatorService.startPipeline(page.getImage().getId());
        pageNum++;
      }

      ChapterDto responseDto = new ChapterDto();
      responseDto.setId(chapter.getId());
      responseDto.setSeriesId(seriesId);
      responseDto.setChapterNumber(chapter.getChapterNumber());
      responseDto.setTitle(chapter.getTitle());
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
  public ResponseEntity<byte[]> exportChapter(
      @PathVariable UUID chapterId,
      @RequestParam(name = "format", defaultValue = "zip") String format) {
    Objects.requireNonNull(chapterId, "chapterId cannot be null");
    
    Chapter chapter = chapterRepository.findById(chapterId)
        .orElseThrow(() -> new IllegalArgumentException("Chapter not found: " + chapterId));
        
    List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId);
    if (pages == null || pages.isEmpty()) {
      return ResponseEntity.badRequest().body("No pages in chapter".getBytes());
    }

    try (java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
         java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos)) {

      // Prepare metadata list
      List<Map<String, Object>> pageMetadataList = new ArrayList<>();
      double chapterTotalCostVal = 0.0;
      boolean chapterHasCost = false;

      for (int i = 0; i < pages.size(); i++) {
        Page page = pages.get(i);
        UUID imageId = page.getImage().getId();
        String filename = page.getImage().getFilename();
        if (filename == null || filename.trim().isEmpty()) {
          filename = "page_" + page.getPageNumber() + ".png";
        }
        
        // Find if rendered file exists, otherwise fall back to original
        byte[] imageBytes = null;
        boolean hasRendered = false;
        try (java.io.InputStream is = minioService.downloadFile("rendered/" + imageId + ".png")) {
          imageBytes = is.readAllBytes();
          hasRendered = true;
        } catch (Exception e) {
          // fallback to original image
          try (java.io.InputStream is = minioService.downloadFile(page.getImage().getStoragePath())) {
            imageBytes = is.readAllBytes();
          } catch (Exception ex) {
            log.error("Failed to download original/rendered image for page " + page.getId(), ex);
          }
        }

        if (imageBytes != null) {
          // Determine extension from filename, or default to png
          String ext = "png";
          if (filename.contains(".")) {
            ext = filename.substring(filename.lastIndexOf('.') + 1);
          }
          String zipEntryName = String.format("%03d.%s", page.getPageNumber(), ext);
          zos.putNextEntry(new java.util.zip.ZipEntry(zipEntryName));
          zos.write(imageBytes);
          zos.closeEntry();
        }

        // Collect metadata info
        Map<String, Object> pageMeta = new HashMap<>();
        pageMeta.put("pageNumber", page.getPageNumber());
        pageMeta.put("imageId", imageId.toString());
        pageMeta.put("originalFilename", page.getImage().getFilename());
        pageMeta.put("hasRendered", hasRendered);

        List<Layer> imageLayers = layerRepository.findByImageId(imageId);
        pageMeta.put("layerCount", imageLayers.size());

        // Find active/visible translation layer
        Layer activeLayer = null;
        for (Layer l : imageLayers) {
          if ("translation".equalsIgnoreCase(l.getType()) && Boolean.TRUE.equals(l.getVisible())) {
            activeLayer = l;
            break;
          }
        }

        if (activeLayer != null) {
          Map<String, Object> activeLayerMeta = new HashMap<>();
          activeLayerMeta.put("id", activeLayer.getId().toString());
          activeLayerMeta.put("type", activeLayer.getType());
          activeLayerMeta.put("language", activeLayer.getTargetLanguage());
          pageMeta.put("activeLayer", activeLayerMeta);

          // Models used
          if (activeLayer.getMetadataJson() != null && activeLayer.getMetadataJson().isObject()) {
            com.fasterxml.jackson.databind.node.ObjectNode metaNode = 
                (com.fasterxml.jackson.databind.node.ObjectNode) activeLayer.getMetadataJson();
            
            // ocr / translation models used
            Map<String, String> models = new HashMap<>();
            if (metaNode.has("model")) {
              models.put("translation", metaNode.get("model").asText());
            }
            // If we have ocr layer, find its model too
            for (Layer l : imageLayers) {
              if ("ocr".equalsIgnoreCase(l.getType())) {
                if (l.getMetadataJson() != null && l.getMetadataJson().isObject()) {
                  com.fasterxml.jackson.databind.node.ObjectNode ocrMeta = 
                      (com.fasterxml.jackson.databind.node.ObjectNode) l.getMetadataJson();
                  if (ocrMeta.has("model")) {
                    models.put("ocr", ocrMeta.get("model").asText());
                  }
                }
              }
            }
            pageMeta.put("modelsUsed", models);

            // Cost
            if (metaNode.has("cost")) {
              com.fasterxml.jackson.databind.JsonNode costNode = metaNode.get("cost");
              if (costNode.has("estimated_cost")) {
                double estCost = costNode.get("estimated_cost").asDouble();
                Map<String, Object> costMap = new HashMap<>();
                costMap.put("estimated_cost", estCost);
                costMap.put("currency", costNode.has("currency") ? costNode.get("currency").asText() : "USD");
                pageMeta.put("cost", costMap);

                chapterTotalCostVal += estCost;
                chapterHasCost = true;
              }
            }

            // QA review / manual edit
            boolean manualQaNeeded = false;
            if (metaNode.has("qa") && metaNode.get("qa").has("status")) {
              String qaStatus = metaNode.get("qa").get("status").asText();
              manualQaNeeded = "manual_review".equalsIgnoreCase(qaStatus);
            }
            pageMeta.put("manualQaNeeded", manualQaNeeded);
          }

          // Check if manual changes done
          boolean manualChangesDone = false;
          List<LayerElement> elements = layerElementRepository.findByLayerId(activeLayer.getId());
          if (elements != null) {
            for (LayerElement el : elements) {
              if (Boolean.TRUE.equals(el.getIsManuallyEdited())) {
                manualChangesDone = true;
                break;
              }
            }
          }
          pageMeta.put("manualChangesDone", manualChangesDone);
        } else {
          pageMeta.put("manualChangesDone", false);
          pageMeta.put("manualQaNeeded", false);
        }

        pageMetadataList.add(pageMeta);
      }

      // Compile final metadata.json
      Map<String, Object> finalMeta = new HashMap<>();
      finalMeta.put("chapterNumber", chapter.getChapterNumber());
      finalMeta.put("chapterTitle", chapter.getTitle() != null ? chapter.getTitle() : "");
      finalMeta.put("seriesTitle", chapter.getSeries() != null ? chapter.getSeries().getTitle() : "");
      finalMeta.put("totalPages", pages.size());
      finalMeta.put("exportTimestamp", java.time.OffsetDateTime.now().toString());
      finalMeta.put("pages", pageMetadataList);

      if (chapterHasCost) {
        Map<String, Object> totalCostMap = new HashMap<>();
        totalCostMap.put("estimated_cost", chapterTotalCostVal);
        totalCostMap.put("currency", "USD");
        finalMeta.put("chapterTotalCost", totalCostMap);
      }

      String metaJsonString = objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(finalMeta);
      zos.putNextEntry(new java.util.zip.ZipEntry("meta-data.json"));
      zos.write(metaJsonString.getBytes(java.nio.charset.StandardCharsets.UTF_8));
      zos.closeEntry();

      zos.finish();
      byte[] zipBytes = baos.toByteArray();

      String chapterName = chapter.getTitle() != null ? chapter.getTitle().replaceAll("[^a-zA-Z0-9.-]", "_") : "Chapter";
      String zipFileName = String.format("chapter_%s_%s.zip", chapter.getChapterNumber(), chapterName);

      return ResponseEntity.ok()
          .header("Content-Disposition", "attachment; filename=\"" + zipFileName + "\"")
          .header("Content-Type", "application/zip")
          .body(zipBytes);

    } catch (Exception e) {
      log.error("Failed to export chapter zip " + chapterId, e);
      return ResponseEntity.internalServerError().body(("Error during export: " + e.getMessage()).getBytes());
    }
  }
}
