package com.manga.library.controller;

import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.MinioService;
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
  private final com.manga.library.repository.OcrRegionRepository ocrRegionRepository;
  private final ConversationRepository conversationRepository;
  private final ConversationRegionRepository conversationRegionRepository;
  private final PageRepository pageRepository;
  private final ChapterRepository chapterRepository;
  private final MinioService minioService;

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
              map.put("ocrRegions", ocrRegionRepository.findByImageId(imageId));

              // Query page history and series context for translation context assembly
              pageRepository
                  .findByImageId(imageId)
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
      jobCoordinatorService.handleTranslationCallback(imageId, translations);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing translation callback", e);
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
                if (payload.containsKey("text")) {
                  region.setText((String) payload.get("text"));
                }
                if (payload.containsKey("detectedLanguage")) {
                  region.setDetectedLanguage((String) payload.get("detectedLanguage"));
                }
                if (payload.containsKey("translatedText")) {
                  region.setTranslatedText((String) payload.get("translatedText"));
                  region.setTranslationFailed(false);
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
    try {
      jobCoordinatorService.handleRenderCallback(imageId);
      return ResponseEntity.ok().build();
    } catch (Exception e) {
      log.error("Error processing render callback", e);
      return ResponseEntity.internalServerError().body(e.getMessage());
    }
  }
}
