package com.manga.library.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
@RequiredArgsConstructor
@Slf4j
public class JobCoordinatorService {

  @Value("${worker.health-url}")
  private String workerHealthUrl;

  private final HttpClient httpClient =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;
  private final ImageRepository imageRepository;
  private final PanelRepository panelRepository;
  private final OcrRegionRepository ocrRegionRepository;
  private final ConversationRepository conversationRepository;
  private final ConversationRegionRepository conversationRegionRepository;
  private final LayerRepository layerRepository;
  private final LayerElementRepository layerElementRepository;
  private final PageRepository pageRepository;
  private final SseService sseService;
  private final SystemSettingsService systemSettingsService;

  public void startPipeline(UUID imageId) {
    log.info("Starting pipeline for image {}", imageId);
    enqueueJob("panel-detection", imageId);
  }

  private void enqueueJob(String jobType, UUID imageId) {
    if (TransactionSynchronizationManager.isActualTransactionActive()) {
      log.info("Transaction active. Deferring enqueue of {} job for image {}", jobType, imageId);
      TransactionSynchronizationManager.registerSynchronization(
          new TransactionSynchronization() {
            @Override
            public void afterCommit() {
              enqueueJobDirectly(jobType, imageId);
            }
          });
    } else {
      enqueueJobDirectly(jobType, imageId);
    }
  }

  private void enqueueJobDirectly(String jobType, UUID imageId) {
    if (!isWorkerHealthy()) {
      throw new IllegalStateException("Worker is not healthy or unreachable at " + workerHealthUrl);
    }
    try {
      String jobId = UUID.randomUUID().toString();
      Map<String, Object> job = new HashMap<>();
      job.put("jobId", jobId);
      job.put("type", jobType);
      job.put("imageId", imageId.toString());
      job.put("priority", "normal");
      job.put("attempt", 1);
      job.put("maxAttempts", 3);
      job.put("createdAt", OffsetDateTime.now().toString());

      pageRepository.findByImageId(imageId).stream()
          .findFirst()
          .ifPresent(
              page -> {
                if (page.getChapter() != null && page.getChapter().getSeries() != null) {
                  Series series = page.getChapter().getSeries();
                  Chapter chapter = page.getChapter();
                  if (series.getReadingDirection() != null) {
                    job.put("readingDirection", series.getReadingDirection().trim().toLowerCase());
                  }
                  if (series.getSourceLanguage() != null) {
                    job.put("sourceLanguage", series.getSourceLanguage().trim().toLowerCase());
                  }
                  if (series.getTargetLanguage() != null) {
                    job.put("targetLanguage", series.getTargetLanguage().trim().toLowerCase());
                  }
                  job.put("pageNumber", page.getPageNumber());
                  job.put("chapterNumber", chapter.getChapterNumber());

                  com.manga.library.dto.SystemSettingsDto settings =
                      systemSettingsService.getSettings();

                  job.put(
                      "ocrProvider",
                      resolveModel(
                          chapter.getOcrProvider(),
                          series.getOcrProvider(),
                          settings.getOcrProvider()));
                  job.put(
                      "ocrModel",
                      resolveModel(
                          chapter.getOcrModel(), series.getOcrModel(), settings.getOcrModel()));
                  job.put(
                      "tlProvider",
                      resolveModel(
                          chapter.getTlProvider(),
                          series.getTlProvider(),
                          settings.getTlProvider()));
                  job.put(
                      "tlModel",
                      resolveModel(
                          chapter.getTlModel(), series.getTlModel(), settings.getTlModel()));
                  job.put(
                      "qaProvider",
                      resolveModel(
                          chapter.getQaProvider(),
                          series.getQaProvider(),
                          settings.getQaProvider()));
                  job.put(
                      "qaLlmModel",
                      resolveModel(
                          chapter.getQaLlmModel(),
                          series.getQaLlmModel(),
                          settings.getQaLlmModel()));
                  job.put(
                      "qaVlmModel",
                      resolveModel(
                          chapter.getQaVlmModel(),
                          series.getQaVlmModel(),
                          settings.getQaVlmModel()));
                  job.put(
                      "qaMode",
                      resolveModel(
                          chapter.getQaMode(),
                          series.getQaMode(),
                          settings.getQaMode()));
                }
              });

      String json = objectMapper.writeValueAsString(job);
      String queueName = "queue:" + jobType;
      Objects.requireNonNull(queueName, "queueName cannot be null");
      Objects.requireNonNull(json, "json cannot be null");
      redisTemplate.opsForList().rightPush(queueName, json);
      log.info("Enqueued {} job for image {} onto {}", jobType, imageId, queueName);
    } catch (Exception e) {
      log.error("Failed to enqueue job for image {}", imageId, e);
    }
  }

