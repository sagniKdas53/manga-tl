package com.manga.library.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.dto.LayerElementDto;
import com.manga.library.exception.ResourceNotFoundException;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import java.time.OffsetDateTime;
import java.util.*;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class LayerController {
  private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(LayerController.class);


  private final LayerRepository layerRepository;
  private final LayerElementRepository layerElementRepository;
  private final LayerEditHistoryRepository layerEditHistoryRepository;
  private final PageRepository pageRepository;
  private final ObjectMapper objectMapper;
  private final OcrRegionRepository ocrRegionRepository;
  public LayerController(LayerRepository layerRepository, LayerElementRepository layerElementRepository, LayerEditHistoryRepository layerEditHistoryRepository, PageRepository pageRepository, ObjectMapper objectMapper, OcrRegionRepository ocrRegionRepository) {
    this.layerRepository = layerRepository;
    this.layerElementRepository = layerElementRepository;
    this.layerEditHistoryRepository = layerEditHistoryRepository;
    this.pageRepository = pageRepository;
    this.objectMapper = objectMapper;
    this.ocrRegionRepository = ocrRegionRepository;
  }


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
                if (dto.text() != null) element.setText(dto.text());
                if (dto.font() != null) element.setFont(dto.font());
                if (dto.size() != null) element.setSize(dto.size());
                if (dto.autoSize() != null) element.setAutoSize(dto.autoSize());
                if (dto.maxWidth() != null) element.setMaxWidth(dto.maxWidth());
                if (dto.maxHeight() != null) element.setMaxHeight(dto.maxHeight());
                if (dto.wordWrap() != null) element.setWordWrap(dto.wordWrap());
                if (dto.rotation() != null) element.setRotation(dto.rotation());
                if (dto.x() != null) element.setX(dto.x());
                if (dto.y() != null) element.setY(dto.y());
                if (dto.visible() != null) element.setVisible(dto.visible());
                if (dto.overflow() != null) element.setOverflow(dto.overflow());
                if (dto.backgroundColor() != null)
                  element.setBackgroundColor(dto.backgroundColor());
                if (dto.textColor() != null) element.setTextColor(dto.textColor());
                if (dto.fontWeight() != null) element.setFontWeight(dto.fontWeight());
                if (dto.fontStyle() != null) element.setFontStyle(dto.fontStyle());
                if (dto.boxShape() != null) element.setBoxShape(dto.boxShape());
                if (dto.maskPolygon() != null) element.setMaskPolygon(dto.maskPolygon());
                if (dto.regionId() != null) {
                  OcrRegion region =
                      ocrRegionRepository
                          .findById(Objects.requireNonNull(dto.regionId()))
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
                  LayerEditHistory history = new LayerEditHistory();
                  history.setLayerElement(element);
                  history.setPreviousValueJson(prevJson);
                  history.setNewValueJson(newJson);
                  history.setEditedBy(user);
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

              Layer layer = new Layer();
              layer.setPage(page);
              layer.setType(type);
              layer.setTargetLanguage(targetLanguage);
              layer.setVisible(visible);
              layer.setZOrder(zOrder);
              layer.setMetadataJson(metadataJson);

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
            .orElseThrow(
                () -> new ResourceNotFoundException("No page found for image: " + imageId));
    return createPageLayer(page.getId(), payload);
  }

  @DeleteMapping("/layers/{id}")
  @Transactional
  @PreAuthorize("hasAnyRole('ADMIN', 'TRANSLATOR')")
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
              if (dto.regionId() != null) {
                region =
                    ocrRegionRepository
                        .findById(Objects.requireNonNull(dto.regionId()))
                        .orElse(null);
              }
              LayerElement el = new LayerElement();
              el.setLayer(layer);
              el.setRegion(region);
              el.setText(dto.text() != null ? dto.text() : "");
              el.setFont(dto.font() != null ? dto.font() : "Comic Neue");
              el.setSize(dto.size() != null ? dto.size() : 16.0);
              el.setAutoSize(Boolean.TRUE.equals(dto.autoSize()));
              el.setMaxWidth(dto.maxWidth() != null ? dto.maxWidth() : 150);
              el.setMaxHeight(dto.maxHeight() != null ? dto.maxHeight() : 80);
              el.setWordWrap(Boolean.TRUE.equals(dto.wordWrap()));
              el.setRotation(dto.rotation() != null ? dto.rotation() : 0.0);
              el.setX(dto.x() != null ? dto.x() : 100.0);
              el.setY(dto.y() != null ? dto.y() : 100.0);
              el.setVisible(dto.visible() == null || dto.visible());
              el.setBackgroundColor(dto.backgroundColor());
              el.setFontWeight(dto.fontWeight() != null ? dto.fontWeight() : "normal");
              el.setFontStyle(dto.fontStyle() != null ? dto.fontStyle() : "normal");
              el.setBoxShape(dto.boxShape() != null ? dto.boxShape() : "rectangular");
              el.setMaskPolygon(dto.maskPolygon());
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
