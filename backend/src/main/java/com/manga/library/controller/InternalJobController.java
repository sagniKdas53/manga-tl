package com.manga.library.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.MinioService;
import com.manga.library.service.SseService;
import java.util.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/internal")
@RequiredArgsConstructor
@Slf4j
@org.springframework.transaction.annotation.Transactional
public class InternalJobController {

  private final JobCoordinatorService jobCoordinatorService;
  private final ImageRepository imageRepository;
  private final PanelRepository panelRepository;
  private final OcrRegionRepository ocrRegionRepository;
  private final ConversationRepository conversationRepository;
  private final ConversationRegionRepository conversationRegionRepository;
  private final PageRepository pageRepository;
  private final ChapterRepository chapterRepository;
  private final MinioService minioService;
  private final LayerElementRepository layerElementRepository;
  private final LayerRepository layerRepository;
  private final SseService sseService;
  private final JobRepository jobRepository;
  private final ObjectMapper objectMapper;

  @PatchMapping("/jobs/{jobId}/status")
  public ResponseEntity<?> updateJobStatus(
      @PathVariable String jobId, @RequestBody Map<String, String> payload) {
    Objects.requireNonNull(jobId, "jobId cannot be null");
    log.info("Worker updating job {} status to {}", jobId, payload.get("status"));
    return jobRepository
        .findById(jobId)
        .map(
            job -> {
              if (payload.containsKey("status")) {
                job.setStatus(payload.get("status"));
              }
              if (payload.containsKey("error")) {
                job.setError(payload.get("error"));
              }
              if (payload.containsKey("attempt")) {
                try {
                  int attempt = Integer.parseInt(payload.get("attempt"));
                  job.setAttempt(attempt);

                  if (job.getPayload() != null) {
                    Map<String, Object> payloadMap =
                        objectMapper.readValue(
                            job.getPayload(),
                            new com.fasterxml.jackson.core.type.TypeReference<
                                Map<String, Object>>() {});
                    payloadMap.put("attempt", attempt);
                    job.setPayload(objectMapper.writeValueAsString(payloadMap));
                  }
                } catch (Exception e) {
                  log.error("Failed to parse attempt or update payload: {}", e.getMessage());
                }
              }
              jobRepository.save(Objects.requireNonNull(job));
              if ("PENDING".equals(payload.get("status"))) {
                jobCoordinatorService.pushJobToRedis(job);
              }

              // Emit real-time SSE event
              try {
                sseService.emitEventForImage(job.getImageId(), "job_update", job);
              } catch (Exception e) {
                log.error("Failed to emit job_update event: {}", e.getMessage());
              }

              return ResponseEntity.ok().build();
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @GetMapping("/jobs/{jobId}")
  public ResponseEntity<?> getJob(@PathVariable String jobId) {
    Objects.requireNonNull(jobId, "jobId cannot be null");
    log.info("Worker fetching status for job {}", jobId);
    return jobRepository
        .findById(jobId)
        .map(ResponseEntity::ok)
        .orElse(ResponseEntity.notFound().build());
  }

  @GetMapping("/images/{imageId}")
  public ResponseEntity<?> getImageInfo(@PathVariable UUID imageId) {
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Worker requested metadata for image: {}", imageId);
    return imageRepository
        .findById(imageId)
        .map(
            image -> {
              Map<String, Object> map = new HashMap<>();
              map.put("id", image.getId().toString());
              map.put("filename", image.getFilename());
              map.put("storagePath", image.getStoragePath());
              map.put("presignedUrl", minioService.generatePresignedUrl(image.getStoragePath()));
              map.put("panels", panelRepository.findByImageId(imageId));

              // Load OCR regions FIRST (as real entities) before any LayerElement
              // queries that would create lazy proxies in the persistence context
              List<OcrRegion> allOcrRegions = ocrRegionRepository.findByImageId(imageId);

              // Only return OCR regions from the latest OCR layer
              List<Layer> allLayers = layerRepository.findByImageId(imageId);
              Layer latestOcrLayer = null;
              for (Layer l : allLayers) {
                if ("ocr".equalsIgnoreCase(l.getType())
                    && (latestOcrLayer == null || l.getZOrder() > latestOcrLayer.getZOrder())) {
                  latestOcrLayer = l;
                }
              }
              if (latestOcrLayer != null) {
                List<LayerElement> ocrElements =
                    layerElementRepository.findByLayerId(latestOcrLayer.getId());
                Set<UUID> activeRegionIds = new HashSet<>();
                for (LayerElement el : ocrElements) {
                  if (el.getRegion() != null) {
                    activeRegionIds.add(el.getRegion().getId());
                  }
                }
                List<com.manga.library.dto.OcrRegionDto> filteredRegions = new ArrayList<>();
                for (OcrRegion r : allOcrRegions) {
                  if (activeRegionIds.contains(r.getId())) {
                    filteredRegions.add(com.manga.library.dto.OcrRegionDto.fromEntity(r));
                  }
                }
                map.put("ocrRegions", filteredRegions);
              } else {
                // No visible OCR layer — return all regions for backwards compatibility
                List<com.manga.library.dto.OcrRegionDto> allRegionDtos = new ArrayList<>();
                for (OcrRegion r : allOcrRegions) {
                  allRegionDtos.add(com.manga.library.dto.OcrRegionDto.fromEntity(r));
                }
                map.put("ocrRegions", allRegionDtos);
              }

              map.put("layerElements", layerElementRepository.findByLayerImageId(imageId));

              // Query page history and series context for translation context assembly
              pageRepository.findByImageId(imageId).stream()
                  .findFirst()
                  .ifPresent(
                      page -> {
                        Chapter chapter = page.getChapter();
                        Series series = chapter.getSeries();

                        // Series metadata (character rosters, editorial rules)
                        Map<String, Object> seriesMap = new HashMap<>();
                        seriesMap.put("title", series.getTitle());
                        seriesMap.put("originalLanguage", series.getOriginalLanguage());
                        seriesMap.put("readingDirection", series.getReadingDirection());
                        seriesMap.put("metadataJson", series.getMetadataJson());
                        map.put("seriesMetadata", seriesMap);
                        Boolean useMemory = chapter.getUseContextMemory();
                        if (useMemory != null && useMemory) {
                          // Previous page context
                          if (page.getPageNumber() > 1) {
                            List<Page> chapterPages =
                                pageRepository.findByChapterIdOrderByPageNumberAsc(chapter.getId());
                            Page prevPage =
                                chapterPages.stream()
                                    .filter(p -> p.getPageNumber() == page.getPageNumber() - 1)
                                    .findFirst()
                                    .orElse(null);
                            if (prevPage != null) {
                              List<OcrRegion> prevRegions =
                                  ocrRegionRepository.findByImageId(prevPage.getImage().getId());
                              List<String> textList = new ArrayList<>();
                              for (OcrRegion r : prevRegions) {
                                String txt =
                                    r.getTranslatedText() != null
                                        ? r.getTranslatedText()
                                        : r.getText();
                                if (txt != null && !txt.trim().isEmpty()) {
                                  textList.add(txt.trim());
                                }
                              }
                              map.put("previousPageText", String.join(" | ", textList));
                            }
                          }

                          // Chapter summary context
                          if (chapter.getChapterNumber() > 1) {
                            chapterRepository
                                .findBySeriesIdAndChapterNumber(
                                    series.getId(), chapter.getChapterNumber() - 1)
                                .ifPresent(
                                    prevChapter ->
                                        map.put("chapterSummary", prevChapter.getSummaryJson()));
                          }
                        }
                      });

              // Include conversations with their region mappings
              List<Conversation> conversations = conversationRepository.findByImageId(imageId);
              List<Map<String, Object>> convList = new ArrayList<>();
              for (Conversation conv : conversations) {
                Map<String, Object> convMap = new HashMap<>();
                convMap.put("id", conv.getId().toString());
                convMap.put("sceneType", conv.getSceneType());
                List<ConversationRegion> crs =
                    conversationRegionRepository.findByConversationId(conv.getId());
                List<Map<String, Object>> crList = new ArrayList<>();
                for (ConversationRegion cr : crs) {
                  Map<String, Object> crMap = new HashMap<>();
                  crMap.put("regionId", cr.getRegionId().toString());
                  crMap.put("position", cr.getPosition());
                  crList.add(crMap);
                }
                convMap.put("regions", crList);
                convList.add(convMap);
              }
              map.put("conversations", convList);

              return ResponseEntity.ok(map);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/jobs/callback/panel")
  public ResponseEntity<?> panelCallback(@RequestBody PanelCallbackDto dto) {
    log.info("Received panel callback for image: {}", dto.getImageId());
    resolveNotificationContext(dto.getImageId());
    try {
      jobCoordinatorService.handlePanelCallback(dto);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing panel callback", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/ocr")
  public ResponseEntity<?> ocrCallback(@RequestBody OcrCallbackDto dto) {
    log.info("Received OCR callback for image: {}", dto.getImageId());
    resolveNotificationContext(dto.getImageId());
    try {
      jobCoordinatorService.handleOcrCallback(dto);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing OCR callback", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/layout")
  public ResponseEntity<?> layoutCallback(@RequestBody Map<String, Object> payload) {
    UUID imageId = UUID.fromString((String) payload.get("imageId"));
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Received layout callback for image: {}", imageId);
    resolveNotificationContext(imageId);
    try {
      List<?> rawRegionTypes = (List<?>) payload.get("regionTypes");
      List<Map<String, String>> regionTypes = new ArrayList<>();
      if (rawRegionTypes != null) {
        for (Object item : rawRegionTypes) {
          if (item instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) item;
            Map<String, String> typedMap = new HashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
              if (entry.getKey() instanceof String && entry.getValue() instanceof String) {
                typedMap.put((String) entry.getKey(), (String) entry.getValue());
              }
            }
            regionTypes.add(typedMap);
          }
        }
      }
      List<?> rawConversations = (List<?>) payload.get("conversations");
      List<Map<String, Object>> conversations = new ArrayList<>();
      if (rawConversations != null) {
        for (Object item : rawConversations) {
          if (item instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) item;
            Map<String, Object> typedMap = new HashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
              if (entry.getKey() instanceof String) {
                typedMap.put((String) entry.getKey(), entry.getValue());
              }
            }
            conversations.add(typedMap);
          }
        }
      }
      jobCoordinatorService.handleLayoutCallback(imageId, regionTypes, conversations);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing layout callback", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/translation")
  public ResponseEntity<?> translationCallback(@RequestBody Map<String, Object> payload) {
    UUID imageId = UUID.fromString((String) payload.get("imageId"));
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Received translation callback for image: {}", imageId);
    resolveNotificationContext(imageId);
    try {
      List<?> rawTranslations = (List<?>) payload.get("translations");
      List<Map<String, Object>> translations = new ArrayList<>();
      if (rawTranslations != null) {
        for (Object item : rawTranslations) {
          if (item instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) item;
            Map<String, Object> typedMap = new HashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
              if (entry.getKey() instanceof String) {
                typedMap.put((String) entry.getKey(), entry.getValue());
              }
            }
            translations.add(typedMap);
          }
        }
      }
      Map<String, Object> cost = null;
      if (payload.containsKey("cost") && payload.get("cost") instanceof Map) {
        @SuppressWarnings("unchecked")
        Map<String, Object> c = (Map<String, Object>) payload.get("cost");
        cost = c;
      }
      jobCoordinatorService.handleTranslationCallback(imageId, translations, cost);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing translation callback", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/qa-re-ocr")
  public ResponseEntity<?> qaReOcrCallback(@RequestBody Map<String, Object> payload) {
    UUID imageId = UUID.fromString((String) payload.get("imageId"));
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Received QA Re-OCR callback for image: {}", imageId);
    resolveNotificationContext(imageId);
    try {
      List<?> rawResults = (List<?>) payload.get("results");
      List<Map<String, Object>> results = new ArrayList<>();
      if (rawResults != null) {
        for (Object item : rawResults) {
          if (item instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) item;
            Map<String, Object> typedMap = new HashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
              if (entry.getKey() instanceof String) {
                typedMap.put((String) entry.getKey(), entry.getValue());
              }
            }
            results.add(typedMap);
          }
        }
      }
      jobCoordinatorService.handleQaReOcrCallback(imageId, results);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing QA Re-OCR callback", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/ocr-regions/{id}/callback")
  public ResponseEntity<?> regionCallback(
      @PathVariable UUID id, @RequestBody Map<String, Object> payload) {
    Objects.requireNonNull(id, "id cannot be null");
    log.info("Received callback for region redo {}: {}", id, payload);
    try {
      ocrRegionRepository
          .findById(id)
          .ifPresent(
              region -> {
                Objects.requireNonNull(region, "region cannot be null");
                UUID imageId = region.getImage().getId();
                resolveNotificationContext(imageId);
                if (payload.containsKey("text")) {
                  region.setText((String) payload.get("text"));
                }
                if (payload.containsKey("detectedLanguage")) {
                  region.setDetectedLanguage((String) payload.get("detectedLanguage"));
                }
                if (payload.containsKey("translatedText")) {
                  String translatedText = (String) payload.get("translatedText");
                  region.setTranslatedText(translatedText);
                  region.setTranslationFailed(false);

                  // Update active translation layer element
                  List<LayerElement> elements = layerElementRepository.findByRegionId(id);
                  for (LayerElement el : elements) {
                    if (el.getLayer() != null
                        && "translation".equalsIgnoreCase(el.getLayer().getType())
                        && Boolean.TRUE.equals(el.getLayer().getVisible())) {
                      el.setText(translatedText);
                      layerElementRepository.save(el);
                    }
                  }
                }
                if (payload.containsKey("translationFailed")) {
                  Object val = payload.get("translationFailed");
                  region.setTranslationFailed(val != null && Boolean.parseBoolean(val.toString()));
                }
                if (payload.containsKey("confidence")) {
                  region.setConfidence(((Number) payload.get("confidence")).doubleValue());
                }
                ocrRegionRepository.save(region);
              });
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing region callback", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/render")
  public ResponseEntity<?> renderCallback(@RequestBody Map<String, String> payload) {
    UUID imageId = UUID.fromString(payload.get("imageId"));
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Received render callback for image: {}", imageId);
    resolveNotificationContext(imageId);
    try {
      jobCoordinatorService.handleRenderCallback(imageId);
      imageRepository
          .findById(imageId)
          .ifPresent(
              image -> {
                image.setLastRenderedAt(java.time.OffsetDateTime.now());
                imageRepository.save(image);
              });
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing render callback", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/images/{imageId}/qa-hybrid-prepare")
  public ResponseEntity<?> qaHybridPrepare(
      @PathVariable UUID imageId, @RequestBody Map<String, Object> payload) {
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Preparing hybrid QA for image: {}", imageId);
    try {
      List<?> rawResults = (List<?>) payload.get("qaResults");
      List<Map<String, Object>> qaResults = new ArrayList<>();
      if (rawResults != null) {
        for (Object item : rawResults) {
          if (item instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) item;
            Map<String, Object> typedMap = new HashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
              if (entry.getKey() instanceof String) {
                typedMap.put((String) entry.getKey(), entry.getValue());
              }
            }
            qaResults.add(typedMap);
          }
        }
      }
      jobCoordinatorService.prepareHybridQa(imageId, qaResults);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error preparing hybrid QA", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/qa")
  public ResponseEntity<?> qaCallback(@RequestBody Map<String, Object> payload) {
    UUID imageId = UUID.fromString((String) payload.get("imageId"));
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Received QA callback for image: {}", imageId);
    Map<String, String> ctx = resolveNotificationContext(imageId);
    try {
      List<?> rawResults = (List<?>) payload.get("qaResults");
      List<Map<String, Object>> qaResults = new ArrayList<>();
      if (rawResults != null) {
        for (Object item : rawResults) {
          if (item instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) item;
            Map<String, Object> typedMap = new HashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
              if (entry.getKey() instanceof String) {
                typedMap.put((String) entry.getKey(), entry.getValue());
              }
            }
            qaResults.add(typedMap);
          }
        }
      }
      Map<String, Object> cost = null;
      if (payload.containsKey("cost") && payload.get("cost") instanceof Map) {
        @SuppressWarnings("unchecked")
        Map<String, Object> c = (Map<String, Object>) payload.get("cost");
        cost = c;
      }
      String qaResultState = jobCoordinatorService.handleQaCallback(imageId, qaResults, cost);
      if ("COMPLETED".equals(qaResultState)) {
        sseService.emitNotificationForImage(
            imageId,
            "SUCCESS",
            "Page Processing Complete",
            formatMessage("All processing steps finished successfully.", ctx),
            ctx);
      } else if ("MANUAL_REVIEW".equals(qaResultState)) {
        sseService.emitNotificationForImage(
            imageId,
            "WARNING",
            "Manual Review Needed",
            formatMessage(
                "QA pipeline halted because some regions require manual intervention.", ctx),
            ctx);
      }
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing QA callback", e);
      sseService.emitNotificationForImage(
          imageId,
          "ERROR",
          "QA Failed",
          formatMessage("An error occurred during QA checks.", ctx),
          ctx);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  private Map<String, String> resolveNotificationContext(UUID imageId) {
    Map<String, String> context = new HashMap<>();
    if (imageId == null) return context;
    try {
      List<Page> pages = pageRepository.findByImageId(imageId);
      if (pages != null && !pages.isEmpty()) {
        Page page = pages.get(0);
        context.put("pageNumber", String.valueOf(page.getPageNumber()));
        if (page.getChapter() != null) {
          Chapter chapter = page.getChapter();
          context.put("chapterNumber", String.valueOf(chapter.getChapterNumber()));
          context.put("chapterTitle", chapter.getTitle() != null ? chapter.getTitle() : "");
          if (chapter.getSeries() != null) {
            Series series = chapter.getSeries();
            context.put("seriesTitle", series.getTitle() != null ? series.getTitle() : "");
          }
        }
      }
    } catch (Exception e) {
      log.debug("Failed to resolve notification context for image " + imageId, e);
    }
    return context;
  }

  private String formatMessage(String baseText, Map<String, String> ctx) {
    if (ctx == null || ctx.isEmpty()) return baseText;
    String series = ctx.getOrDefault("seriesTitle", "");
    String chNum = ctx.getOrDefault("chapterNumber", "");
    String pNum = ctx.getOrDefault("pageNumber", "");

    StringBuilder sb = new StringBuilder(baseText);
    sb.append(" (");
    if (!series.isEmpty()) {
      sb.append(series).append(" ");
    }
    if (!chNum.isEmpty()) {
      sb.append("Ch.").append(chNum).append(" ");
    }
    if (!pNum.isEmpty()) {
      sb.append("p.").append(pNum);
    }
    sb.append(")");
    return sb.toString().replace(" )", ")").trim();
  }
}