  private String resolveModel(String chapterVal, String seriesVal, String globalVal) {
    if (chapterVal != null
        && !chapterVal.trim().isEmpty()
        && !chapterVal.equals("inherit")
        && !chapterVal.equals("default")) return chapterVal;
    if (seriesVal != null
        && !seriesVal.trim().isEmpty()
        && !seriesVal.equals("inherit")
        && !seriesVal.equals("default")) return seriesVal;
    return globalVal;
  }

  @Transactional
  public void handlePanelCallback(PanelCallbackDto dto) {
    UUID imageId = dto.getImageId();
    log.info(
        "Received panel callback for image: {} with {} panels", imageId, dto.getPanels().size());

    Objects.requireNonNull(imageId, "imageId cannot be null");
    Image image =
        imageRepository
            .findById(imageId)
            .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    // Delete existing panels if any
    panelRepository.deleteByImageId(imageId);

    // Save new panels
    List<Panel> panelsToSave = new ArrayList<>();
    for (PanelCallbackDto.PanelData pData : dto.getPanels()) {
      Panel panel =
          Panel.builder()
              .image(image)
              .bboxX(pData.getX())
              .bboxY(pData.getY())
              .bboxW(pData.getWidth())
              .bboxH(pData.getHeight())
              .gridRow(pData.getGridRow())
              .gridCol(pData.getGridCol())
              .readingOrder(pData.getReadingOrder())
              .build();
      panelsToSave.add(panel);
    }
    panelRepository.saveAll(panelsToSave);

    // Trigger OCR
    enqueueJob("ocr", imageId);
  }

  @Transactional
  public void handleOcrCallback(OcrCallbackDto dto) {
    UUID imageId = dto.getImageId();
    log.info(
        "Received OCR callback for image: {} with {} regions", imageId, dto.getRegions().size());

    Objects.requireNonNull(imageId, "imageId cannot be null");
    Image image =
        imageRepository
            .findById(imageId)
            .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    // Keep existing layers and regions for multi-pass history, but hide old OCR layers
    List<Layer> existingLayers = layerRepository.findByImageId(imageId);
    int maxZ = 0;
    for (Layer layer : existingLayers) {
      if (layer.getZOrder() > maxZ) {
        maxZ = layer.getZOrder();
      }
      if ("ocr".equalsIgnoreCase(layer.getType())) {
        layer.setVisible(false);
        layerRepository.save(layer);
      }
    }
    int nextZOrder = maxZ + 1;

    // Fetch panels to map regions to panels
    List<Panel> panels = panelRepository.findByImageId(imageId);

    // Save OCR Regions
    List<OcrRegion> regionsToSave = new ArrayList<>();
    for (OcrCallbackDto.OcrRegionData rData : dto.getRegions()) {
      // Find which panel this OCR region resides in based on overlap
      Panel matchingPanel =
          findMatchingPanel(
              rData.getX(), rData.getY(), rData.getWidth(), rData.getHeight(), panels);

      OcrRegion region =
          OcrRegion.builder()
              .image(image)
              .panel(matchingPanel)
              .text(rData.getText())
              .detectedLanguage(rData.getDetectedLanguage())
              .confidence(rData.getConfidence())
              .ocrScore(rData.getConfidence())
              .rotation(rData.getRotation() != null ? rData.getRotation() : 0.0)
              .bboxX(rData.getX())
              .bboxY(rData.getY())
              .bboxW(rData.getWidth())
              .bboxH(rData.getHeight())
              .panelReadingOrder(matchingPanel != null ? matchingPanel.getReadingOrder() : 0)
              .bubbleReadingOrder(rData.getBubbleReadingOrder())
              .backgroundColor(rData.getBackgroundColor())
              .bubbleX(rData.getBubbleX())
              .bubbleY(rData.getBubbleY())
              .bubbleW(rData.getBubbleWidth())
              .bubbleH(rData.getBubbleHeight())
              .bubbleId(rData.getBubbleId())
              .detectionConfidence(rData.getDetectionConfidence())
              .maskPolygon(rData.getMaskPolygon())
              .safeTextX(rData.getSafeTextX())
              .safeTextY(rData.getSafeTextY())
              .safeTextW(rData.getSafeTextW())
              .safeTextH(rData.getSafeTextH())
              .build();
      regionsToSave.add(region);
    }
    List<OcrRegion> savedRegions = ocrRegionRepository.saveAll(regionsToSave);

    // Create default OCR overlay layer
    com.fasterxml.jackson.databind.node.ObjectNode metadata = objectMapper.createObjectNode();
    metadata.put("provider", "OCR Worker");
    metadata.put("model", dto.getModelIdentifier() != null ? dto.getModelIdentifier() : "unknown");
    metadata.put("time", OffsetDateTime.now().toString());
    metadata.put("confidence", dto.getConfidence() != null ? dto.getConfidence() : 1.0);

    String ocrReason = redisTemplate.opsForValue().get("image:ocr:reason:" + imageId);
    if (ocrReason != null) {
      metadata.put("layer_name", "OCR (" + ocrReason + ")");
      redisTemplate.delete("image:ocr:reason:" + imageId);
    } else {
      metadata.put("layer_name", "OCR");
    }

    metadata.put("layer_order", nextZOrder);
    metadata.put("last_modified", OffsetDateTime.now().toString());

    Layer ocrLayer =
        Layer.builder()
            .image(image)
            .type("ocr")
            .visible(true)
            .zOrder(nextZOrder)
            .metadataJson(metadata)
            .build();
    Objects.requireNonNull(ocrLayer, "ocrLayer cannot be null");
    layerRepository.save(ocrLayer);

    List<LayerElement> elementsToSave = new ArrayList<>();
    for (OcrRegion region : savedRegions) {
      LayerElement element =
          LayerElement.builder()
              .layer(ocrLayer)
              .region(region)
              .text(region.getText())
              .x(region.getBboxX().doubleValue())
              .y(region.getBboxY().doubleValue())
              .maxWidth(region.getBboxW())
              .maxHeight(region.getBboxH())
              .visible(true)
              .build();
      elementsToSave.add(element);
    }
    layerElementRepository.saveAll(elementsToSave);

    // Trigger Layout analysis
    enqueueJob("layout", imageId);
  }

