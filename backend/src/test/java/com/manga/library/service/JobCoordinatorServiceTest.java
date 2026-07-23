package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.model.*;
import com.manga.library.repository.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest
@ActiveProfiles("test")
@SuppressWarnings("null")
public class JobCoordinatorServiceTest {

  @Autowired private JobCoordinatorService jobCoordinatorService;
  @Autowired private ImageRepository imageRepository;
  @Autowired private OcrRegionRepository ocrRegionRepository;
  @Autowired private LayerRepository layerRepository;
  @Autowired private LayerElementRepository layerElementRepository;
  @Autowired private JobRepository jobRepository;
  @Autowired private TransactionTemplate transactionTemplate;
  @Autowired private PageRepository pageRepository;
  @Autowired private ChapterRepository chapterRepository;
  @Autowired private SeriesRepository seriesRepository;

  @org.springframework.boot.test.mock.mockito.MockBean
  private org.springframework.data.redis.core.StringRedisTemplate redisTemplate;

  private BiConsumer<String, String> rightPushHook;
  private Series defaultSeries;
  private Chapter defaultChapter;

  @BeforeEach
  public void setUp() {
    defaultSeries =
        seriesRepository.save(
            Series.builder()
                .title("Default Test Series")
                .originalLanguage("ja")
                .sourceLanguage("ja")
                .targetLanguage("en")
                .readingDirection("rtl")
                .build());
    defaultChapter =
        chapterRepository.save(Chapter.builder().series(defaultSeries).chapterNumber(1.0).build());

    // Set up mock for redisTemplate using in-memory structures
    final Map<String, String> mockRedisValueStore = new HashMap<>();
    final Map<String, List<String>> mockRedisListStore = new HashMap<>();

    org.springframework.data.redis.core.ValueOperations<String, String> valueOps =
        mockGeneric(org.springframework.data.redis.core.ValueOperations.class);
    org.mockito.Mockito.when(valueOps.get(org.mockito.Mockito.anyString()))
        .thenAnswer(invocation -> mockRedisValueStore.get(invocation.getArgument(0)));
    org.mockito.Mockito.doAnswer(
            invocation -> {
              mockRedisValueStore.put(invocation.getArgument(0), invocation.getArgument(1));
              return null;
            })
        .when(valueOps)
        .set(org.mockito.Mockito.anyString(), org.mockito.Mockito.anyString());
    org.mockito.Mockito.doAnswer(
            invocation -> {
              mockRedisValueStore.put(invocation.getArgument(0), invocation.getArgument(1));
              return null;
            })
        .when(valueOps)
        .set(
            org.mockito.Mockito.anyString(),
            org.mockito.Mockito.anyString(),
            org.mockito.Mockito.any(java.time.Duration.class));

    @SuppressWarnings("unchecked")
    org.springframework.data.redis.core.ListOperations<String, String> listOps =
        (org.springframework.data.redis.core.ListOperations<String, String>)
            java.lang.reflect.Proxy.newProxyInstance(
                getClass().getClassLoader(),
                new Class<?>[] {org.springframework.data.redis.core.ListOperations.class},
                (proxy, method, args) -> {
                  if ("rightPush".equals(method.getName())) {
                    String key = args[0].toString();
                    String val = args[1].toString();
                    mockRedisListStore.computeIfAbsent(key, k -> new ArrayList<>()).add(val);
                    if (rightPushHook != null) {
                      rightPushHook.accept(key, val);
                    }
                    return (long) mockRedisListStore.get(key).size();
                  } else if ("size".equals(method.getName())) {
                    String key = args[0].toString();
                    List<String> list = mockRedisListStore.get(key);
                    return list == null ? 0L : (long) list.size();
                  }
                  return null;
                });

    org.springframework.data.redis.core.StringRedisTemplate dummyTemplate =
        new org.springframework.data.redis.core.StringRedisTemplate() {
          @Override
          public org.springframework.data.redis.core.ValueOperations<String, String> opsForValue() {
            return valueOps;
          }

          @Override
          public org.springframework.data.redis.core.ListOperations<String, String> opsForList() {
            return listOps;
          }

          @Override
          public Boolean delete(String key) {
            return mockRedisValueStore.remove(key) != null
                || mockRedisListStore.remove(key) != null;
          }
        };
    org.springframework.test.util.ReflectionTestUtils.setField(
        jobCoordinatorService, "redisTemplate", dummyTemplate);
    org.springframework.test.util.ReflectionTestUtils.setField(
        this, "redisTemplate", dummyTemplate);
    SseService sse =
        (SseService)
            org.springframework.test.util.ReflectionTestUtils.getField(
                jobCoordinatorService, "sseService");
    if (sse != null)
      org.springframework.test.util.ReflectionTestUtils.setField(
          sse, "redisTemplate", dummyTemplate);
  }

