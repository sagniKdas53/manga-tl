package com.manga.library.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import java.time.OffsetDateTime;
import java.util.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
@RequiredArgsConstructor
@Slf4j
public class JobCoordinatorService {

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;
  private final ImageRepository imageRepository;
  private final PanelRepository panelRepository;
  private final OcrRegionRepository ocrRegionRepository;
  private final ConversationRepository conversationRepository;
  private final ConversationRegionRepository conversationRegionRepository;
  private final LayerRepository layerRepository;
  private final LayerElementRepository layerElementRepository;

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

      String json = objectMapper.writeValueAsString(job);
      String queueName = "queue:" + jobType;
      redisTemplate.opsForList().rightPush(queueName, json);
      log.info("Enqueued {} job for image {} onto {}", jobType, imageId, queueName);
    } catch (Exception e) {
      log.error("Failed to enqueue job for image {}", imageId, e);
    }
  }

  @Transactional
  public void handlePanelCallback(PanelCallbackDto dto) {
    UUID imageId = dto.getImageId();
    log.info(
        "Received panel callback for image: {} with {} panels", imageId, dto.getPanels().size());

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

    Image image =
        imageRepository
            .findById(imageId)
            .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    // Delete existing regions and conversations
    ocrRegionRepository.deleteByImageId(imageId);
    conversationRepository.deleteByImageId(imageId);

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
              .rotation(rData.getRotation() != null ? rData.getRotation() : 0.0)
              .bboxX(rData.getX())
              .bboxY(rData.getY())
              .bboxW(rData.getWidth())
              .bboxH(rData.getHeight())
              .panelReadingOrder(matchingPanel != null ? matchingPanel.getReadingOrder() : 0)
              .bubbleReadingOrder(rData.getBubbleReadingOrder())
              .build();
      regionsToSave.add(region);
    }
    List<OcrRegion> savedRegions = ocrRegionRepository.saveAll(regionsToSave);

    // Create default OCR overlay layer
    Layer ocrLayer = Layer.builder().image(image).type("ocr").visible(true).zOrder(1).build();
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

    // 2. Delete old conversations + conversation_regions for this image
    conversationRegionRepository.deleteByImageId(imageId);
    conversationRepository.deleteByImageId(imageId);

    // 3. Create new Conversation + ConversationRegion entries
    if (conversations != null) {
      for (Map<String, Object> convData : conversations) {
        try {
          String sceneType = (String) convData.getOrDefault("sceneType", "dialogue");
          List<String> regionIds = (List<String>) convData.get("regionIds");

          Conversation conv =
              Conversation.builder()
                  .image(image)
                  .sceneType(sceneType != null ? sceneType : "dialogue")
                  .build();
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
              conversationRegionRepository.save(cr);
            }
          }
        } catch (Exception e) {
          log.error("Error creating conversation", e);
        }
      }
    }

    // 4. Enqueue translation job
    enqueueJob("translation", imageId);
  }

  @Transactional
  public void handleTranslationCallback(UUID imageId, List<Map<String, Object>> translations) {
    log.info(
        "Received Translation callback for image: {} with {} translations",
        imageId,
        translations != null ? translations.size() : 0);

    Image image =
        imageRepository
            .findById(imageId)
            .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

    // Find or create translation layer for this image (language 'en')
    Layer translationLayer =
        layerRepository.findByImageId(imageId).stream()
            .filter(l -> "translation".equals(l.getType()) && "en".equals(l.getTargetLanguage()))
            .findFirst()
            .orElseGet(
                () -> {
                  Layer l =
                      Layer.builder()
                          .image(image)
                          .type("translation")
                          .targetLanguage("en")
                          .visible(true)
                          .zOrder(2)
                          .build();
                  return layerRepository.save(l);
                });

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

          ocrRegionRepository
              .findById(regionId)
              .ifPresent(
                  region -> {
                    // Update backward-compatible OcrRegion fields
                    region.setTranslatedText(translatedText);
                    region.setTranslationFailed(translationFailed);
                    ocrRegionRepository.save(region);

                    // Find or create LayerElement
                    LayerElement element = elementMap.get(regionId);
                    if (element == null) {
                      element =
                          LayerElement.builder()
                              .layer(translationLayer)
                              .region(region)
                              .text(translatedText)
                              .x(region.getBboxX().doubleValue())
                              .y(region.getBboxY().doubleValue())
                              .maxWidth(region.getBboxW())
                              .maxHeight(region.getBboxH())
                              .visible(true)
                              .autoSize(true)
                              .build();
                    } else {
                      element.setText(translatedText);
                    }
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
    log.info("Triggering redo for region {} with type {}", regionId, redoType);

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
      redisTemplate.opsForList().rightPush("queue:region-redo", json);
      log.info("Enqueued region-redo job for region {} onto queue:region-redo", regionId);
    } catch (Exception e) {
      log.error("Failed to enqueue region-redo job for region {}", regionId, e);
    }
  }

  public void triggerImageRedo(UUID imageId, String jobType) {
    log.info("Triggering image redo for image {} with job type {}", imageId, jobType);
    enqueueJob(jobType, imageId);
  }

  @Transactional
  public void handleRenderCallback(UUID imageId) {
    log.info("Received Render callback for image: {}. Pipeline complete!", imageId);
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
}