  @Transactional
  public void handleLayoutCallback(
      UUID imageId,
      List<Map<String, String>> regionTypes,
      List<Map<String, Object>> conversations) {
    log.info(
        "Received Layout callback for image: {} with {} regionTypes, {} conversations",
        imageId,
        regionTypes != null ? regionTypes.size() : 0,
        conversations != null ? conversations.size() : 0);

    Objects.requireNonNull(imageId, "imageId cannot be null");
    Image image =
        imageRepository
            .findById(imageId)
            .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    // 1. Update region_type on each OcrRegion
    if (regionTypes != null) {
      for (Map<String, String> rt : regionTypes) {
        try {
          UUID regionId = UUID.fromString(rt.get("regionId"));
          String regionType = rt.get("regionType");
          Objects.requireNonNull(regionId, "regionId cannot be null");
          ocrRegionRepository
              .findById(regionId)
              .ifPresent(
                  region -> {
                    region.setRegionType(regionType != null ? regionType : "speech");
                    ocrRegionRepository.save(region);
                  });
        } catch (Exception e) {
          log.error("Error updating region type", e);
        }
      }
    }

    // 2. Do not delete old conversations to preserve multi-pass history

    // 3. Create new Conversation + ConversationRegion entries
    if (conversations != null) {
      for (Map<String, Object> convData : conversations) {
        try {
          String sceneType = (String) convData.getOrDefault("sceneType", "dialogue");
          List<?> rawRegionIds = (List<?>) convData.get("regionIds");
          List<String> regionIds = new ArrayList<>();
          if (rawRegionIds != null) {
            for (Object rid : rawRegionIds) {
              if (rid instanceof String) {
                regionIds.add((String) rid);
              }
            }
          }

          Conversation conv =
              Conversation.builder()
                  .image(image)
                  .sceneType(sceneType != null ? sceneType : "dialogue")
                  .build();
          Objects.requireNonNull(conv, "conv cannot be null");
          conv = conversationRepository.save(conv);

          if (regionIds != null) {
            int position = 1;
            for (String ridStr : regionIds) {
              ConversationRegion cr =
                  ConversationRegion.builder()
                      .conversationId(conv.getId())
                      .regionId(UUID.fromString(ridStr))
                      .position(position++)
                      .build();
              Objects.requireNonNull(cr, "cr cannot be null");
              conversationRegionRepository.save(cr);
            }
          }
        } catch (Exception e) {
          log.error("Error creating conversation", e);
        }
      }
    }

    // 4. Enqueue translation job
    boolean isReaderMode = false;
    Series series =
        pageRepository.findByImageId(imageId).stream()
            .findFirst()
            .map(Page::getChapter)
            .map(Chapter::getSeries)
            .orElse(null);
    if (series != null
        && series.getSourceLanguage() != null
        && series.getTargetLanguage() != null) {
      isReaderMode =
          series.getSourceLanguage().trim().equalsIgnoreCase(series.getTargetLanguage().trim());
    }

    if (isReaderMode) {
      log.info(
          "Reader mode detected (source=target={}) for image {}. Skipping translation, render, and QA.",
          series.getSourceLanguage(),
          imageId);
      return;
    }

    enqueueJob("translation", imageId);
  }

