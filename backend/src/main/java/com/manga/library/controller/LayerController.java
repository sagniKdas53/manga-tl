package com.manga.library.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.dto.LayerElementDto;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import java.time.OffsetDateTime;
import java.util.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
@Slf4j
public class LayerController {

  private final LayerRepository layerRepository;
  private final LayerElementRepository layerElementRepository;
  private final LayerEditHistoryRepository layerEditHistoryRepository;
  private final ImageRepository imageRepository;
  private final ObjectMapper objectMapper;

  @PutMapping("/layer-elements/{id}")
  @Transactional
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<LayerElement> updateLayerElement(
      @PathVariable UUID id, @RequestBody LayerElementDto dto, @AuthenticationPrincipal User user) {

    Objects.requireNonNull(id, "id cannot be null");
    log.info("Updating LayerElement {} by user {}", id, user.getEmail());

    return layerElementRepository
        .findById(id)
        .map(
            element -> {
              try {
                // Capture previous value state
                Map<String, Object> prevMap = captureStateMap(element);
                String prevJson = objectMapper.writeValueAsString(prevMap);

                // Apply changes from DTO
                if (dto.getText() != null) element.setText(dto.getText());
                if (dto.getFont() != null) element.setFont(dto.getFont());
                if (dto.getSize() != null) element.setSize(dto.getSize());
                if (dto.getAutoSize() != null) element.setAutoSize(dto.getAutoSize());
                if (dto.getMaxWidth() != null) element.setMaxWidth(dto.getMaxWidth());
                if (dto.getMaxHeight() != null) element.setMaxHeight(dto.getMaxHeight());
                if (dto.getWordWrap() != null) element.setWordWrap(dto.getWordWrap());
                if (dto.getRotation() != null) element.setRotation(dto.getRotation());
                if (dto.getX() != null) element.setX(dto.getX());
                if (dto.getY() != null) element.setY(dto.getY());
                if (dto.getVisible() != null) element.setVisible(dto.getVisible());
                if (dto.getOverflow() != null) element.setOverflow(dto.getOverflow());

                element.setIsManuallyEdited(true);
                element.setEditedAt(OffsetDateTime.now());

                // Capture new value state
                Map<String, Object> newMap = captureStateMap(element);
                String newJson = objectMapper.writeValueAsString(newMap);

                // If state changed, save history
                if (!prevJson.equals(newJson)) {
                  LayerEditHistory history =
                      LayerEditHistory.builder()
                          .layerElement(element)
                          .previousValueJson(prevJson)
                          .newValueJson(newJson)
                          .editedBy(user)
                          .build();
                  Objects.requireNonNull(history, "history cannot be null");
                  layerEditHistoryRepository.save(history);
                  log.info("Saved edit history for LayerElement {}", id);
                }

                LayerElement saved = layerElementRepository.save(element);
                return ResponseEntity.ok(saved);

              } catch (Exception e) {
                log.error("Failed to update LayerElement {}", id, e);
                return ResponseEntity.internalServerError().<LayerElement>build();
              }
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @GetMapping("/layer-elements/{id}/history")
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<List<LayerEditHistory>> getLayerElementHistory(@PathVariable UUID id) {
    log.info("Fetching history for LayerElement {}", id);
    List<LayerEditHistory> history =
        layerEditHistoryRepository.findByLayerElementIdOrderByEditedAtDesc(id);
    return ResponseEntity.ok(history);
  }

  @PostMapping("/images/{imageId}/layers")
  @Transactional
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<Layer> createLayer(
      @PathVariable UUID imageId, @RequestBody Map<String, Object> payload) {

    Objects.requireNonNull(imageId, "imageId cannot be null");
    log.info("Creating new layer for image {}", imageId);

    return imageRepository
        .findById(imageId)
        .map(
            image -> {
              String type = (String) payload.getOrDefault("type", "translation");
              String targetLanguage = (String) payload.get("targetLanguage");
              Boolean visible = (Boolean) payload.getOrDefault("visible", true);
              Integer zOrder = (Integer) payload.getOrDefault("zOrder", 0);

              Layer layer =
                  Layer.builder()
                      .image(image)
                      .type(type)
                      .targetLanguage(targetLanguage)
                      .visible(visible)
                      .zOrder(zOrder)
                      .build();

              Objects.requireNonNull(layer, "layer cannot be null");
              Layer saved = layerRepository.save(layer);
              return ResponseEntity.ok(saved);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @DeleteMapping("/layers/{id}")
  @Transactional
  @PreAuthorize("hasRole('ADMIN')")
  public ResponseEntity<?> deleteLayer(@PathVariable UUID id) {
    Objects.requireNonNull(id, "id cannot be null");
    log.info("Deleting layer {}", id);
    return layerRepository
        .findById(id)
        .map(
            layer -> {
              Objects.requireNonNull(layer, "layer cannot be null");
              layerRepository.delete(layer);
              return ResponseEntity.ok().build();
            })
        .orElse(ResponseEntity.notFound().build());
  }

  private Map<String, Object> captureStateMap(LayerElement el) {
    Map<String, Object> map = new HashMap<>();
    map.put("text", el.getText());
    map.put("font", el.getFont());
    map.put("size", el.getSize());
    map.put("autoSize", el.getAutoSize());
    map.put("maxWidth", el.getMaxWidth());
    map.put("maxHeight", el.getMaxHeight());
    map.put("wordWrap", el.getWordWrap());
    map.put("rotation", el.getRotation());
    map.put("x", el.getX());
    map.put("y", el.getY());
    map.put("visible", el.getVisible());
    map.put("overflow", el.getOverflow());
    return map;
  }
}
