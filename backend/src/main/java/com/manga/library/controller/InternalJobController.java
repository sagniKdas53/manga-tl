package com.manga.library.controller;

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
public class InternalJobController {

  private final JobCoordinatorService jobCoordinatorService;
  private final ImageRepository imageRepository;
  private final PanelRepository panelRepository;
  private final OcrRegionRepository ocrRegionRepository;
  private final ConversationRepository conversationRepository;
  private final ConversationRegionRepository conversationRegionRepository;
  private final PageRepository pageRepository;
  private final ChapterRepository chapterRepository;
  private final SeriesRepository seriesRepository;
  private final MinioService minioService;
  private final LayerElementRepository layerElementRepository;
  private final LayerRepository layerRepository;
  private final SseService sseService;

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

                        // Previous page text summary
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
    Map<String, String> ctx = resolveNotificationContext(dto.getImageId());
    try {
      jobCoordinatorService.handlePanelCallback(dto);
      sseService.emitNotificationForImage(
          dto.getImageId(), "INFO", "Panels Extracted", formatMessage("Successfully extracted panels for page.", ctx), ctx);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing panel callback", e);
      sseService.emitNotificationForImage(
          dto.getImageId(),
          "ERROR",
          "Panel Extraction Failed",
          formatMessage("An error occurred while extracting panels.", ctx),
          ctx);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/ocr")
  public ResponseEntity<?> ocrCallback(@RequestBody OcrCallbackDto dto) {
    log.info("Received OCR callback for image: {}", dto.getImageId());
    Map<String, String> ctx = resolveNotificationContext(dto.getImageId());
    try {
      jobCoordinatorService.handleOcrCallback(dto);
      sseService.emitNotificationForImage(
          dto.getImageId(), "INFO", "OCR Completed", formatMessage("Successfully completed OCR processing.", ctx), ctx);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing OCR callback", e);
      sseService.emitNotificationForImage(
          dto.getImageId(), "ERROR", "OCR Failed", formatMessage("An error occurred during OCR processing.", ctx), ctx);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/layout")
  public ResponseEntity<?> layoutCallback(@RequestBody Map<String, Object> payload) {
    UUID imageId = UUID.fromString((String) payload.get("imageId"));
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Received layout callback for image: {}", imageId);
    Map<String, String> ctx = resolveNotificationContext(imageId);
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
      sseService.emitNotificationForImage(
          imageId, "INFO", "Layout Analysis Completed", formatMessage("Layout analysis successfully finished.", ctx), ctx);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing layout callback", e);
      sseService.emitNotificationForImage(
          imageId, "ERROR", "Layout Analysis Failed", formatMessage("An error occurred during layout analysis.", ctx), ctx);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/translation")
  public ResponseEntity<?> translationCallback(@RequestBody Map<String, Object> payload) {
    UUID imageId = UUID.fromString((String) payload.get("imageId"));
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Received translation callback for image: {}", imageId);
    Map<String, String> ctx = resolveNotificationContext(imageId);
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
        cost = (Map<String, Object>) payload.get("cost");
      }
      jobCoordinatorService.handleTranslationCallback(imageId, translations, cost);
      sseService.emitNotificationForImage(
          imageId, "INFO", "Translation Completed", formatMessage("Translation successfully finished.", ctx), ctx);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing translation callback", e);
      sseService.emitNotificationForImage(
          imageId, "ERROR", "Translation Failed", formatMessage("An error occurred during translation.", ctx), ctx);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }

  @PostMapping("/jobs/callback/qa-re-ocr")
  public ResponseEntity<?> qaReOcrCallback(@RequestBody Map<String, Object> payload) {
    UUID imageId = UUID.fromString((String) payload.get("imageId"));
    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Received QA Re-OCR callback for image: {}", imageId);
    Map<String, String> ctx = resolveNotificationContext(imageId);
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
      sseService.emitNotificationForImage(
          imageId, "INFO", "QA Re-OCR Completed", formatMessage("QA Re-OCR successfully finished.", ctx), ctx);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing QA Re-OCR callback", e);
      sseService.emitNotificationForImage(
          imageId, "ERROR", "QA Re-OCR Failed", formatMessage("An error occurred during QA Re-OCR.", ctx), ctx);
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
                Map<String, String> ctx = resolveNotificationContext(imageId);
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
                sseService.emitNotificationForImage(
                    imageId,
                    "INFO",
                    "Region Redo",
                    formatMessage("Region processing successfully updated.", ctx),
                    ctx);
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
    Map<String, String> ctx = resolveNotificationContext(imageId);
    try {
      jobCoordinatorService.handleRenderCallback(imageId);
      sseService.emitNotificationForImage(
          imageId, "INFO", "Render Completed", formatMessage("Successfully rendered typeset image.", ctx), ctx);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing render callback", e);
      sseService.emitNotificationForImage(
          imageId, "ERROR", "Render Failed", formatMessage("An error occurred during rendering.", ctx), ctx);
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
        cost = (Map<String, Object>) payload.get("cost");
      }
      jobCoordinatorService.handleQaCallback(imageId, qaResults, cost);
      sseService.emitNotificationForImage(
          imageId, "INFO", "QA Completed", formatMessage("Quality assurance checks passed.", ctx), ctx);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing QA callback", e);
      sseService.emitNotificationForImage(
          imageId, "WARNING", "QA Issue", formatMessage("An issue occurred during QA checks.", ctx), ctx);
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
