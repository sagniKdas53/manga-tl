package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.model.*;
import com.manga.library.repository.*;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.*;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.util.ReflectionTestUtils;

@SpringBootTest
public class JobCoordinatorServiceTest {

  @Autowired private JobCoordinatorService jobCoordinatorService;
  @Autowired private ImageRepository imageRepository;
  @Autowired private OcrRegionRepository ocrRegionRepository;
  @Autowired private LayerRepository layerRepository;
  @Autowired private LayerElementRepository layerElementRepository;

  @org.springframework.boot.test.mock.mockito.MockBean
  private org.springframework.data.redis.core.StringRedisTemplate redisTemplate;

  private HttpServer testServer;
  private int testPort;
  private String originalUrl;

  @BeforeEach
  public void setUp() throws IOException {
    originalUrl = (String) ReflectionTestUtils.getField(jobCoordinatorService, "workerHealthUrl");
    testServer = HttpServer.create(new InetSocketAddress(0), 0);
    testPort = testServer.getAddress().getPort();
    testServer.createContext(
        "/default-health",
        new HttpHandler() {
          @Override
          public void handle(HttpExchange exchange) throws IOException {
            String response = "{\"status\":\"healthy\",\"redis\":\"connected\"}";
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length());
            try (OutputStream os = exchange.getResponseBody()) {
              os.write(response.getBytes());
            }
          }
        });
    testServer.start();
    ReflectionTestUtils.setField(
        jobCoordinatorService,
        "workerHealthUrl",
        "http://localhost:" + testPort + "/default-health");

    // Set up mock for redisTemplate using in-memory structures
    final Map<String, String> mockRedisValueStore = new HashMap<>();
    final Map<String, List<String>> mockRedisListStore = new HashMap<>();

    org.springframework.data.redis.core.ValueOperations<String, String> valueOps =
        org.mockito.Mockito.mock(org.springframework.data.redis.core.ValueOperations.class);
    org.mockito.Mockito.when(valueOps.get(org.mockito.Mockito.anyString()))
        .thenAnswer(invocation -> mockRedisValueStore.get(invocation.getArgument(0)));
    org.mockito.Mockito.doAnswer(
            invocation -> {
              mockRedisValueStore.put(invocation.getArgument(0), invocation.getArgument(1));
              return null;
            })
        .when(valueOps)
        .set(org.mockito.Mockito.anyString(), org.mockito.Mockito.anyString());

    org.springframework.data.redis.core.ListOperations<String, String> listOps =
        org.mockito.Mockito.mock(org.springframework.data.redis.core.ListOperations.class);
    org.mockito.Mockito.when(
            listOps.rightPush(org.mockito.Mockito.anyString(), org.mockito.Mockito.anyString()))
        .thenAnswer(
            invocation -> {
              String key = invocation.getArgument(0);
              String val = invocation.getArgument(1);
              mockRedisListStore.computeIfAbsent(key, k -> new ArrayList<>()).add(val);
              return (long) mockRedisListStore.get(key).size();
            });
    org.mockito.Mockito.when(listOps.size(org.mockito.Mockito.anyString()))
        .thenAnswer(
            invocation -> {
              String key = invocation.getArgument(0);
              List<String> list = mockRedisListStore.get(key);
              return list == null ? 0L : (long) list.size();
            });