  @Transactional
  public void handleTranslationCallback(
      UUID imageId, List<Map<String, Object>> translations, Map<String, Object> cost) {
    log.info(
        "Received Translation callback for image: {} with {} translations",
        imageId,
        translations != null ? translations.size() : 0);

    Objects.requireNonNull(imageId, "imageId cannot be null");
    Image image =
        imageRepository
            .findById(imageId)
            .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    Series series =
        pageRepository.findByImageId(imageId).stream()
            .findFirst()
            .map(Page::getChapter)
            .map(Chapter::getSeries)
            .orElse(null);
    String targetLang =
        (series != null && series.getTargetLanguage() != null)
            ? series.getTargetLanguage().trim().toLowerCase()
            : "en";

    // Find existing translation layers for this image and language
    final String finalTargetLang = targetLang;
    List<Layer> existingTranslationLayers = new ArrayList<>();
    for (Layer l : layerRepository.findByImageId(imageId)) {
      if ("translation".equalsIgnoreCase(l.getType())
          && finalTargetLang.equalsIgnoreCase(l.getTargetLanguage())) {
        existingTranslationLayers.add(l);
      }
    }

    boolean isRedo = !existingTranslationLayers.isEmpty();
    if (isRedo) {
      // Hide old translation layers
      for (Layer old : existingTranslationLayers) {
        old.setVisible(false);
        layerRepository.save(old);
      }
    }

    // Compute z-order from ALL layers (not just translation), so it's always at the top
    List<Layer> allLayers = layerRepository.findByImageId(imageId);
    int maxZ = 0;
    for (Layer l : allLayers) {
      if (l.getZOrder() > maxZ) {
        maxZ = l.getZOrder();
      }
    }
    int nextZOrder = maxZ + 1;

    com.fasterxml.jackson.databind.node.ObjectNode metadata = objectMapper.createObjectNode();
    String modelIdentifier = "unknown";
    Double avgConfidence = 1.0;
    if (translations != null && !translations.isEmpty()) {
      if (translations.get(0).containsKey("modelIdentifier")) {
        modelIdentifier = (String) translations.get(0).get("modelIdentifier");
      }
      if (translations.get(0).containsKey("confidence")) {
        Object confObj = translations.get(0).get("confidence");
        if (confObj instanceof Number) {
          avgConfidence = ((Number) confObj).doubleValue();
        }
      }
    }
    metadata.put("provider", "Translation Worker");
    metadata.put("model", modelIdentifier);
    metadata.put("time", OffsetDateTime.now().toString());
    metadata.put("confidence", avgConfidence);

    String transReason = redisTemplate.opsForValue().get("image:translation:reason:" + imageId);
    if (transReason != null) {
      metadata.put("layer_name", "Translation (" + transReason + ")");
      redisTemplate.delete("image:translation:reason:" + imageId);
    } else if (isRedo) {
      metadata.put("layer_name", "Translation (retry)");
    } else {
      metadata.put("layer_name", "Translation");
    }

    metadata.put("layer_order", nextZOrder);
    metadata.put("last_modified", OffsetDateTime.now().toString());

    if (cost != null) {
      metadata.set("cost", objectMapper.valueToTree(cost));
    }

    final Layer translationLayer =
        layerRepository.save(
            Layer.builder()
                .image(image)
                .type("translation")
                .targetLanguage(finalTargetLang)
                .visible(true)
                .zOrder(nextZOrder)
                .metadataJson(metadata)
                .build());

    if (translations != null) {
      // Find all existing elements for this layer
      List<LayerElement> existingElements =
          layerElementRepository.findByLayerId(translationLayer.getId());
      Map<UUID, LayerElement> elementMap = new HashMap<>();
      for (LayerElement el : existingElements) {
        if (el.getRegion() != null) {
          elementMap.put(el.getRegion().getId(), el);
        }
      }

      for (Map<String, Object> t : translations) {
        try {
          UUID regionId = UUID.fromString((String) t.get("regionId"));
          String translatedText = (String) t.get("translatedText");
          Object failedVal = t.get("translationFailed");
          boolean translationFailed =
              failedVal != null && Boolean.parseBoolean(failedVal.toString());

          Double translationScore =
              t.get("translationScore") != null
                  ? ((Number) t.get("translationScore")).doubleValue()
                  : null;

          Objects.requireNonNull(regionId, "regionId cannot be null");
          ocrRegionRepository
              .findById(regionId)
              .ifPresent(
                  region -> {
                    // Update backward-compatible OcrRegion fields
                    region.setTranslatedText(translatedText);
                    region.setTranslationFailed(translationFailed);
                    region.setTranslationScore(translationScore);
                    ocrRegionRepository.save(region);

                    // Find or create LayerElement
                    LayerElement element = elementMap.get(regionId);
                    if (element == null) {
                      double ex =
                          region.getSafeTextX() != null
                              ? region.getSafeTextX().doubleValue()
                              : region.getBubbleX() != null
                                  ? region.getBubbleX().doubleValue()
                                  : region.getBboxX().doubleValue();
                      double ey =
                          region.getSafeTextY() != null
                              ? region.getSafeTextY().doubleValue()
                              : region.getBubbleY() != null
                                  ? region.getBubbleY().doubleValue()
                                  : region.getBboxY().doubleValue();
                      int ew =
                          region.getSafeTextW() != null
                              ? region.getSafeTextW()
                              : region.getBubbleW() != null
                                  ? region.getBubbleW()
                                  : region.getBboxW();
                      int eh =
                          region.getSafeTextH() != null
                              ? region.getSafeTextH()
                              : region.getBubbleH() != null
                                  ? region.getBubbleH()
                                  : region.getBboxH();

                      element =
                          LayerElement.builder()
                              .layer(translationLayer)
                              .region(region)
                              .text(translatedText)
                              .x(ex)
                              .y(ey)
                              .maxWidth(ew)
                              .maxHeight(eh)
                              .visible(true)
                              .autoSize(true)
                              .font("Comic Neue")
                              .fontWeight("bold")
                              .backgroundColor(region.getBackgroundColor())
                              .textColor(getContrastingTextColor(region.getBackgroundColor()))
                              .boxShape(
                                  "speech".equalsIgnoreCase(region.getRegionType())
                                      ? "elliptical"
                                      : "rectangular")
                              .maskPolygon(region.getMaskPolygon())
                              .build();
                    } else {
                      element.setText(translatedText);
                      if (region.getSafeTextX() != null) {
                        element.setX(region.getSafeTextX().doubleValue());
                        element.setY(region.getSafeTextY().doubleValue());
                        element.setMaxWidth(region.getSafeTextW());
                        element.setMaxHeight(region.getSafeTextH());
                      }
                      element.setMaskPolygon(region.getMaskPolygon());
                    }
                    Objects.requireNonNull(element, "element cannot be null");
                    layerElementRepository.save(element);
                  });
        } catch (Exception e) {
          log.error("Error saving translation for region", e);
        }
      }
    }

    enqueueJob("render", imageId);
  }

