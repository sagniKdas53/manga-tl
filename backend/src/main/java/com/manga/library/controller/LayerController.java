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
  private final PageRepository pageRepository;
  private final ObjectMapper objectMapper;
  private final OcrRegionRepository ocrRegionRepository;

  @PutMapping("/layer-elements/{id}")
  @Transactional
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<LayerElement> updateLayerElement(
      @PathVariable UUID id, @RequestBody LayerElementDto dto, @AuthenticationPrincipal User user) {

    Objects.requireNonNull(id, "id cannot be null");
    String userEmail = user != null ? user.getEmail() : "anonymous";
    log.info("Updating LayerElement {} by user {}", id, userEmail);

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
                if (dto.getBackgroundColor() != null)
                  element.setBackgroundColor(dto.getBackgroundColor());
                if (dto.getTextColor() != null) element.setTextColor(dto.getTextColor());
                if (dto.getFontWeight() != null) element.setFontWeight(dto.getFontWeight());
                if (dto.getFontStyle() != null) element.setFontStyle(dto.getFontStyle());
                if (dto.getBoxShape() != null) element.setBoxShape(dto.getBoxShape());
                if (dto.getMaskPolygon() != null) element.setMaskPolygon(dto.getMaskPolygon());
                if (dto.getRegionId() != null) {
                  OcrRegion region =
                      ocrRegionRepository
                          .findById(Objects.requireNonNull(dto.getRegionId()))
                          .orElse(null);
                  element.setRegion(region);
                }

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
                  layerEditHistoryRepository.save(Objects.requireNonNull(history));
                  log.info("Saved edit history for LayerElement {}", id);

                  // Update last_modified on the parent Layer's metadata
                  Layer parentLayer = element.getLayer();
                  if (parentLayer != null) {
                    if (parentLayer.getMetadataJson() != null
                        && parentLayer.getMetadataJson().isObject()) {
                      ((com.fasterxml.jackson.databind.node.ObjectNode)
                              parentLayer.getMetadataJson())
                          .put("last_modified", OffsetDateTime.now().toString());
                    }
                    layerRepository.save(Objects.requireNonNull(parentLayer));

                    Page pg = parentLayer.getPage();
                    if (pg != null) {
                      pg.setLastEditedAt(OffsetDateTime.now());
                      pageRepository.save(Objects.requireNonNull(pg));
                    }
                  }
                }

                LayerElement saved = layerElementRepository.save(Objects.requireNonNull(element));
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

  @PostMapping("/pages/{pageId}/layers")
  @Transactional
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<Layer> createPageLayer(
      @PathVariable UUID pageId, @RequestBody Map<String, Object> payload) {

    Objects.requireNonNull(pageId, "pageId cannot be null");
    log.info("Creating new layer for page {}", pageId);

    return pageRepository
        .findById(Objects.requireNonNull(pageId))
        .map(
            page -> {
              String type = (String) payload.getOrDefault("type", "translation");
              String targetLanguage = (String) payload.get("targetLanguage");

              Boolean visible = true;
              if (payload.get("visible") != null) {
                visible = (Boolean) payload.get("visible");
              }

              Integer zOrder = 0;
              if (payload.get("zOrder") != null) {
                Object raw = payload.get("zOrder");
                if (raw instanceof Integer) {
                  zOrder = (Integer) raw;
                } else if (raw instanceof Number) {
                  zOrder = ((Number) raw).intValue();
                }
              }

              com.fasterxml.jackson.databind.JsonNode metadataJson = null;
              if (payload.get("metadataJson") != null) {
                try {
                  metadataJson = objectMapper.valueToTree(payload.get("metadataJson"));
                } catch (Exception e) {
                  log.warn("Failed to parse metadataJson: {}", e.getMessage());
                }
              }

              Layer layer =
                  Layer.builder()
                      .page(page)
                      .type(type)
                      .targetLanguage(targetLanguage)
                      .visible(visible)
                      .zOrder(zOrder)
                      .metadataJson(metadataJson)
                      .build();

              Objects.requireNonNull(layer, "layer cannot be null");
              Layer saved = layerRepository.save(Objects.requireNonNull(layer));

              page.setLastEditedAt(OffsetDateTime.now());
              pageRepository.save(Objects.requireNonNull(page));

              return ResponseEntity.ok(saved);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/images/{imageId}/layers")
  @Transactional
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<Layer> createLayer(
      @PathVariable UUID imageId, @RequestBody Map<String, Object> payload) {
    Page page =
        pageRepository.findByImageId(imageId).stream()
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("No page found for image: " + imageId));
    return createPageLayer(page.getId(), payload);
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
              Page pg = layer.getPage();
              layerRepository.delete(Objects.requireNonNull(layer));
              if (pg != null) {
                pg.setLastEditedAt(OffsetDateTime.now());
                pageRepository.save(Objects.requireNonNull(pg));
              }
              return ResponseEntity.ok().build();
            })
        .orElse(ResponseEntity.notFound().build());
  }


  /**
   * Updates mutable properties of a Layer: {@code zOrder} and/or {@code visible}.
   *
   * <p>Accepts a JSON body with any subset of:
   *
   * <pre>{ "zOrder": 3, "visible": false }</pre>
   *
   * Only the keys present in the payload are applied — absent keys leave the current value
   * unchanged. This enables safe partial updates from the clone and visibility-toggle flows.
   */
  @PutMapping("/layers/{id}")
  @Transactional
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<Layer> updateLayer(
      @PathVariable UUID id, @RequestBody Map<String, Object> payload) {
    Objects.requireNonNull(id, "id cannot be null");
    log.info("Updating layer {} with payload keys: {}", id, payload.keySet());
    return layerRepository
        .findById(id)
        .map(
            layer -> {
              if (payload.containsKey("zOrder")) {
                Object raw = payload.get("zOrder");
                if (raw instanceof Integer) {
                  layer.setZOrder((Integer) raw);
                } else if (raw instanceof Number) {
                  layer.setZOrder(((Number) raw).intValue());
                }
              }
              if (payload.containsKey("visible")) {
                layer.setVisible(Boolean.TRUE.equals(payload.get("visible")));
              }
              Layer saved = layerRepository.save(Objects.requireNonNull(layer));
              Page pg = saved.getPage();
              if (pg != null) {
                pg.setLastEditedAt(OffsetDateTime.now());
                pageRepository.save(Objects.requireNonNull(pg));
              }
              log.info(
                  "Layer {} updated — zOrder={}, visible={}",
                  id,
                  saved.getZOrder(),
                  saved.getVisible());
              return ResponseEntity.ok(saved);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @PostMapping("/layers/{layerId}/elements")
  @Transactional
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<LayerElement> createLayerElement(
      @PathVariable UUID layerId, @RequestBody LayerElementDto dto) {
    Objects.requireNonNull(layerId, "layerId cannot be null");
    log.info("Creating new LayerElement in layer {}", layerId);
    return layerRepository
        .findById(Objects.requireNonNull(layerId))
        .map(
            layer -> {
              OcrRegion region = null;
              if (dto.getRegionId() != null) {
                region =
                    ocrRegionRepository
                        .findById(Objects.requireNonNull(dto.getRegionId()))
                        .orElse(null);
              }
              LayerElement el =
                  LayerElement.builder()
                      .layer(layer)
                      .region(region)
                      .text(dto.getText() != null ? dto.getText() : "")
                      .font(dto.getFont() != null ? dto.getFont() : "Comic Neue")
                      .size(dto.getSize() != null ? dto.getSize() : 16.0)
                      .autoSize(Boolean.TRUE.equals(dto.getAutoSize()))
                      .maxWidth(dto.getMaxWidth() != null ? dto.getMaxWidth() : 150)
                      .maxHeight(dto.getMaxHeight() != null ? dto.getMaxHeight() : 80)
                      .wordWrap(Boolean.TRUE.equals(dto.getWordWrap()))
                      .rotation(dto.getRotation() != null ? dto.getRotation() : 0.0)
                      .x(dto.getX() != null ? dto.getX() : 100.0)
                      .y(dto.getY() != null ? dto.getY() : 100.0)
                      .visible(dto.getVisible() == null || dto.getVisible())
                      .backgroundColor(dto.getBackgroundColor())
                      .fontWeight(dto.getFontWeight() != null ? dto.getFontWeight() : "normal")
                      .fontStyle(dto.getFontStyle() != null ? dto.getFontStyle() : "normal")
                      .boxShape(dto.getBoxShape() != null ? dto.getBoxShape() : "rectangular")
                      .maskPolygon(dto.getMaskPolygon())
                      .build();
              LayerElement saved = layerElementRepository.save(Objects.requireNonNull(el));
              Page pg = layer.getPage();
              if (pg != null) {
                pg.setLastEditedAt(OffsetDateTime.now());
                pageRepository.save(Objects.requireNonNull(pg));
              }
              return ResponseEntity.ok(saved);
            })
        .orElse(ResponseEntity.notFound().build());
  }

  @DeleteMapping("/layer-elements/{id}")
  @Transactional
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
  public ResponseEntity<?> deleteLayerElement(@PathVariable UUID id) {
    Objects.requireNonNull(id, "id cannot be null");
    log.info("Deleting LayerElement {}", id);
    return layerElementRepository
        .findById(id)
        .map(
            element -> {
              Objects.requireNonNull(element, "element cannot be null");
              Page pg = element.getLayer() != null ? element.getLayer().getPage() : null;
              layerElementRepository.delete(Objects.requireNonNull(element));
              if (pg != null) {
                pg.setLastEditedAt(OffsetDateTime.now());
                pageRepository.save(Objects.requireNonNull(pg));
              }
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
    map.put("backgroundColor", el.getBackgroundColor());
    map.put("textColor", el.getTextColor());
    map.put("fontWeight", el.getFontWeight());
    map.put("fontStyle", el.getFontStyle());
    map.put("boxShape", el.getBoxShape());
    map.put("maskPolygon", el.getMaskPolygon());
    map.put("regionId", el.getRegion() != null ? el.getRegion().getId() : null);
    return map;
  }
}
