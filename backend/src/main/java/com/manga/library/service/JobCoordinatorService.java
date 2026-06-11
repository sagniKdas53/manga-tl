package com.manga.library.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.OffsetDateTime;
import java.util.*;

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
    private final LayerRepository layerRepository;
    private final LayerElementRepository layerElementRepository;

    public void startPipeline(UUID imageId) {
        log.info("Starting pipeline for image {}", imageId);
        enqueueJob("panel-detection", imageId);
    }

    private void enqueueJob(String jobType, UUID imageId) {
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
        log.info("Received panel callback for image: {} with {} panels", imageId, dto.getPanels().size());

        Image image = imageRepository.findById(imageId)
                .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

        // Delete existing panels if any
        panelRepository.deleteByImageId(imageId);

        // Save new panels
        for (PanelCallbackDto.PanelData pData : dto.getPanels()) {
            Panel panel = Panel.builder()
                    .image(image)
                    .bboxX(pData.getX())
                    .bboxY(pData.getY())
                    .bboxW(pData.getWidth())
                    .bboxH(pData.getHeight())
                    .gridRow(pData.getGridRow())
                    .gridCol(pData.getGridCol())
                    .readingOrder(pData.getReadingOrder())
                    .build();
            panelRepository.save(panel);
        }

        // Trigger OCR
        enqueueJob("ocr", imageId);
    }

    @Transactional
    public void handleOcrCallback(OcrCallbackDto dto) {
        UUID imageId = dto.getImageId();
        log.info("Received OCR callback for image: {} with {} regions", imageId, dto.getRegions().size());

        Image image = imageRepository.findById(imageId)
                .orElseThrow(() -> new IllegalArgumentException("Image not found: " + imageId));

        // Delete existing regions and conversations
        ocrRegionRepository.deleteByImageId(imageId);
        conversationRepository.deleteByImageId(imageId);

        // Fetch panels to map regions to panels
        List<Panel> panels = panelRepository.findByImageId(imageId);

        // Save OCR Regions
        List<OcrRegion> savedRegions = new ArrayList<>();
        for (OcrCallbackDto.OcrRegionData rData : dto.getRegions()) {
            // Find which panel this OCR region resides in based on overlap
            Panel matchingPanel = findMatchingPanel(rData.getX(), rData.getY(), rData.getWidth(), rData.getHeight(), panels);

            OcrRegion region = OcrRegion.builder()
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
            savedRegions.add(ocrRegionRepository.save(region));
        }

        // Create default OCR overlay layer
        Layer ocrLayer = Layer.builder()
                .image(image)
                .type("ocr")
                .visible(true)
                .zOrder(1)
                .build();
        layerRepository.save(ocrLayer);

        for (OcrRegion region : savedRegions) {
            LayerElement element = LayerElement.builder()
                    .layer(ocrLayer)
                    .region(region)
                    .text(region.getText())
                    .x(region.getBboxX().doubleValue())
                    .y(region.getBboxY().doubleValue())
                    .maxWidth(region.getBboxW())
                    .maxHeight(region.getBboxH())
                    .visible(true)
                    .build();
            layerElementRepository.save(element);
        }

        // Trigger Layout analysis
        enqueueJob("layout", imageId);
    }

    @Transactional
    public void handleLayoutCallback(UUID imageId) {
        log.info("Received Layout callback for image: {}", imageId);
        enqueueJob("translation", imageId);
    }

    @Transactional
    public void handleTranslationCallback(UUID imageId) {
        log.info("Received Translation callback for image: {}", imageId);
        enqueueJob("render", imageId);
    }

    @Transactional
    public void handleRenderCallback(UUID imageId) {
        log.info("Received Render callback for image: {}. Pipeline complete!", imageId);
    }

    private Panel findMatchingPanel(int rx, int ry, int rw, int rh, List<Panel> panels) {
        Panel bestPanel = null;
        double maxOverlapArea = 0;

        for (Panel p : panels) {
            int overlapX = Math.max(0, Math.min(rx + rw, p.getBboxX() + p.getBboxW()) - Math.max(rx, p.getBboxX()));
            int overlapY = Math.max(0, Math.min(ry + rh, p.getBboxY() + p.getBboxH()) - Math.max(ry, p.getBboxY()));
            double overlapArea = overlapX * overlapY;

            if (overlapArea > maxOverlapArea) {
                maxOverlapArea = overlapArea;
                bestPanel = p;
            }
        }
        return bestPanel;
    }
}