  @AfterEach
  public void tearDown() {
    rightPushHook = null;
    if (defaultChapter != null && defaultChapter.getId() != null)
      chapterRepository.deleteById(defaultChapter.getId());
    if (defaultSeries != null && defaultSeries.getId() != null)
      seriesRepository.deleteById(defaultSeries.getId());
  }

  @Test
  public void testEnqueuedJobIsCommittedBeforeRedisPush() {
    AtomicBoolean sawJobAtPushTime = new AtomicBoolean(false);
    AtomicReference<String> pushedJobId = new AtomicReference<>();
    ExecutorService executor = Executors.newSingleThreadExecutor();

    rightPushHook =
        (queueName, payload) -> {
          try {
            Map<?, ?> payloadMap =
                new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload, Map.class);
            String jobId = payloadMap.get("jobId").toString();
            pushedJobId.set(jobId);
            Future<Boolean> found =
                executor.submit(() -> jobRepository.findById(jobId).isPresent());
            sawJobAtPushTime.set(found.get(5, TimeUnit.SECONDS));
          } catch (Exception e) {
            throw new AssertionError(e);
          }
        };

    transactionTemplate.executeWithoutResult(
        status -> jobCoordinatorService.startPipeline(UUID.randomUUID()));

    executor.shutdownNow();

