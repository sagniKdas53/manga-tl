package com.manga.library.model;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Pins the JSON contract the worker's renderer depends on.
 *
 * <p>{@code handlers/render.py} decides what to draw from {@code layerType} and {@code
 * layerVisible}. Both were absent from the payload for a long time — {@code Layer} is {@code
 * JsonIgnore}d on {@link LayerElement} and nothing flattened it — so the renderer could not
 * distinguish an OCR element from a translation one and drew the source text underneath the
 * translated bubbles on every rendered page.
 *
 * <p>The worker had a passing test for this filter the whole time. It asserted the right behaviour
 * against a hand-written payload that included {@code layerType}, which the backend never sent, so
 * it could not catch the defect. These assertions exist to make the real serialized shape a thing a
 * test can fail on.
 */
class LayerElementSerializationTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private static LayerElement elementOn(String layerType, boolean layerVisible) {
    Layer layer = new Layer();
    layer.setId(UUID.randomUUID());
    layer.setType(layerType);
    layer.setVisible(layerVisible);

    LayerElement element = new LayerElement();
    element.setId(UUID.randomUUID());
    element.setLayer(layer);
    element.setText("hello");
    return element;
  }

  @Test
  void serializesLayerTypeAndVisibilityTheRendererFiltersOn() throws Exception {
    JsonNode json = MAPPER.readTree(MAPPER.writeValueAsString(elementOn("translation", true)));

    assertEquals("translation", json.path("layerType").asText());
    assertTrue(json.path("layerVisible").asBoolean());
    // The renderer reads these exact names; renaming them silently breaks rendering.
    assertTrue(json.has("layerType"), "worker render.py filters on layerType");
    assertTrue(json.has("layerVisible"), "worker render.py filters on layerVisible");
  }

  @Test
  void ocrElementsAreDistinguishableFromTranslationElements() throws Exception {
    JsonNode ocr = MAPPER.readTree(MAPPER.writeValueAsString(elementOn("ocr", true)));

    // The whole point: an OCR element must not look like a translation element on the wire.
    assertEquals("ocr", ocr.path("layerType").asText());
  }

  @Test
  void hiddenLayerIsVisibleAsHiddenOnTheWire() throws Exception {
    JsonNode json = MAPPER.readTree(MAPPER.writeValueAsString(elementOn("translation", false)));

    // Layer visibility toggled in the reader has to reach the renderer, or a hidden layer still
    // gets burned into the exported page.
    assertFalse(json.path("layerVisible").asBoolean());
  }

  @Test
  void regionTypeIsExposedForCasingDecisions() throws Exception {
    LayerElement element = elementOn("translation", true);
    OcrRegion region = new OcrRegion();
    region.setId(UUID.randomUUID());
    region.setRegionType("speech");
    element.setRegion(region);

    JsonNode json = MAPPER.readTree(MAPPER.writeValueAsString(element));

    assertEquals("speech", json.path("regionType").asText());
  }

  @Test
  void detachedElementSerializesWithoutLayerRatherThanThrowing() throws Exception {
    LayerElement orphan = new LayerElement();
    orphan.setId(UUID.randomUUID());

    JsonNode json = MAPPER.readTree(MAPPER.writeValueAsString(orphan));

    // Null rather than an exception, and the renderer fails closed on it.
    assertTrue(json.path("layerType").isNull());
    assertTrue(json.path("layerVisible").isNull());
  }
}