  public void triggerRedo(UUID regionId, String redoType) {
    if (!isWorkerHealthy()) {
      throw new IllegalStateException("Worker is not healthy or unreachable at " + workerHealthUrl);
    }
    log.info("Triggering redo for region {} with type {}", regionId, redoType);

    Objects.requireNonNull(regionId, "regionId cannot be null");
    OcrRegion region =
        ocrRegionRepository
            .findById(regionId)
            .orElseThrow(() -> new IllegalArgumentException("Region not found: " + regionId));

    Image image = region.getImage();

    try {
      String jobId = UUID.randomUUID().toString();
      Map<String, Object> job = new HashMap<>();
      job.put("jobId", jobId);
      job.put("type", "region-redo");
      job.put("imageId", image.getId().toString());
      job.put("regionId", regionId.toString());
      job.put("redoType", redoType);
      job.put("priority", "high");
      job.put("attempt", 1);
      job.put("maxAttempts", 3);
      job.put("createdAt", OffsetDateTime.now().toString());

      String json = objectMapper.writeValueAsString(job);
      Objects.requireNonNull(json, "json cannot be null");
      redisTemplate.opsForList().rightPush("queue:region-redo", json);
      log.info("Enqueued region-redo job for region {} onto queue:region-redo", regionId);
    } catch (Exception e) {
      log.error("Failed to enqueue region-redo job for region {}", regionId, e);
    }
  }

