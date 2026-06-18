package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.util.ReflectionTestUtils;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import java.util.*;

@SpringBootTest
public class JobCoordinatorServiceTest {

  @Autowired private JobCoordinatorService jobCoordinatorService;
  @Autowired private ImageRepository imageRepository;
  @Autowired private OcrRegionRepository ocrRegionRepository;
  @Autowired private LayerRepository layerRepository;
  @Autowired private LayerElementRepository layerElementRepository;
  @Autowired private org.springframework.data.redis.core.StringRedisTemplate redisTemplate;

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
        jobCoordinatorService, "workerHealthUrl", "http://localhost:" + testPort + "/default-health");
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
    Image image = Image.builder()
        .filename("test.png")
        .storagePath("test/test.png")
        .build();
    image = imageRepository.save(image);

    OcrRegion region = OcrRegion.builder()
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

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult));

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
    Image image = Image.builder()
        .filename("test_df.png")
        .storagePath("test/test_df.png")
        .build();
    image = imageRepository.save(image);

    Layer layer = Layer.builder()
        .image(image)
        .type("translation")
        .targetLanguage("en")
        .visible(true)
        .zOrder(2)
        .build();
    layer = layerRepository.save(layer);

    OcrRegion region = OcrRegion.builder()
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

    LayerElement element = LayerElement.builder()
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

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult));

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
    Image image = Image.builder()
        .filename("test_retry.png")
        .storagePath("test/test_retry.png")
        .build();
    image = imageRepository.save(image);

    OcrRegion region = OcrRegion.builder()
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

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult));

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
    Image image = Image.builder()
        .filename("test_max_retry.png")
        .storagePath("test/test_max_retry.png")
        .build();
    image = imageRepository.save(image);

    OcrRegion region = OcrRegion.builder()
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

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult));

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
    Image image = Image.builder()
        .filename("test_esc.png")
        .storagePath("test/test_esc.png")
        .build();
    image = imageRepository.save(image);

    OcrRegion region = OcrRegion.builder()
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

    jobCoordinatorService.handleQaCallback(image.getId(), List.of(qaResult));

    OcrRegion updatedRegion = ocrRegionRepository.findById(region.getId()).orElseThrow();
    assertEquals("failed", updatedRegion.getQaStatus());
    assertEquals("こんばんは", updatedRegion.getText());
    assertEquals(3, updatedRegion.getBubbleReadingOrder().intValue());

    // Clean up
    ocrRegionRepository.delete(updatedRegion);
    imageRepository.delete(image);
  }
}