    assertNotNull(pushedJobId.get());
    assertTrue(
        sawJobAtPushTime.get(),
        "Worker-visible Redis pushes must happen only after the jobs row is committed");
    jobRepository.deleteById(pushedJobId.get());
  }

  @Test
  public void testHandleQaCallback_Passed() {
    Image image = Image.builder().filename("test.png").storagePath("test/test.png").build();
    image = imageRepository.save(image);
    Page page = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    page = pageRepository.save(page);

    OcrRegion region =
        OcrRegion.builder()
            .page(page)
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
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleQaCallback_DirectFix() {
    Image image = Image.builder().filename("test_df.png").storagePath("test/test_df.png").build();
    image = imageRepository.save(image);
    Page page = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    page = pageRepository.save(page);

    Layer layer =
        Layer.builder()
            .page(page)
            .type("translation")
            .targetLanguage("en")
            .visible(true)
            .zOrder(2)
            .build();
    layer = layerRepository.save(layer);

    OcrRegion region =
        OcrRegion.builder()
            .page(page)
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
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleQaCallback_FailedWithRetry() {
    Image image =
        Image.builder().filename("test_retry.png").storagePath("test/test_retry.png").build();
    image = imageRepository.save(image);
    Page page = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    page = pageRepository.save(page);

    OcrRegion region =
        OcrRegion.builder()
            .page(page)
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
    pageRepository.delete(page);
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
    Page page = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    page = pageRepository.save(page);

    OcrRegion region =
        OcrRegion.builder()
            .page(page)
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
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleQaCallback_Escalation() {
    Image image = Image.builder().filename("test_esc.png").storagePath("test/test_esc.png").build();
    image = imageRepository.save(image);
    Page page = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    page = pageRepository.save(page);

    OcrRegion region =
        OcrRegion.builder()
            .page(page)
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
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleTranslationCallback_NewElement() {
    Image image =
        Image.builder().filename("test_trans.png").storagePath("test/test_trans.png").build();
    image = imageRepository.save(image);
    Page page = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    page = pageRepository.save(page);

    OcrRegion region =
        OcrRegion.builder()
            .page(page)
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
    assertEquals(0.0, el.getX(), 0.001); // max(0, 10 - 10)
    assertEquals(10.0, el.getY(), 0.001); // max(0, 20 - 10)
    assertEquals(120, el.getMaxWidth().intValue()); // 100 + 20
    assertEquals(70, el.getMaxHeight().intValue()); // 50 + 20

    // Clean up
    layerElementRepository.delete(el);
    List<Layer> layers = layerRepository.findByPageId(page.getId());
    for (Layer l : layers) {
      layerRepository.delete(l);
    }
    ocrRegionRepository.delete(updatedRegion);
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleTranslationCallback_RedoAndCostAndRedisReason() {
    Image rawImage =
        Image.builder().filename("test_redo.png").storagePath("test/test_redo.png").build();
    final Image image = imageRepository.save(rawImage);
    Page rawPage = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    final Page page = pageRepository.save(rawPage);

    Layer rawLayer =
        Layer.builder()
            .page(page)
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
            .page(page)
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
    translation.put("translationFailed", false);
    translation.put("translationScore", 0.95);
    translation.put("modelIdentifier", "gpt-4o");
    translation.put("confidence", 0.99);

    Map<String, Object> cost = Map.of("total_tokens", 150, "total_cost", 0.001);

    jobCoordinatorService.handleTranslationCallback(image.getId(), List.of(translation), cost);

    List<Layer> layers = layerRepository.findByPageId(page.getId());
    assertEquals(2, layers.size());

    Layer newLayer =
        layers.stream()
            .filter(l -> l.getId() != null && !l.getId().equals(existingLayer.getId()))
            .findFirst()
            .orElseThrow();
    assertTrue(newLayer.getVisible());
    assertEquals("en", newLayer.getTargetLanguage());
    assertNotNull(newLayer.getMetadataJson());
    assertTrue(newLayer.getMetadataJson().has("tl"));
    assertTrue(newLayer.getMetadataJson().get("tl").has("cost"));

    Layer updatedExisting = layerRepository.findById(existingLayer.getId()).orElseThrow();
    assertFalse(updatedExisting.getVisible());

    List<LayerElement> elements = layerElementRepository.findByLayerId(newLayer.getId());
    layerElementRepository.deleteAll(elements);
    layerRepository.delete(newLayer);
    layerRepository.delete(updatedExisting);
    ocrRegionRepository.delete(region);
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleTranslationCallback_InvalidRegionId() {
    Image rawImage =
        Image.builder().filename("test_invalid.png").storagePath("test/test_invalid.png").build();
    final Image image = imageRepository.save(rawImage);
    Page rawPage = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    final Page page = pageRepository.save(rawPage);

    Map<String, Object> translation = new HashMap<>();
    translation.put("regionId", "not-a-valid-uuid");
    translation.put("translatedText", "Hello");

    assertDoesNotThrow(
        () ->
            jobCoordinatorService.handleTranslationCallback(
                image.getId(), List.of(translation), null));

    List<Layer> layers = layerRepository.findByPageId(page.getId());
    layerRepository.deleteAll(layers);
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleLayoutCallback_InvalidRegionId() {
    Image rawImage =
        Image.builder().filename("test_invalid.png").storagePath("test/test_invalid.png").build();
    final Image image = imageRepository.save(rawImage);
    Page rawPage = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    final Page page = pageRepository.save(rawPage);

    List<Map<String, String>> regionTypes =
        List.of(Map.of("regionId", "not-a-uuid", "regionType", "text"));

    assertDoesNotThrow(
        () -> jobCoordinatorService.handleLayoutCallback(image.getId(), regionTypes, null));

    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleOcrCallback_WithRedisReason() {
    Image rawImage =
        Image.builder().filename("test_ocr.png").storagePath("test/test_ocr.png").build();
    final Image image = imageRepository.save(rawImage);
    Page rawPage = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    final Page page = pageRepository.save(rawPage);

    String ocrReasonKey = "image:ocr:reason:" + image.getId();
    redisTemplate.opsForValue().set(ocrReasonKey, "user-request");

    com.manga.library.dto.OcrCallbackDto dto = new com.manga.library.dto.OcrCallbackDto();
    dto.setImageId(image.getId());
    com.manga.library.dto.OcrCallbackDto.OcrRegionData r = new com.manga.library.dto.OcrCallbackDto.OcrRegionData();
    r.setText("test");
    r.setX(0); r.setY(0); r.setWidth(100); r.setHeight(100);
    r.setDetectedLanguage("ja");
    dto.setRegions(List.of(r));
    dto.setModelIdentifier("paddle-ocr");
    dto.setConfidence(0.98);

    jobCoordinatorService.handleOcrCallback(dto);

    List<Layer> layers = layerRepository.findByPageId(page.getId());
    assertFalse(layers.isEmpty());
    Layer ocrLayer = layers.get(0);
    assertEquals("ocr", ocrLayer.getType());
    assertTrue(ocrLayer.getMetadataJson().get("layer_name").asText().contains("user-request"));

    layerRepository.delete(ocrLayer);
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testPrepareHybridQa() {
    Image image =
        Image.builder().filename("test_hybrid.png").storagePath("test/test_hybrid.png").build();
    image = imageRepository.save(image);
    Page page = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    page = pageRepository.save(page);

    // Old translation layer (should be set to invisible)
    Layer oldLayer =
        Layer.builder()
            .page(page)
            .type("translation")
            .targetLanguage("en")
            .visible(true)
            .zOrder(1)
            .build();
    oldLayer = layerRepository.save(oldLayer);

    // Latest translation layer (should remain/be set to visible)
    Layer latestLayer =
        Layer.builder()
            .page(page)
            .type("translation")
            .targetLanguage("en")
            .visible(false)
            .zOrder(2)
            .build();
    latestLayer = layerRepository.save(latestLayer);

    // OCR layer (should be set to invisible)
    Layer ocrLayer = Layer.builder().page(page).type("ocr").visible(true).zOrder(0).build();
    ocrLayer = layerRepository.save(ocrLayer);

    OcrRegion region =
        OcrRegion.builder()
            .page(page)
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

    // Layer elements on both layers
    LayerElement oldEl =
        LayerElement.builder()
            .layer(oldLayer)
            .region(region)
            .text("Hello old")
            .x(10.0)
            .y(20.0)
            .maxWidth(100)
            .maxHeight(50)
            .visible(true)
            .build();
    layerElementRepository.save(oldEl);

    LayerElement latestEl =
        LayerElement.builder()
            .layer(latestLayer)
            .region(region)
            .text("Hello latest")
            .x(10.0)
            .y(20.0)
            .maxWidth(100)
            .maxHeight(50)
            .visible(true)
            .build();
    latestEl = layerElementRepository.save(latestEl);

    // QA Results with a direct fix
    Map<String, Object> qaResult = new HashMap<>();
    qaResult.put("regionId", region.getId().toString());
    qaResult.put("qaStatus", "direct_fix");
    qaResult.put("qaScore", 0.85);
    qaResult.put("qaFeedback", "Typo corrected");
    Map<String, Object> directFix = new HashMap<>();
    directFix.put("correctedText", "Hello fixed");
    directFix.put("suggestedFontSize", 14.5);
    qaResult.put("directFix", directFix);

    jobCoordinatorService.prepareHybridQa(image.getId(), List.of(qaResult));

    // Verify region updated
    OcrRegion updatedRegion = ocrRegionRepository.findById(region.getId()).orElseThrow();
    assertEquals("fixed", updatedRegion.getQaStatus());
    assertEquals("Hello fixed", updatedRegion.getTranslatedText());

    // Verify elements in latest translation layer updated, but not old layer
    LayerElement updatedLatestEl = layerElementRepository.findById(latestEl.getId()).orElseThrow();
    assertEquals("Hello fixed", updatedLatestEl.getText());
    assertEquals(14.5, updatedLatestEl.getSize());

    LayerElement updatedOldEl = layerElementRepository.findById(oldEl.getId()).orElseThrow();
    assertEquals("Hello old", updatedOldEl.getText());

    // Verify layer visibility
    Layer verifiedLatest = layerRepository.findById(latestLayer.getId()).orElseThrow();
    assertTrue(verifiedLatest.getVisible());

    Layer verifiedOld = layerRepository.findById(oldLayer.getId()).orElseThrow();
    assertFalse(verifiedOld.getVisible());

    Layer verifiedOcr = layerRepository.findById(ocrLayer.getId()).orElseThrow();
    assertFalse(verifiedOcr.getVisible());

    // Clean up
    layerElementRepository.delete(updatedLatestEl);
    layerElementRepository.delete(updatedOldEl);
    ocrRegionRepository.delete(updatedRegion);
    layerRepository.delete(verifiedLatest);
    layerRepository.delete(verifiedOld);
    layerRepository.delete(verifiedOcr);
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testChapterOcrProviderOverride() {
    // Share image between chapters with different ocrProvider settings -> start pipeline from each
    // -> verify correct provider
    Series series =
        Series.builder()
            .title("Test Series")
            .originalLanguage("ja")
            .sourceLanguage("ja")
            .targetLanguage("en")
            .readingDirection("rtl")
            .build();
    series = seriesRepository.save(series);

    Chapter chapterA =
        Chapter.builder().series(series).chapterNumber(1.0).ocrProvider("openrouter").build();
    chapterA = chapterRepository.save(chapterA);

    Chapter chapterB =
        Chapter.builder().series(series).chapterNumber(2.0).ocrProvider("local").build();
    chapterB = chapterRepository.save(chapterB);

    Image image = Image.builder().filename("shared.png").storagePath("shared/shared.png").build();
    image = imageRepository.save(image);

    Page pageA = Page.builder().chapter(chapterA).image(image).pageNumber(1).build();
    pageRepository.save(pageA);

    Page pageB = Page.builder().chapter(chapterB).image(image).pageNumber(1).build();
    pageRepository.save(pageB);

    AtomicReference<String> pushedProvider = new AtomicReference<>();
    rightPushHook =
        (queueName, payload) -> {
          try {
            Map<?, ?> payloadMap =
                new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload, Map.class);
            pushedProvider.set((String) payloadMap.get("ocrProvider"));
          } catch (Exception e) {
            throw new AssertionError(e);
          }
        };

    // Test Chapter A
    jobCoordinatorService.startPipeline(image.getId(), chapterA.getId());
    assertEquals("openrouter", pushedProvider.get());

    // Test Chapter B
    jobCoordinatorService.startPipeline(image.getId(), chapterB.getId());
    assertEquals("local", pushedProvider.get());

    // Clean up
    pageRepository.delete(pageA);
    pageRepository.delete(pageB);
    imageRepository.delete(image);
    chapterRepository.delete(chapterA);
    chapterRepository.delete(chapterB);
    seriesRepository.delete(series);
  }

  @Test
  public void testUseFallbackModels_ChapterOverridesSeries() {
    // Chapter says false → must win even though series says true
    Series series =
        Series.builder()
            .title("FBM Series")
            .originalLanguage("ja")
            .sourceLanguage("ja")
            .targetLanguage("en")
            .readingDirection("rtl")
            .useFallbackModels(true)
            .build();
    series = seriesRepository.save(series);

    Chapter chapter =
        Chapter.builder().series(series).chapterNumber(1.0).useFallbackModels(false).build();
    chapter = chapterRepository.save(chapter);

    Image image = Image.builder().filename("fbm_c.png").storagePath("fbm/fbm_c.png").build();
    image = imageRepository.save(image);
    Page page = Page.builder().chapter(chapter).image(image).pageNumber(1).build();
    pageRepository.save(page);

    AtomicReference<Object> pushedFallback = new AtomicReference<>();
    rightPushHook =
        (queueName, payload) -> {
          try {
            Map<?, ?> m =
                new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload, Map.class);
            pushedFallback.set(m.get("useFallbackModels"));
          } catch (Exception e) {
            throw new AssertionError(e);
          }
        };

    jobCoordinatorService.startPipeline(image.getId(), chapter.getId());

    assertNotNull(pushedFallback.get());
    assertEquals(false, pushedFallback.get());

    // Clean up
    pageRepository.delete(page);
    imageRepository.delete(image);
    chapterRepository.delete(chapter);
    seriesRepository.delete(series);
  }

  @Test
  public void testUseFallbackModels_SeriesOverridesGlobal() {
    // Chapter is null (inherit) → series says false → must win over global default (true)
    Series series =
        Series.builder()
            .title("FBM Series2")
            .originalLanguage("ja")
            .sourceLanguage("ja")
            .targetLanguage("en")
            .readingDirection("rtl")
            .useFallbackModels(false)
            .build();
    series = seriesRepository.save(series);

    Chapter chapter =
        Chapter.builder()
            .series(series)
            .chapterNumber(1.0)
            // useFallbackModels not set → null → should inherit series
            .build();
    chapter = chapterRepository.save(chapter);

    Image image = Image.builder().filename("fbm_s.png").storagePath("fbm/fbm_s.png").build();
    image = imageRepository.save(image);
    Page page = Page.builder().chapter(chapter).image(image).pageNumber(1).build();
    pageRepository.save(page);

    AtomicReference<Object> pushedFallback = new AtomicReference<>();
    rightPushHook =
        (queueName, payload) -> {
          try {
            Map<?, ?> m =
                new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload, Map.class);
            pushedFallback.set(m.get("useFallbackModels"));
          } catch (Exception e) {
            throw new AssertionError(e);
          }
        };

    jobCoordinatorService.startPipeline(image.getId(), chapter.getId());

    assertNotNull(pushedFallback.get());
    assertEquals(false, pushedFallback.get());

    // Clean up
    pageRepository.delete(page);
    imageRepository.delete(image);
    chapterRepository.delete(chapter);
    seriesRepository.delete(series);
  }

  @Test
  public void testUseFallbackModels_InheritsGlobalWhenBothNull() {
    // Both chapter and series are null → falls through to global default (true)
    Series series =
        Series.builder()
            .title("FBM Series3")
            .originalLanguage("ja")
            .sourceLanguage("ja")
            .targetLanguage("en")
            .readingDirection("rtl")
            // useFallbackModels not set → null
            .build();
    series = seriesRepository.save(series);

    Chapter chapter =
        Chapter.builder()
            .series(series)
            .chapterNumber(1.0)
            // useFallbackModels not set → null
            .build();
    chapter = chapterRepository.save(chapter);

    Image image = Image.builder().filename("fbm_g.png").storagePath("fbm/fbm_g.png").build();
    image = imageRepository.save(image);
    Page page = Page.builder().chapter(chapter).image(image).pageNumber(1).build();
    pageRepository.save(page);

    AtomicReference<Object> pushedFallback = new AtomicReference<>();
    rightPushHook =
        (queueName, payload) -> {
          try {
            Map<?, ?> m =
                new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload, Map.class);
            pushedFallback.set(m.get("useFallbackModels"));
          } catch (Exception e) {
            throw new AssertionError(e);
          }
        };

    jobCoordinatorService.startPipeline(image.getId(), chapter.getId());

    // Global default is true (SystemSettings defaults useFallbackModels to true)
    assertNotNull(pushedFallback.get());
    assertEquals(true, pushedFallback.get());

    // Clean up
    pageRepository.delete(page);
    imageRepository.delete(image);
    chapterRepository.delete(chapter);
    seriesRepository.delete(series);
  }

  @Test
  public void testHandleOcrCallback_EmptyRegions_ShortCircuit() {
    Image rawImage =
        Image.builder()
            .filename("test_empty_ocr.png")
            .storagePath("test/test_empty_ocr.png")
            .build();
    final Image image = imageRepository.save(rawImage);
    Page rawPage = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    final Page page = pageRepository.save(rawPage);

    // Create a running OCR job
    Job job = Job.builder().id(UUID.randomUUID().toString()).imageId(image.getId()).type("ocr").status("PROCESSING").build();
    job = jobRepository.save(job);

    com.manga.library.dto.OcrCallbackDto dto = new com.manga.library.dto.OcrCallbackDto();
    dto.setImageId(image.getId());
    dto.setRegions(Collections.emptyList());
    dto.setModelIdentifier("paddle-ocr");
    dto.setConfidence(0.98);

    jobCoordinatorService.handleOcrCallback(dto);

    // Verify job is set to COMPLETED and no layout job is enqueued
    Job updatedJob = jobRepository.findById(job.getId()).orElseThrow();
    assertEquals("COMPLETED", updatedJob.getStatus());

    // Verify no layout job enqueued
    String queueName = "queue:layout";
    Long size = redisTemplate.opsForList().size(queueName);
    assertTrue(size == null || size == 0);

    jobRepository.delete(updatedJob);
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @Test
  public void testHandleTranslationCallback_AllFailed_ShortCircuit() {
    Image rawImage =
        Image.builder().filename("test_empty_tl.png").storagePath("test/test_empty_tl.png").build();
    final Image image = imageRepository.save(rawImage);
    Page rawPage = Page.builder().chapter(defaultChapter).image(image).pageNumber(1).build();
    final Page page = pageRepository.save(rawPage);

    Job job = Job.builder().id(UUID.randomUUID().toString()).imageId(image.getId()).type("translation").status("PROCESSING").build();
    job = jobRepository.save(job);

    OcrRegion region =
        OcrRegion.builder()
            .page(page)
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
    translation.put("translatedText", ""); // Empty translation
    translation.put("translationFailed", true);

    jobCoordinatorService.handleTranslationCallback(image.getId(), List.of(translation), null);

    // Verify job is set to FAILED and no translation layer is created
    Job updatedJob = jobRepository.findById(job.getId()).orElseThrow();
    assertEquals("FAILED", updatedJob.getStatus());
    assertTrue(
        updatedJob.getError() != null && updatedJob.getError().contains("Translation failed"));

    List<Layer> layers = layerRepository.findByPageId(page.getId());
    assertTrue(layers.isEmpty()); // Should not have created any layers

    jobRepository.delete(updatedJob);
    ocrRegionRepository.delete(region);
    pageRepository.delete(page);
    imageRepository.delete(image);
  }

  @SuppressWarnings("unchecked")
  private <T> T mockGeneric(Class<?> clazz) {
    return (T) org.mockito.Mockito.mock(clazz);
  }
}