  public void triggerImageRedo(UUID imageId, String jobType) {
    log.info("Triggering image redo for image {} with job type {}", imageId, jobType);
    if ("ocr".equals(jobType)) {
      redisTemplate.opsForValue().set("image:ocr:reason:" + imageId, "manual-re-ocr");
    } else if ("translation".equals(jobType)) {
      redisTemplate.opsForValue().set("image:translation:reason:" + imageId, "manual-re-translate");
    }
    enqueueJob(jobType, imageId);
  }

  @Transactional
  public void handleQaReOcrCallback(UUID imageId, List<Map<String, Object>> results) {
    log.info(
        "Received QA Re-OCR callback for image: {} with {} results",
        imageId,
        results != null ? results.size() : 0);
    Objects.requireNonNull(imageId, "imageId cannot be null");

    if (results != null) {
      for (Map<String, Object> r : results) {
        try {
          UUID regionId = UUID.fromString((String) r.get("regionId"));
          String text = (String) r.get("text");
          Double confidence =
              r.get("confidence") != null ? ((Number) r.get("confidence")).doubleValue() : null;
          String detectedLanguage = (String) r.get("detectedLanguage");

          ocrRegionRepository
              .findById(regionId)
              .ifPresent(
                  region -> {
                    region.setText(text);
                    region.setConfidence(confidence);
                    region.setDetectedLanguage(detectedLanguage);
                    region.setQaStatus("re_ocr_completed");
                    ocrRegionRepository.save(region);
                  });
        } catch (Exception e) {
          log.error("Error processing QA Re-OCR result for region", e);
        }
      }
    }

    // Now proceed to retry translation with the new OCR text
    log.info("QA Re-OCR complete for image {}. Enqueuing translation job...", imageId);
    redisTemplate.opsForValue().set("image:translation:reason:" + imageId, "qa-re-ocr");
    enqueueJob("translation", imageId);
  }

  @Transactional
  public void handleRenderCallback(UUID imageId) {
    log.info("Received Render callback for image: {}. Enqueuing QA job...", imageId);
    enqueueJob("qa", imageId);
  }

