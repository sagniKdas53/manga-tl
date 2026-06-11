package com.manga.library.controller;

import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.model.Image;
import com.manga.library.repository.ImageRepository;
import com.manga.library.repository.PanelRepository;
import com.manga.library.service.JobCoordinatorService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
import java.util.UUID;
import java.util.HashMap;

@RestController
@RequestMapping("/api/internal")
@RequiredArgsConstructor
@Slf4j
public class InternalJobController {

    private final JobCoordinatorService jobCoordinatorService;
    private final ImageRepository imageRepository;
    private final PanelRepository panelRepository;

    @GetMapping("/images/{imageId}")
    public ResponseEntity<?> getImageInfo(@PathVariable UUID imageId) {
        log.info("Worker requested metadata for image: {}", imageId);
        return imageRepository.findById(imageId)
                .map(image -> {
                    Map<String, Object> map = new HashMap<>();
                    map.put("id", image.getId().toString());
                    map.put("filename", image.getFilename());
                    map.put("storagePath", image.getStoragePath());
                    map.put("panels", panelRepository.findByImageId(imageId));
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
    public ResponseEntity<?> layoutCallback(@RequestBody Map<String, String> payload) {
        UUID imageId = UUID.fromString(payload.get("imageId"));
        log.info("Received layout callback for image: {}", imageId);
        try {
            jobCoordinatorService.handleLayoutCallback(imageId);
            return ResponseEntity.ok().build();
        } catch (Exception e) {
            log.error("Error processing layout callback", e);
            return ResponseEntity.internalServerError().body(e.getMessage());
        }
    }

    @PostMapping("/jobs/callback/translation")
    public ResponseEntity<?> translationCallback(@RequestBody Map<String, String> payload) {
        UUID imageId = UUID.fromString(payload.get("imageId"));
        log.info("Received translation callback for image: {}", imageId);
        try {
            jobCoordinatorService.handleTranslationCallback(imageId);
            return ResponseEntity.ok().build();
        } catch (Exception e) {
            log.error("Error processing translation callback", e);
            return ResponseEntity.internalServerError().body(e.getMessage());
        }
    }

    @PostMapping("/jobs/callback/render")
    public ResponseEntity<?> renderCallback(@RequestBody Map<String, String> payload) {
        UUID imageId = UUID.fromString(payload.get("imageId"));
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