    org.mockito.Mockito.when(redisTemplate.opsForValue()).thenReturn(valueOps);
    org.mockito.Mockito.when(redisTemplate.opsForList()).thenReturn(listOps);
    org.mockito.Mockito.when(redisTemplate.delete(org.mockito.Mockito.anyString()))
        .thenAnswer(
            invocation -> {
              String key = invocation.getArgument(0);
              boolean existed =
                  mockRedisValueStore.remove(key) != null || mockRedisListStore.remove(key) != null;
              return existed;
            });
  }

  @AfterEach
  public void tearDown() {
    if (testServer != null) {
      testServer.stop(0);
    }
    ReflectionTestUtils.setField(jobCoordinatorService, "workerHealthUrl", originalUrl);
  }

  @Test
  public void testIsWorkerHealthy_Healthy() {
    testServer.createContext(
        "/health",
        new HttpHandler() {
          @Override
          public void handle(HttpExchange exchange) throws IOException {
            String response = "{\"status\":\"healthy\",\"redis\":\"connected\"}";
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length());
            try (OutputStream os = exchange.getResponseBody()) {
              os.write(response.getBytes());
            }
          }
        });

    ReflectionTestUtils.setField(
        jobCoordinatorService, "workerHealthUrl", "http://localhost:" + testPort + "/health");
    assertTrue(jobCoordinatorService.isWorkerHealthy());
  }

  @Test
  public void testIsWorkerHealthy_HealthyWithSpaces() {
    testServer.createContext(
        "/health-spaces",
        new HttpHandler() {
          @Override
          public void handle(HttpExchange exchange) throws IOException {
            String response = "{ \"status\": \"healthy\", \"redis\": \"connected\" }";
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length());
            try (OutputStream os = exchange.getResponseBody()) {
              os.write(response.getBytes());
            }
          }
        });

    ReflectionTestUtils.setField(
        jobCoordinatorService,
        "workerHealthUrl",
        "http://localhost:" + testPort + "/health-spaces");
    assertTrue(jobCoordinatorService.isWorkerHealthy());
  }

  @Test
  public void testIsWorkerHealthy_UnhealthyStatus() {
    testServer.createContext(
        "/health",
        new HttpHandler() {
          @Override
          public void handle(HttpExchange exchange) throws IOException {
            String response = "{\"status\":\"unhealthy\",\"redis\":\"disconnected\"}";
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(500, response.length());
            try (OutputStream os = exchange.getResponseBody()) {
              os.write(response.getBytes());
            }
          }
        });

    ReflectionTestUtils.setField(
        jobCoordinatorService, "workerHealthUrl", "http://localhost:" + testPort + "/health");
    assertFalse(jobCoordinatorService.isWorkerHealthy());
  }

  @Test
  public void testIsWorkerHealthy_Offline() {
    testServer.stop(0);
    testServer = null;

    ReflectionTestUtils.setField(
        jobCoordinatorService, "workerHealthUrl", "http://localhost:" + testPort + "/health");
    assertFalse(jobCoordinatorService.isWorkerHealthy());
  }

  @Test
  public void testHandleQaCallback_Passed() {
    Image image = Image.builder().filename("test.png").storagePath("test/test.png").build();
    image = imageRepository.save(image);

    OcrRegion region =
        OcrRegion.builder()
            .image(image)
            .bboxX(10)
            .bboxY(20)
            .bboxW(100)
            .bboxH(50)
            .text("こんにちは")
            .detectedLanguage("ja")
            .confidence(0.9)
            .qaStatus("pending")
            .build();
    region = ocrRegionRepository.save(region);

    Map<String, Object> qaResult = new HashMap<>();
    qaResult.put("regionId", region.getId().toString());
    qaResult.put("qaStatus", "passed");
    qaResult.put("qaScore", 0.95);
    qaResult.put("qaFeedback", "All good");

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult), null);

    OcrRegion updatedRegion = ocrRegionRepository.findById(region.getId()).orElseThrow();
    assertEquals("passed", updatedRegion.getQaStatus());
    assertEquals(0.95, updatedRegion.getQaScore());
    assertEquals("All good", updatedRegion.getQaFeedback());

    // Clean up
    ocrRegionRepository.delete(updatedRegion);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleQaCallback_DirectFix() {
    Image image = Image.builder().filename("test_df.png").storagePath("test/test_df.png").build();
    image = imageRepository.save(image);

    Layer layer =
        Layer.builder()
            .image(image)
            .type("translation")
            .targetLanguage("en")
            .visible(true)
            .zOrder(2)
            .build();
    layer = layerRepository.save(layer);

    OcrRegion region =
        OcrRegion.builder()
            .image(image)
            .bboxX(10)
            .bboxY(20)
            .bboxW(100)
            .bboxH(50)
            .text("こんにちは")
            .detectedLanguage("ja")
            .confidence(0.9)
            .qaStatus("pending")
            .build();
    region = ocrRegionRepository.save(region);

    LayerElement element =
        LayerElement.builder()
            .layer(layer)
            .region(region)
            .text("Hello")
            .size(12.0)
            .x(10.0)
            .y(20.0)
            .visible(true)
            .build();
    element = layerElementRepository.save(element);

    Map<String, Object> qaResult = new HashMap<>();
    qaResult.put("regionId", region.getId().toString());
    qaResult.put("qaStatus", "direct_fix");
    qaResult.put("qaScore", 0.85);
    qaResult.put("qaFeedback", "Tweak text");

    Map<String, Object> directFix = new HashMap<>();
    directFix.put("correctedText", "Hello World");
    directFix.put("suggestedFontSize", 10.0);
    qaResult.put("directFix", directFix);

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult), null);

    OcrRegion updatedRegion = ocrRegionRepository.findById(region.getId()).orElseThrow();
    assertEquals("fixed", updatedRegion.getQaStatus());

    List<LayerElement> elements = layerElementRepository.findByRegionId(region.getId());
    assertFalse(elements.isEmpty());
    LayerElement updatedElement = elements.get(0);
    assertEquals("Hello World", updatedElement.getText());
    assertEquals(10.0, updatedElement.getSize());

    // Clean up
    layerElementRepository.delete(updatedElement);
    ocrRegionRepository.delete(updatedRegion);
    layerRepository.delete(layer);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleQaCallback_FailedWithRetry() {
    Image image =
        Image.builder().filename("test_retry.png").storagePath("test/test_retry.png").build();
    image = imageRepository.save(image);

    OcrRegion region =
        OcrRegion.builder()
            .image(image)
            .bboxX(10)
            .bboxY(20)
            .bboxW(100)
            .bboxH(50)
            .text("こんにちは")
            .detectedLanguage("ja")
            .confidence(0.9)
            .qaStatus("pending")
            .build();
    region = ocrRegionRepository.save(region);

    String retryKey = "image:qa:retries:" + image.getId();
    redisTemplate.delete(retryKey);

    Map<String, Object> qaResult = new HashMap<>();
    qaResult.put("regionId", region.getId().toString());
    qaResult.put("qaStatus", "failed");
    qaResult.put("qaScore", 0.4);
    qaResult.put("qaFeedback", "Bad translation");

    // Clean any prior enqueued job to test enqueue
    String queueName = "queue:translation";
    redisTemplate.delete(queueName);

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult), null);

    OcrRegion updatedRegion = ocrRegionRepository.findById(region.getId()).orElseThrow();
    assertEquals("failed", updatedRegion.getQaStatus());
    assertEquals(0.4, updatedRegion.getQaScore());
    assertEquals("Bad translation", updatedRegion.getQaFeedback());

    // Redis retry key should be incremented to 1
    String retries = redisTemplate.opsForValue().get(retryKey);
    assertEquals("1", retries);

    // Job coordinator service should enqueue a translation job
    Long size = redisTemplate.opsForList().size(queueName);
    assertTrue(size != null && size >= 0);

    // Clean up
    redisTemplate.delete(retryKey);
    redisTemplate.delete(queueName);
    ocrRegionRepository.delete(updatedRegion);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleQaCallback_FailedMaxRetries() {
    Image image =
        Image.builder()
            .filename("test_max_retry.png")
            .storagePath("test/test_max_retry.png")
            .build();
    image = imageRepository.save(image);

    OcrRegion region =
        OcrRegion.builder()
            .image(image)
            .bboxX(10)
            .bboxY(20)
            .bboxW(100)
            .bboxH(50)
            .text("こんにちは")
            .detectedLanguage("ja")
            .confidence(0.9)
            .qaStatus("pending")
            .build();
    region = ocrRegionRepository.save(region);

    String retryKey = "image:qa:retries:" + image.getId();
    redisTemplate.opsForValue().set(retryKey, "2");

    Map<String, Object> qaResult = new HashMap<>();
    qaResult.put("regionId", region.getId().toString());
    qaResult.put("qaStatus", "failed");
    qaResult.put("qaScore", 0.3);
    qaResult.put("qaFeedback", "Still bad");

    String queueName = "queue:translation";
    redisTemplate.delete(queueName);

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult), null);

    OcrRegion updatedRegion = ocrRegionRepository.findById(region.getId()).orElseThrow();
    assertEquals("failed", updatedRegion.getQaStatus());

    // Redis retry key should be deleted
    String retries = redisTemplate.opsForValue().get(retryKey);
    assertNull(retries);

    // No translation job should be enqueued because max retries reached
    Long size = redisTemplate.opsForList().size(queueName);
    assertTrue(size == null || size == 0);

    // Clean up
    ocrRegionRepository.delete(updatedRegion);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleQaCallback_Escalation() {
    Image image = Image.builder().filename("test_esc.png").storagePath("test/test_esc.png").build();
    image = imageRepository.save(image);

    OcrRegion region =
        OcrRegion.builder()
            .image(image)
            .bboxX(10)
            .bboxY(20)
            .bboxW(100)
            .bboxH(50)
            .text("こんにちは")
            .detectedLanguage("ja")
            .confidence(0.9)
            .bubbleReadingOrder(1)
            .qaStatus("pending")
            .build();
    region = ocrRegionRepository.save(region);

    Map<String, Object> qaResult = new HashMap<>();
    qaResult.put("regionId", region.getId().toString());
    qaResult.put("qaStatus", "failed");
    qaResult.put("qaScore", 0.2);
    qaResult.put("qaFeedback", "Incorrect order and bad OCR");

    Map<String, Object> escalation = new HashMap<>();
    escalation.put("ocrBad", true);
    escalation.put("correctedSourceText", "こんばんは");
    escalation.put("orderBad", true);
    escalation.put("suggestedReadingOrderIndex", 3);
    qaResult.put("escalation", escalation);

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult), null);

    OcrRegion updatedRegion = ocrRegionRepository.findById(region.getId()).orElseThrow();
    assertEquals("failed", updatedRegion.getQaStatus());
    assertEquals("こんばんは", updatedRegion.getText());
    assertEquals(3, updatedRegion.getBubbleReadingOrder().intValue());

    // Clean up
    ocrRegionRepository.delete(updatedRegion);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleTranslationCallback_NewElement() {
    Image image =
        Image.builder().filename("test_trans.png").storagePath("test/test_trans.png").build();
    image = imageRepository.save(image);

    OcrRegion region =
        OcrRegion.builder()
            .image(image)
            .bboxX(10)
            .bboxY(20)
            .bboxW(100)
            .bboxH(50)
            .text("こんにちは")
            .detectedLanguage("ja")
            .confidence(0.9)
            .regionType("speech")
            .build();
    region = ocrRegionRepository.save(region);

    Map<String, Object> translation = new HashMap<>();
    translation.put("regionId", region.getId().toString());
    translation.put("translatedText", "Hello");
    translation.put("translationFailed", false);
    translation.put("translationScore", 0.98);

    jobCoordinatorService.handleTranslationCallback(image.getId(), List.of(translation), null);

    // Verify OcrRegion updated
    OcrRegion updatedRegion = ocrRegionRepository.findById(region.getId()).orElseThrow();
    assertEquals("Hello", updatedRegion.getTranslatedText());
    assertFalse(updatedRegion.getTranslationFailed());
    assertEquals(0.98, updatedRegion.getTranslationScore(), 0.001);

    // Verify LayerElement created and saved
    List<LayerElement> elements = layerElementRepository.findByRegionId(region.getId());
    assertFalse(elements.isEmpty());
    LayerElement el = elements.get(0);
    assertEquals("Hello", el.getText());
    assertEquals(10.0, el.getX(), 0.001);
    assertEquals(20.0, el.getY(), 0.001);
    assertEquals(100, el.getMaxWidth().intValue());
    assertEquals(50, el.getMaxHeight().intValue());

    // Clean up
    layerElementRepository.delete(el);
    List<Layer> layers = layerRepository.findByImageId(image.getId());
    for (Layer l : layers) {
      layerRepository.delete(l);
    }
    ocrRegionRepository.delete(updatedRegion);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleTranslationCallback_RedoAndCostAndRedisReason() {
    Image rawImage =
        Image.builder().filename("test_redo.png").storagePath("test/test_redo.png").build();
    final Image image = imageRepository.save(rawImage);

    Layer rawLayer =
        Layer.builder()
            .image(image)
            .type("translation")
            .targetLanguage("en")
            .visible(true)
            .zOrder(1)
            .build();
    final Layer existingLayer = layerRepository.save(rawLayer);

    String reasonKey = "image:translation:reason:" + image.getId();
    redisTemplate.opsForValue().set(reasonKey, "user-triggered");

    OcrRegion region =
        OcrRegion.builder()
            .image(image)
            .bboxX(10)
            .bboxY(20)
            .bboxW(100)
            .bboxH(50)
            .text("こんにちは")
            .detectedLanguage("ja")
            .confidence(0.9)
            .regionType("speech")
            .build();
    region = ocrRegionRepository.save(region);

    Map<String, Object> translation = new HashMap<>();
    translation.put("regionId", region.getId().toString());
    translation.put("translatedText", "Hello Redo");
    translation.put("translationFailed", "false");
    translation.put("translationScore", 0.95);
    translation.put("modelIdentifier", "gpt-4o");
    translation.put("confidence", 0.99);

    Map<String, Object> cost = Map.of("total_tokens", 150, "total_cost", 0.001);

    jobCoordinatorService.handleTranslationCallback(image.getId(), List.of(translation), cost);

    List<Layer> layers = layerRepository.findByImageId(image.getId());
    assertEquals(2, layers.size());

    Layer newLayer =
        layers.stream()
            .filter(l -> l.getId() != null && !l.getId().equals(existingLayer.getId()))
            .findFirst()
            .orElseThrow();
    assertTrue(newLayer.getVisible());
    assertEquals("en", newLayer.getTargetLanguage());
    assertNotNull(newLayer.getMetadataJson());
    assertTrue(newLayer.getMetadataJson().has("cost"));

    Layer updatedExisting = layerRepository.findById(existingLayer.getId()).orElseThrow();
    assertFalse(updatedExisting.getVisible());

    List<LayerElement> elements = layerElementRepository.findByLayerId(newLayer.getId());
    layerElementRepository.deleteAll(elements);
    layerRepository.delete(newLayer);
    layerRepository.delete(updatedExisting);
    ocrRegionRepository.delete(region);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleTranslationCallback_InvalidRegionId() {
    Image rawImage =
        Image.builder().filename("test_invalid.png").storagePath("test/test_invalid.png").build();
    final Image image = imageRepository.save(rawImage);

    Map<String, Object> translation = new HashMap<>();
    translation.put("regionId", "not-a-valid-uuid");
    translation.put("translatedText", "Hello");

    assertDoesNotThrow(
        () ->
            jobCoordinatorService.handleTranslationCallback(
                image.getId(), List.of(translation), null));

    List<Layer> layers = layerRepository.findByImageId(image.getId());
    layerRepository.deleteAll(layers);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleLayoutCallback_InvalidRegionId() {
    Image rawImage =
        Image.builder().filename("test_invalid.png").storagePath("test/test_invalid.png").build();
    final Image image = imageRepository.save(rawImage);

    List<Map<String, String>> regionTypes =
        List.of(Map.of("regionId", "not-a-uuid", "regionType", "text"));

    assertDoesNotThrow(
        () -> jobCoordinatorService.handleLayoutCallback(image.getId(), regionTypes, null));

    imageRepository.delete(image);
  }

  @Test
  public void testHandleOcrCallback_WithRedisReason() {
    Image rawImage =
        Image.builder().filename("test_ocr.png").storagePath("test/test_ocr.png").build();
    final Image image = imageRepository.save(rawImage);

    String ocrReasonKey = "image:ocr:reason:" + image.getId();
    redisTemplate.opsForValue().set(ocrReasonKey, "user-request");

    com.manga.library.dto.OcrCallbackDto dto = new com.manga.library.dto.OcrCallbackDto();
    dto.setImageId(image.getId());
    dto.setRegions(Collections.emptyList());
    dto.setModelIdentifier("paddle-ocr");
    dto.setConfidence(0.98);

    jobCoordinatorService.handleOcrCallback(dto);

    List<Layer> layers = layerRepository.findByImageId(image.getId());
    assertFalse(layers.isEmpty());
    Layer ocrLayer = layers.get(0);
    assertEquals("ocr", ocrLayer.getType());
    assertTrue(ocrLayer.getMetadataJson().get("layer_name").asText().contains("user-request"));

    layerRepository.delete(ocrLayer);
    imageRepository.delete(image);
  }
}