  @Transactional
  public void handleQaCallback(
      UUID imageId, List<Map<String, Object>> qaResults, Map<String, Object> cost) {
    log.info(
        "Received QA callback for image: {} with {} results",
        imageId,
        qaResults != null ? qaResults.size() : 0);
    Objects.requireNonNull(imageId, "imageId cannot be null");

    boolean needsRetry = false;
    boolean needsManualIntervention = false;
    List<String> regionsToReOcr = new ArrayList<>();

    final List<Map<String, Object>> failedRegionsList = new ArrayList<>();
    final int[] stats =
        new int[5]; // 0: total, 1: passed, 2: failed, 3: direct_fix/fixed, 4: manual_review
    final double[] scoreStats = new double[2]; // 0: sum, 1: count

    if (qaResults != null) {
      for (Map<String, Object> r : qaResults) {
        try {
          UUID regionId = UUID.fromString((String) r.get("regionId"));
          String qaStatus = (String) r.get("qaStatus");
          Double qaScore =
              r.get("qaScore") != null ? ((Number) r.get("qaScore")).doubleValue() : null;
          String qaFeedback = (String) r.get("qaFeedback");

          ocrRegionRepository
              .findById(regionId)
              .ifPresent(
                  region -> {
                    region.setQaStatus(qaStatus);
                    region.setQaScore(qaScore);
                    region.setQaFeedback(qaFeedback);

                    // Check for direct fix first
                    if ("direct_fix".equalsIgnoreCase(qaStatus) && r.containsKey("directFix")) {
                      Map<?, ?> directFix = (Map<?, ?>) r.get("directFix");
                      // Find the layer element in the translation layer
                      List<LayerElement> elements = layerElementRepository.findByRegionId(regionId);
                      for (LayerElement el : elements) {
                        if ("translation".equalsIgnoreCase(el.getLayer().getType())) {
                          if (directFix.containsKey("correctedText")) {
                            el.setText((String) directFix.get("correctedText"));
                            region.setTranslatedText((String) directFix.get("correctedText"));
                          }
                          if (directFix.containsKey("suggestedFontSize")) {
                            el.setSize(((Number) directFix.get("suggestedFontSize")).doubleValue());
                          }
                          layerElementRepository.save(el);
                        }
                      }
                      region.setQaStatus("fixed");
                    } else if ("failed".equalsIgnoreCase(qaStatus) && r.containsKey("escalation")) {
                      Map<?, ?> escalation = (Map<?, ?>) r.get("escalation");

                      if (Boolean.TRUE.equals(escalation.get("needsManualIntervention"))) {
                        region.setQaStatus("manual_review");
                      } else if (Boolean.TRUE.equals(escalation.get("needsReOcr"))) {
                        regionsToReOcr.add(regionId.toString());
                      } else if (Boolean.TRUE.equals(escalation.get("ocrBad"))
                          && escalation.containsKey("correctedSourceText")) {
                        region.setText((String) escalation.get("correctedSourceText"));
                      }

                      if (Boolean.TRUE.equals(escalation.get("orderBad"))
                          && escalation.containsKey("suggestedReadingOrderIndex")) {
                        region.setBubbleReadingOrder(
                            ((Number) escalation.get("suggestedReadingOrderIndex")).intValue());
                      }
                    }
                    ocrRegionRepository.save(region);

                    stats[0]++;
                    String finalStatus = region.getQaStatus();
                    if ("passed".equalsIgnoreCase(finalStatus)) {
                      stats[1]++;
                    } else if ("failed".equalsIgnoreCase(finalStatus)) {
                      stats[2]++;
                    } else if ("fixed".equalsIgnoreCase(finalStatus)
                        || "direct_fix".equalsIgnoreCase(finalStatus)) {
                      stats[3]++;
                    } else if ("manual_review".equalsIgnoreCase(finalStatus)) {
                      stats[4]++;
                    }
                    if (qaScore != null) {
                      scoreStats[0] += qaScore;
                      scoreStats[1]++;
                    }

                    if (!"passed".equalsIgnoreCase(finalStatus)) {
                      Map<String, Object> failedInfo = new HashMap<>();
                      failedInfo.put("regionId", regionId.toString());
                      failedInfo.put("bubbleReadingOrder", region.getBubbleReadingOrder());
                      failedInfo.put("qaStatus", finalStatus);
                      failedInfo.put("qaScore", qaScore);
                      failedInfo.put("qaFeedback", qaFeedback);
                      if (r.containsKey("escalation")) {
                        failedInfo.put("escalation", r.get("escalation"));
                      }
                      failedRegionsList.add(failedInfo);
                    }
                  });

          if ("failed".equalsIgnoreCase(qaStatus)) {
            if (r.containsKey("escalation")
                && Boolean.TRUE.equals(
                    ((Map<?, ?>) r.get("escalation")).get("needsManualIntervention"))) {
              needsManualIntervention = true;
            } else {
              needsRetry = true;
            }
          }
        } catch (Exception e) {
          log.error("Error processing QA result for region", e);
        }
      }
    }

    String retryKey = "image:qa:retries:" + imageId;
    String retryValStr = redisTemplate.opsForValue().get(retryKey);
    int retries = retryValStr != null ? Integer.parseInt(retryValStr) : 0;

    // Save QA info into translation layer metadata_json
    try {
      List<Layer> layers = layerRepository.findByImageId(imageId);
      for (Layer layer : layers) {
        if ("translation".equalsIgnoreCase(layer.getType())) {
          com.fasterxml.jackson.databind.node.ObjectNode metadata =
              layer.getMetadataJson() != null && layer.getMetadataJson().isObject()
                  ? (com.fasterxml.jackson.databind.node.ObjectNode) layer.getMetadataJson()
                  : objectMapper.createObjectNode();

          com.fasterxml.jackson.databind.node.ObjectNode qaNode = objectMapper.createObjectNode();

          String status = "passed";
          if (needsManualIntervention || stats[4] > 0) {
            status = "manual_review";
          } else if (stats[2] > 0) {
            status = needsRetry ? "partial_pass" : "failed";
          } else if (stats[3] > 0) {
            status = "partial_pass";
          }

          qaNode.put("status", status);
          qaNode.put("total_regions", stats[0]);
          qaNode.put("passed", stats[1]);
          qaNode.put("failed", stats[2]);
          qaNode.put("direct_fix", stats[3]);
          qaNode.put("manual_review", stats[4]);
          qaNode.put("avg_score", scoreStats[1] > 0 ? (scoreStats[0] / scoreStats[1]) : 0.0);
          qaNode.put("last_qa_at", OffsetDateTime.now().toString());
          qaNode.put("retries_used", retries);

          com.fasterxml.jackson.databind.node.ArrayNode failedRegionsNode =
              objectMapper.createArrayNode();
          for (Map<String, Object> failedRegion : failedRegionsList) {
            failedRegionsNode.add(objectMapper.valueToTree(failedRegion));
          }
          qaNode.set("failed_regions", failedRegionsNode);

          if (cost != null) {
            qaNode.set("cost", objectMapper.valueToTree(cost));
          }

          metadata.set("qa", qaNode);

          // Legacy layer_name logic for manual review
          if (needsManualIntervention) {
            String currentName =
                metadata.has("layer_name") ? metadata.get("layer_name").asText() : "Translation";
            if (!currentName.contains("qa-manual-review-needed")) {
              metadata.put("layer_name", currentName + " (qa-manual-review-needed)");
            }
          }

          layer.setMetadataJson(metadata);
          layerRepository.save(layer);
        }
      }
    } catch (Exception e) {
      log.error("Failed to update layer metadata with QA results", e);
    }

    if (needsManualIntervention) {
      log.warn("QA requested manual intervention for image {}. Halting pipeline.", imageId);
      redisTemplate.delete(retryKey);
      sseService.emitNotificationForImage(
          imageId,
          "WARNING",
          "Manual Review Needed",
          "QA pipeline halted because some regions require manual intervention.");
    } else if (needsRetry && retries < 2) {
      redisTemplate.opsForValue().set(retryKey, String.valueOf(retries + 1));

      if (!regionsToReOcr.isEmpty()) {
        log.info(
            "QA failed for image {} with Re-OCR request. Retry {}/2. Enqueuing qa-re-ocr job...",
            imageId,
            retries + 1);
        try {
          String jobId = UUID.randomUUID().toString();
          Map<String, Object> job = new HashMap<>();
          job.put("jobId", jobId);
          job.put("type", "qa-re-ocr");
          job.put("imageId", imageId.toString());
          job.put("regionsToReOcr", regionsToReOcr);
          job.put("priority", "high");
          job.put("attempt", 1);
          job.put("maxAttempts", 3);
          job.put("createdAt", OffsetDateTime.now().toString());

          String json = objectMapper.writeValueAsString(job);
          redisTemplate.opsForList().rightPush("queue:qa-re-ocr", json);
        } catch (Exception e) {
          log.error("Failed to enqueue qa-re-ocr job", e);
        }
      } else {
        log.info(
            "QA failed for image {}. Retry {}/2. Enqueuing translation job...",
            imageId,
            retries + 1);
        redisTemplate.opsForValue().set("image:translation:reason:" + imageId, "qa-re-translate");
        enqueueJob("translation", imageId);
      }
    } else {
      if (needsRetry) {
        log.warn("QA failed for image {} but reached max retries. Completing pipeline.", imageId);
      } else {
        log.info("QA passed for image {}. Pipeline complete!", imageId);
      }
      redisTemplate.delete(retryKey);
    }
  }

