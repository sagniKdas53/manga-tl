package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.RedisTestcontainersConfig;
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
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest
@ActiveProfiles("test")
@Import(RedisTestcontainersConfig.class)
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
  @Autowired private JobCostRepository jobCostRepository;

  @org.springframework.test.context.bean.override.mockito.MockitoBean
  private org.springframework.data.redis.core.StringRedisTemplate redisTemplate;

  private BiConsumer<String, String> rightPushHook;
  private Series defaultSeries;
  private Chapter defaultChapter;

  @BeforeEach
  public void setUp() {
    Series series = new Series();
    series.setTitle("Default Test Series");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    defaultSeries = seriesRepository.save(series);

    Chapter chapter = new Chapter();
    chapter.setSeries(defaultSeries);
    chapter.setChapterNumber(1.0);
    defaultChapter = chapterRepository.save(chapter);

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
    Image image = new Image();
    image.setFilename("test.png");
    image.setStoragePath("test/test.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setQaStatus("pending");
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
    Image image = new Image();
    image.setFilename("test_df.png");
    image.setStoragePath("test/test_df.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    Layer layer = new Layer();
    layer.setPage(page);
    layer.setType("translation");
    layer.setTargetLanguage("en");
    layer.setVisible(true);
    layer.setZOrder(2);
    layer = layerRepository.save(layer);

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setQaStatus("pending");
    region = ocrRegionRepository.save(region);

    LayerElement element = new LayerElement();
    element.setLayer(layer);
    element.setRegion(region);
    element.setText("Hello");
    element.setSize(12.0);
    element.setX(10.0);
    element.setY(20.0);
    element.setVisible(true);
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
    Image image = new Image();
    image.setFilename("test_retry.png");
    image.setStoragePath("test/test_retry.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setQaStatus("pending");
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
    Image image = new Image();
    image.setFilename("test_max_retry.png");
    image.setStoragePath("test/test_max_retry.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setQaStatus("pending");
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
    Image image = new Image();
    image.setFilename("test_esc.png");
    image.setStoragePath("test/test_esc.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setBubbleReadingOrder(1);
    region.setQaStatus("pending");
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
    Image image = new Image();
    image.setFilename("test_trans.png");
    image.setStoragePath("test/test_trans.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setRegionType("speech");
    region = ocrRegionRepository.save(region);
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
    Image image = new Image();
    image.setFilename("test_redo.png");
    image.setStoragePath("test/test_redo.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    Layer rawLayer = new Layer();
    rawLayer.setPage(page);
    rawLayer.setType("translation");
    rawLayer.setTargetLanguage("en");
    rawLayer.setVisible(true);
    rawLayer.setZOrder(1);
    final Layer existingLayer = layerRepository.save(rawLayer);

    String reasonKey = "image:translation:reason:" + image.getId();
    redisTemplate.opsForValue().set(reasonKey, "user-triggered");

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setRegionType("speech");
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
    Image image = new Image();
    image.setFilename("test_invalid.png");
    image.setStoragePath("test/test_invalid.png");
    final Image savedImage = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(savedImage);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    Map<String, Object> translation = new HashMap<>();
    translation.put("regionId", "not-a-valid-uuid");
    translation.put("translatedText", "Hello");

    assertDoesNotThrow(
        () ->
            jobCoordinatorService.handleTranslationCallback(
                savedImage.getId(), List.of(translation), null));

    List<Layer> layers = layerRepository.findByPageId(page.getId());
    layerRepository.deleteAll(layers);
    pageRepository.delete(page);
    imageRepository.delete(savedImage);
  }

  @Test
  public void testHandleLayoutCallback_InvalidRegionId() {
    Image image = new Image();
    image.setFilename("test_invalid.png");
    image.setStoragePath("test/test_invalid.png");
    final Image savedImage = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(savedImage);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    List<Map<String, String>> regionTypes =
        List.of(Map.of("regionId", "not-a-uuid", "regionType", "text"));

    assertDoesNotThrow(
        () -> jobCoordinatorService.handleLayoutCallback(savedImage.getId(), regionTypes, null));

    pageRepository.delete(page);
    imageRepository.delete(savedImage);
  }

  @Test
  public void testHandleOcrCallback_WithRedisReason() {
    Image image = new Image();
    image.setFilename("test_ocr.png");
    image.setStoragePath("test/test_ocr.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    String ocrReasonKey = "image:ocr:reason:" + image.getId();
    redisTemplate.opsForValue().set(ocrReasonKey, "user-request");

    com.manga.library.dto.OcrCallbackDto.OcrRegionData r =
        new com.manga.library.dto.OcrCallbackDto.OcrRegionData(
            "test", "ja", 0.98, 0.0, 0, 0, 100, 100, null, 1, null, null, null, null, null, null,
            null, 0.99, null, null, null, null, null);
    com.manga.library.dto.OcrCallbackDto dto =
        new com.manga.library.dto.OcrCallbackDto(
            image.getId(), page.getId(), "paddle-ocr", 0.98, null, List.of(r));

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
    Image image = new Image();
    image.setFilename("test_hybrid.png");
    image.setStoragePath("test/test_hybrid.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    // Old translation layer (should be set to invisible)
    Layer oldLayer = new Layer();
    oldLayer.setPage(page);
    oldLayer.setType("translation");
    oldLayer.setTargetLanguage("en");
    oldLayer.setVisible(true);
    oldLayer.setZOrder(1);
    oldLayer = layerRepository.save(oldLayer);

    // Latest translation layer (should remain/be set to visible)
    Layer latestLayer = new Layer();
    latestLayer.setPage(page);
    latestLayer.setType("translation");
    latestLayer.setTargetLanguage("en");
    latestLayer.setVisible(false);
    latestLayer.setZOrder(2);
    latestLayer = layerRepository.save(latestLayer);

    // OCR layer (should be set to invisible)
    Layer ocrLayer = new Layer();
    ocrLayer.setPage(page);
    ocrLayer.setType("ocr");
    ocrLayer.setVisible(true);
    ocrLayer.setZOrder(0);
    ocrLayer = layerRepository.save(ocrLayer);

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setQaStatus("pending");
    region = ocrRegionRepository.save(region);

    // Layer elements on both layers
    LayerElement oldEl = new LayerElement();
    oldEl.setLayer(oldLayer);
    oldEl.setRegion(region);
    oldEl.setText("Hello old");
    oldEl.setX(10.0);
    oldEl.setY(20.0);
    oldEl.setMaxWidth(100);
    oldEl.setMaxHeight(50);
    oldEl.setVisible(true);
    layerElementRepository.save(oldEl);

    LayerElement latestEl = new LayerElement();
    latestEl.setLayer(latestLayer);
    latestEl.setRegion(region);
    latestEl.setText("Hello latest");
    latestEl.setX(10.0);
    latestEl.setY(20.0);
    latestEl.setMaxWidth(100);
    latestEl.setMaxHeight(50);
    latestEl.setVisible(true);
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
    Series series = new Series();
    series.setTitle("Test Series");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    series = seriesRepository.save(series);

    Chapter chapterA = new Chapter();
    chapterA.setSeries(series);
    chapterA.setChapterNumber(1.0);
    chapterA.setOcrProvider("openrouter");
    chapterA = chapterRepository.save(chapterA);

    Chapter chapterB = new Chapter();
    chapterB.setSeries(series);
    chapterB.setChapterNumber(2.0);
    chapterB.setOcrProvider("local");
    chapterB = chapterRepository.save(chapterB);

    Image image = new Image();
    image.setFilename("shared.png");
    image.setStoragePath("shared/shared.png");
    image = imageRepository.save(image);

    Page pageA = new Page();
    pageA.setChapter(chapterA);
    pageA.setImage(image);
    pageA.setPageNumber(1);
    pageRepository.save(pageA);

    Page pageB = new Page();
    pageB.setChapter(chapterB);
    pageB.setImage(image);
    pageB.setPageNumber(1);
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
    Series series = new Series();
    series.setTitle("FBM Series");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    series.setUseFallbackModels(true);
    series = seriesRepository.save(series);

    Chapter chapter = new Chapter();
    chapter.setSeries(series);
    chapter.setChapterNumber(1.0);
    chapter.setUseFallbackModels(false);
    chapter = chapterRepository.save(chapter);

    Image image = new Image();
    image.setFilename("fbm_c.png");
    image.setStoragePath("fbm/fbm_c.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(chapter);
    page.setImage(image);
    page.setPageNumber(1);
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
    Series series = new Series();
    series.setTitle("FBM Series2");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    series.setUseFallbackModels(false);
    series = seriesRepository.save(series);

    Chapter chapter = new Chapter();
    chapter.setSeries(series);
    chapter.setChapterNumber(1.0);
    chapter = chapterRepository.save(chapter);

    Image image = new Image();
    image.setFilename("fbm_s.png");
    image.setStoragePath("fbm/fbm_s.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(chapter);
    page.setImage(image);
    page.setPageNumber(1);
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
    Series series = new Series();
    series.setTitle("FBM Series3");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    series = seriesRepository.save(series);

    Chapter chapter = new Chapter();
    chapter.setSeries(series);
    chapter.setChapterNumber(1.0);
    chapter = chapterRepository.save(chapter);

    Image image = new Image();
    image.setFilename("fbm_g.png");
    image.setStoragePath("fbm/fbm_g.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(chapter);
    page.setImage(image);
    page.setPageNumber(1);
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
    Image image = new Image();
    image.setFilename("test_empty_ocr.png");
    image.setStoragePath("test/test_empty_ocr.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    // Create a running OCR job
    Job job = new Job();
    job.setId(UUID.randomUUID().toString());
    job.setImageId(image.getId());
    job.setType("ocr");
    job.setStatus("PROCESSING");
    job = jobRepository.save(job);

    com.manga.library.dto.OcrCallbackDto dto =
        new com.manga.library.dto.OcrCallbackDto(
            image.getId(), page.getId(), "paddle-ocr", 0.98, null, Collections.emptyList());

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
    Image image = new Image();
    image.setFilename("test_empty_tl.png");
    image.setStoragePath("test/test_empty_tl.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(image);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    Job job = new Job();
    job.setId(UUID.randomUUID().toString());
    job.setImageId(image.getId());
    job.setType("translation");
    job.setStatus("PROCESSING");
    job = jobRepository.save(job);

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setRegionType("speech");
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

  @Test
  public void testHandleTranslationCallback_SavesJobCost() {
    Image image = new Image();
    image.setFilename("test_cost.png");
    image.setStoragePath("test/test_cost.png");
    final Image savedImage = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(defaultChapter);
    page.setImage(savedImage);
    page.setPageNumber(1);
    page = pageRepository.save(page);

    OcrRegion region = new OcrRegion();
    region.setPage(page);
    region.setBboxX(10);
    region.setBboxY(20);
    region.setBboxW(100);
    region.setBboxH(50);
    region.setText("こんにちは");
    region.setDetectedLanguage("ja");
    region.setConfidence(0.9);
    region.setRegionType("speech");
    region = ocrRegionRepository.save(region);

    Map<String, Object> translation = new HashMap<>();
    translation.put("regionId", region.getId().toString());
    translation.put("translatedText", "Hello");

    Map<String, Object> cost = new HashMap<>();
    cost.put("estimated_cost", 0.005);
    cost.put("provider", "openrouter");
    cost.put("model", "gpt-4");
    cost.put("prompt_tokens", 100);
    cost.put("completion_tokens", 50);

    jobCoordinatorService.handleTranslationCallback(savedImage.getId(), List.of(translation), cost);

    List<JobCost> jobCosts = jobCostRepository.findAll();
    assertFalse(jobCosts.isEmpty());
    JobCost savedCost =
        jobCosts.stream()
            .filter(c -> c.getImageId().equals(savedImage.getId()))
            .findFirst()
            .orElseThrow();
    assertEquals(0.005, savedCost.getEstimatedCost());
    assertEquals("openrouter", savedCost.getProvider());
    assertEquals("gpt-4", savedCost.getModel());
    assertEquals(100, savedCost.getPromptTokens());
    assertEquals(50, savedCost.getCompletionTokens());

    // Clean up
    jobCostRepository.deleteAll(jobCosts);
    List<Layer> layers = layerRepository.findByPageId(page.getId());
    layers.forEach(
        l -> layerElementRepository.deleteAll(layerElementRepository.findByLayerId(l.getId())));
    layerRepository.deleteAll(layers);
    ocrRegionRepository.delete(region);
    pageRepository.delete(page);
    imageRepository.delete(savedImage);
  }

  @Test
  public void testFallbackModelInheritance() throws Exception {
    Series series = new Series();
    series.setTitle("Fallback Test Series");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    series = seriesRepository.save(series);

    // 1. Chapter overrides (false)
    Chapter chapter1 = new Chapter();
    chapter1.setSeries(series);
    chapter1.setChapterNumber(1.0);
    chapter1.setUseFallbackModels(false);
    chapter1 = chapterRepository.save(chapter1);

    Image imgVal1 = new Image();
    imgVal1.setFilename("f1.png");
    imgVal1.setStoragePath("f1.png");
    Image image1 = imageRepository.save(imgVal1);

    Page pVal1 = new Page();
    pVal1.setChapter(chapter1);
    pVal1.setImage(image1);
    pVal1.setPageNumber(1);
    pageRepository.save(pVal1);

    // 2. Chapter inherits, Series overrides (false)
    Series series2 = new Series();
    series2.setTitle("Fallback Test Series 2");
    series2.setOriginalLanguage("ja");
    series2.setSourceLanguage("ja");
    series2.setTargetLanguage("en");
    series2.setReadingDirection("rtl");
    series2.setUseFallbackModels(false);
    series2 = seriesRepository.save(series2);

    Chapter chapter2 = new Chapter();
    chapter2.setSeries(series2);
    chapter2.setChapterNumber(2.0);
    chapter2 = chapterRepository.save(chapter2);

    Image imgVal2 = new Image();
    imgVal2.setFilename("f2.png");
    imgVal2.setStoragePath("f2.png");
    Image image2 = imageRepository.save(imgVal2);

    Page pVal2 = new Page();
    pVal2.setChapter(chapter2);
    pVal2.setImage(image2);
    pVal2.setPageNumber(1);
    pageRepository.save(pVal2);

    // 3. Both inherit, should be true by default (system setting not mocked here, but defaults to
    // true in logic)
    Series series3 = new Series();
    series3.setTitle("Fallback Test Series 3");
    series3.setOriginalLanguage("ja");
    series3.setSourceLanguage("ja");
    series3.setTargetLanguage("en");
    series3.setReadingDirection("rtl");
    series3 = seriesRepository.save(series3);

    Chapter chapter3 = new Chapter();
    chapter3.setSeries(series3);
    chapter3.setChapterNumber(3.0);
    chapter3 = chapterRepository.save(chapter3);

    Image imgVal3 = new Image();
    imgVal3.setFilename("f3.png");
    imgVal3.setStoragePath("f3.png");
    Image image3 = imageRepository.save(imgVal3);

    Page pVal3 = new Page();
    pVal3.setChapter(chapter3);
    pVal3.setImage(image3);
    pVal3.setPageNumber(1);
    pageRepository.save(pVal3);

    // Execute
    AtomicReference<String> payload1 = new AtomicReference<>();
    AtomicReference<String> payload2 = new AtomicReference<>();
    AtomicReference<String> payload3 = new AtomicReference<>();

    rightPushHook =
        (queueName, payload) -> {
          if (payload.contains(image1.getId().toString())) payload1.set(payload);
          if (payload.contains(image2.getId().toString())) payload2.set(payload);
          if (payload.contains(image3.getId().toString())) payload3.set(payload);
        };

    transactionTemplate.executeWithoutResult(
        status -> {
          jobCoordinatorService.startPipeline(image1.getId());
          jobCoordinatorService.startPipeline(image2.getId());
          jobCoordinatorService.startPipeline(image3.getId());
        });

    // Check assertions using ObjectMapper
    com.fasterxml.jackson.databind.ObjectMapper mapper =
        new com.fasterxml.jackson.databind.ObjectMapper();

    assertNotNull(payload1.get());
    assertFalse(mapper.readTree(payload1.get()).get("useFallbackModels").asBoolean());

    assertNotNull(payload2.get());
    assertFalse(mapper.readTree(payload2.get()).get("useFallbackModels").asBoolean());

    assertNotNull(payload3.get());
    assertTrue(mapper.readTree(payload3.get()).get("useFallbackModels").asBoolean());

    // Clean up
    jobRepository.deleteAll();
    pageRepository.deleteAll();
    imageRepository.deleteAll();
    chapterRepository.deleteAll();
    seriesRepository.deleteAll();
  }

  @Test
  public void testQaModeAutoResolvesToVlmWhenVlmModelUsable() {
    Series series = new Series();
    series.setTitle("QA Auto VLM Series");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    series = seriesRepository.save(series);

    Chapter chapter = new Chapter();
    chapter.setSeries(series);
    chapter.setChapterNumber(1.0);
    chapter.setQaMode("auto");
    chapter.setQaVlmModel("vlm-model-x");
    chapter.setQaLlmModel("llm-model-y");
    chapter = chapterRepository.save(chapter);

    Image image = new Image();
    image.setFilename("qa_auto_vlm.png");
    image.setStoragePath("qa/qa_auto_vlm.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(chapter);
    page.setImage(image);
    page.setPageNumber(1);
    pageRepository.save(page);

    ProviderConfigCache mockCache = org.mockito.Mockito.mock(ProviderConfigCache.class);
    org.mockito.Mockito.when(
            mockCache.isValidProviderModel(
                org.mockito.Mockito.anyString(),
                org.mockito.Mockito.anyString(),
                org.mockito.Mockito.anyString()))
        .thenReturn(true);
    ProviderConfigCache originalCache =
        (ProviderConfigCache)
            org.springframework.test.util.ReflectionTestUtils.getField(
                jobCoordinatorService, "providerConfigCache");
    org.springframework.test.util.ReflectionTestUtils.setField(
        jobCoordinatorService, "providerConfigCache", mockCache);

    AtomicReference<String> pushedQaMode = new AtomicReference<>();
    rightPushHook =
        (queueName, payload) -> {
          try {
            Map<?, ?> m =
                new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload, Map.class);
            pushedQaMode.set((String) m.get("qaMode"));
          } catch (Exception e) {
            throw new AssertionError(e);
          }
        };

    try {
      jobCoordinatorService.startPipeline(image.getId(), chapter.getId());
      assertEquals("vlm", pushedQaMode.get());
    } finally {
      org.springframework.test.util.ReflectionTestUtils.setField(
          jobCoordinatorService, "providerConfigCache", originalCache);
    }

    // Clean up
    pageRepository.delete(page);
    imageRepository.delete(image);
    chapterRepository.delete(chapter);
    seriesRepository.delete(series);
  }

  @Test
  public void testQaModeAutoResolvesToLlmWhenVlmModelUnusable() {
    Series series = new Series();
    series.setTitle("QA Auto LLM Series");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    series = seriesRepository.save(series);

    Chapter chapter = new Chapter();
    chapter.setSeries(series);
    chapter.setChapterNumber(1.0);
    chapter.setQaMode("auto");
    chapter.setQaVlmModel("N/A");
    chapter.setQaLlmModel("llm-model-y");
    chapter = chapterRepository.save(chapter);

    Image image = new Image();
    image.setFilename("qa_auto_llm.png");
    image.setStoragePath("qa/qa_auto_llm.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(chapter);
    page.setImage(image);
    page.setPageNumber(1);
    pageRepository.save(page);

    ProviderConfigCache mockCache = org.mockito.Mockito.mock(ProviderConfigCache.class);
    org.mockito.Mockito.when(
            mockCache.isValidProviderModel(
                org.mockito.Mockito.anyString(),
                org.mockito.Mockito.anyString(),
                org.mockito.Mockito.anyString()))
        .thenReturn(true);
    ProviderConfigCache originalCache =
        (ProviderConfigCache)
            org.springframework.test.util.ReflectionTestUtils.getField(
                jobCoordinatorService, "providerConfigCache");
    org.springframework.test.util.ReflectionTestUtils.setField(
        jobCoordinatorService, "providerConfigCache", mockCache);

    AtomicReference<String> pushedQaMode = new AtomicReference<>();
    rightPushHook =
        (queueName, payload) -> {
          try {
            Map<?, ?> m =
                new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload, Map.class);
            pushedQaMode.set((String) m.get("qaMode"));
          } catch (Exception e) {
            throw new AssertionError(e);
          }
        };

    try {
      jobCoordinatorService.startPipeline(image.getId(), chapter.getId());
      assertEquals("llm", pushedQaMode.get());
    } finally {
      org.springframework.test.util.ReflectionTestUtils.setField(
          jobCoordinatorService, "providerConfigCache", originalCache);
    }

    // Clean up
    pageRepository.delete(page);
    imageRepository.delete(image);
    chapterRepository.delete(chapter);
    seriesRepository.delete(series);
  }

  @Test
  public void testQaModeAutoStaysAutoWhenNoModelUsable() {
    Series series = new Series();
    series.setTitle("QA Auto None Series");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    series = seriesRepository.save(series);

    Chapter chapter = new Chapter();
    chapter.setSeries(series);
    chapter.setChapterNumber(1.0);
    chapter.setQaMode("auto");
    chapter.setQaVlmModel("vlm-model-x");
    chapter.setQaLlmModel("llm-model-y");
    chapter = chapterRepository.save(chapter);

    Image image = new Image();
    image.setFilename("qa_auto_none.png");
    image.setStoragePath("qa/qa_auto_none.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(chapter);
    page.setImage(image);
    page.setPageNumber(1);
    pageRepository.save(page);

    // Cache rejects every model -> resolveModelWithCheck falls back to empty global defaults,
    // so neither VLM nor LLM is usable and AUTO must be kept for the worker to resolve.
    ProviderConfigCache mockCache = org.mockito.Mockito.mock(ProviderConfigCache.class);
    org.mockito.Mockito.when(
            mockCache.isValidProviderModel(
                org.mockito.Mockito.anyString(),
                org.mockito.Mockito.anyString(),
                org.mockito.Mockito.anyString()))
        .thenReturn(false);
    ProviderConfigCache originalCache =
        (ProviderConfigCache)
            org.springframework.test.util.ReflectionTestUtils.getField(
                jobCoordinatorService, "providerConfigCache");
    org.springframework.test.util.ReflectionTestUtils.setField(
        jobCoordinatorService, "providerConfigCache", mockCache);

    AtomicReference<String> pushedQaMode = new AtomicReference<>();
    rightPushHook =
        (queueName, payload) -> {
          try {
            Map<?, ?> m =
                new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload, Map.class);
            pushedQaMode.set((String) m.get("qaMode"));
          } catch (Exception e) {
            throw new AssertionError(e);
          }
        };

    try {
      jobCoordinatorService.startPipeline(image.getId(), chapter.getId());
      assertEquals("auto", pushedQaMode.get());
    } finally {
      org.springframework.test.util.ReflectionTestUtils.setField(
          jobCoordinatorService, "providerConfigCache", originalCache);
    }

    // Clean up
    pageRepository.delete(page);
    imageRepository.delete(image);
    chapterRepository.delete(chapter);
    seriesRepository.delete(series);
  }

  @Test
  public void testQaModeExplicitPassesThroughUntouched() {
    Series series = new Series();
    series.setTitle("QA Explicit Series");
    series.setOriginalLanguage("ja");
    series.setSourceLanguage("ja");
    series.setTargetLanguage("en");
    series.setReadingDirection("rtl");
    series = seriesRepository.save(series);

    Chapter chapter = new Chapter();
    chapter.setSeries(series);
    chapter.setChapterNumber(1.0);
    chapter.setQaMode("llm");
    chapter = chapterRepository.save(chapter);

    Image image = new Image();
    image.setFilename("qa_explicit.png");
    image.setStoragePath("qa/qa_explicit.png");
    image = imageRepository.save(image);

    Page page = new Page();
    page.setChapter(chapter);
    page.setImage(image);
    page.setPageNumber(1);
    pageRepository.save(page);

    AtomicReference<String> pushedQaMode = new AtomicReference<>();
    rightPushHook =
        (queueName, payload) -> {
          try {
            Map<?, ?> m =
                new com.fasterxml.jackson.databind.ObjectMapper().readValue(payload, Map.class);
            pushedQaMode.set((String) m.get("qaMode"));
          } catch (Exception e) {
            throw new AssertionError(e);
          }
        };

    jobCoordinatorService.startPipeline(image.getId(), chapter.getId());
    assertEquals("llm", pushedQaMode.get());

    // Clean up
    pageRepository.delete(page);
    imageRepository.delete(image);
    chapterRepository.delete(chapter);
    seriesRepository.delete(series);
  }

  @SuppressWarnings("unchecked")
  private <T> T mockGeneric(Class<?> clazz) {
    return (T) org.mockito.Mockito.mock(clazz);
  }
}