  private Panel findMatchingPanel(int rx, int ry, int rw, int rh, List<Panel> panels) {
    Panel bestPanel = null;
    double maxOverlapArea = 0;

    for (Panel p : panels) {
      int overlapX =
          Math.max(0, Math.min(rx + rw, p.getBboxX() + p.getBboxW()) - Math.max(rx, p.getBboxX()));
      int overlapY =
          Math.max(0, Math.min(ry + rh, p.getBboxY() + p.getBboxH()) - Math.max(ry, p.getBboxY()));
      double overlapArea = overlapX * overlapY;

      if (overlapArea > maxOverlapArea) {
        maxOverlapArea = overlapArea;
        bestPanel = p;
      }
    }
    return bestPanel;
  }

  public boolean isWorkerHealthy() {
    try {
      HttpRequest request =
          HttpRequest.newBuilder()
              .uri(URI.create(workerHealthUrl))
              .timeout(Duration.ofSeconds(2))
              .GET()
              .build();
      HttpResponse<String> response =
          httpClient.send(request, HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() != 200) {
        log.warn("Worker health check returned status code: {}", response.statusCode());
        return false;
      }
      String body = response.body();
      if (body == null) {
        return false;
      }
      try {
        Map<?, ?> map = objectMapper.readValue(body, Map.class);
        return "healthy".equals(map.get("status"));
      } catch (Exception e) {
        log.warn("Failed to parse worker health check response body: {}", body, e);
        return body.contains("\"status\"") && body.contains("\"healthy\"");
      }
    } catch (Exception e) {
      log.error("Failed to connect to worker health endpoint: {}", workerHealthUrl, e);
      return false;
    }
  }

  private String getContrastingTextColor(String hexColor) {
    if (hexColor == null || !hexColor.startsWith("#") || hexColor.length() < 7) {
      return "#000000";
    }
    try {
      int r = Integer.parseInt(hexColor.substring(1, 3), 16);
      int g = Integer.parseInt(hexColor.substring(3, 5), 16);
      int b = Integer.parseInt(hexColor.substring(5, 7), 16);
      double luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
      return luminance < 0.5 ? "#ffffff" : "#000000";
    } catch (Exception e) {
      return "#000000";
    }
  }
}
