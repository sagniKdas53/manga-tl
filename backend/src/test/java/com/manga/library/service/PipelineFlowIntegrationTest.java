package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.config.JwtUtils;
import com.manga.library.dto.ChapterDto;
import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.dto.SeriesDto;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import java.util.*;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@SuppressWarnings("null")
public class PipelineFlowIntegrationTest {

  @Autowired private MockMvc mockMvc;
  @Autowired private ObjectMapper objectMapper;
  @Autowired private JwtUtils jwtUtils;

  @Autowired private UserRepository userRepository;
  @Autowired private SeriesRepository seriesRepository;
  @Autowired private ChapterRepository chapterRepository;
  @Autowired private PageRepository pageRepository;
  @Autowired private ImageRepository imageRepository;
  @Autowired private PanelRepository panelRepository;
  @Autowired private OcrRegionRepository ocrRegionRepository;
  @Autowired private LayerRepository layerRepository;
  @Autowired private LayerElementRepository layerElementRepository;

  @org.springframework.boot.test.mock.mockito.MockBean
  private org.springframework.data.redis.core.StringRedisTemplate redisTemplate;

  @org.springframework.boot.test.mock.mockito.MockBean private MinioService minioService;

  private String adminToken;

  private final Map<String, String> mockRedisValueStore = new HashMap<>();
  private final Map<String, List<String>> mockRedisListStore = new HashMap<>();

  private final List<UUID> createdSeriesIds = new ArrayList<>();
  private final List<UUID> createdChapterIds = new ArrayList<>();
  private final List<UUID> createdPageIds = new ArrayList<>();
  private final List<UUID> createdImageIds = new ArrayList<>();

  @BeforeEach
  public void setUp() throws Exception {
    createdSeriesIds.clear();
    createdChapterIds.clear();
    createdPageIds.clear();
    createdImageIds.clear();

    // Mock MinioService calls
    org.mockito.Mockito.when(
            minioService.uploadFile(
                org.mockito.Mockito.anyString(),
                org.mockito.Mockito.any(byte[].class),
                org.mockito.Mockito.anyString()))
        .thenReturn("mocked-path");
    org.mockito.Mockito.when(
            minioService.uploadFile(
                org.mockito.Mockito.anyString(),
                org.mockito.Mockito.any(org.springframework.web.multipart.MultipartFile.class)))
        .thenReturn("mocked-path");
    org.mockito.Mockito.when(minioService.generatePresignedUrl(org.mockito.Mockito.anyString()))
        .thenReturn("http://mock-minio/presigned-url");

    // Setup mock redisTemplate operations
    mockRedisValueStore.clear();
    mockRedisListStore.clear();

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

    org.springframework.data.redis.core.ListOperations<String, String> listOps =
        mockGeneric(org.springframework.data.redis.core.ListOperations.class);
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

    // Create user and token
    User adminUser =
        userRepository
            .findByEmail("admin@manga.local")
            .orElseGet(
                () -> {
                  User buildUser =
                      User.builder()
                          .email("admin@manga.local")
                          .passwordHash("mock_password_hash")
                          .displayName("Admin User")
                          .role("admin")
                          .build();
                  return userRepository.save(buildUser);
                });
    adminToken = "Bearer " + jwtUtils.generateToken(adminUser.getEmail());
  }

  @AfterEach
  public void tearDown() {

    // Clean up DB records created by the test
    for (UUID imgId : createdImageIds) {
      try {
        List<LayerElement> elements = layerElementRepository.findByLayerImageId(imgId);
        layerElementRepository.deleteAll(elements);
      } catch (Exception e) {
      }
      try {
        List<Layer> layers = layerRepository.findByImageId(imgId);
        layerRepository.deleteAll(layers);
      } catch (Exception e) {
      }
      try {
        List<OcrRegion> ocrRegions = ocrRegionRepository.findByImageId(imgId);
        ocrRegionRepository.deleteAll(ocrRegions);
      } catch (Exception e) {
      }
      try {
        List<Panel> panels = panelRepository.findByImageId(imgId);
        panelRepository.deleteAll(panels);
      } catch (Exception e) {
      }
    }
    for (UUID pgId : createdPageIds) {
      try {
        pageRepository.deleteById(pgId);
      } catch (Exception e) {
      }
    }
    for (UUID imgId : createdImageIds) {
      try {
        imageRepository.deleteById(imgId);
      } catch (Exception e) {
      }
    }
    for (UUID chId : createdChapterIds) {
      try {
        chapterRepository.deleteById(chId);
      } catch (Exception e) {
      }
    }
    for (UUID sId : createdSeriesIds) {
      try {
        seriesRepository.deleteById(sId);
      } catch (Exception e) {
      }
    }

    // Test the clear queue endpoint and clean up any stale jobs created by the test
    try {
      if (adminToken != null) {
        mockMvc
            .perform(
                org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete(
                        "/api/jobs/clear")
                    .header("Authorization", adminToken))
            .andExpect(
                org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk());
      }
    } catch (Exception e) {
      // Ignore cleanup errors
    }
  }

  @Test
  public void testPipelineFlowAndLayers() throws Exception {
    // 1. Create Series
    SeriesDto seriesDto = new SeriesDto();
    seriesDto.setTitle("Flow Test Series");
    seriesDto.setOriginalLanguage("ja");
    seriesDto.setSourceLanguage("ja");
    seriesDto.setTargetLanguage("en");
    seriesDto.setReadingDirection("rtl");

    MvcResult seriesResult =
        mockMvc
            .perform(
                post("/api/series")
                    .header("Authorization", adminToken)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(seriesDto)))
            .andExpect(status().isOk())
            .andReturn();

    SeriesDto savedSeries =
        objectMapper.readValue(seriesResult.getResponse().getContentAsString(), SeriesDto.class);
    assertNotNull(savedSeries.getId());
    createdSeriesIds.add(savedSeries.getId());

    // 2. Create Chapter 1
    ChapterDto ch1Dto = new ChapterDto();
    ch1Dto.setChapterNumber(1.0);
    ch1Dto.setTitle("Chapter One");

    MvcResult ch1Result =
        mockMvc
            .perform(
                post("/api/series/" + savedSeries.getId() + "/chapters")
                    .header("Authorization", adminToken)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(ch1Dto)))
            .andExpect(status().isOk())
            .andReturn();

    ChapterDto savedCh1 =
        objectMapper.readValue(ch1Result.getResponse().getContentAsString(), ChapterDto.class);
    assertNotNull(savedCh1.getId());
    createdChapterIds.add(savedCh1.getId());

    // 3. Create Chapter 2 (for reordering check)
    ChapterDto ch2Dto = new ChapterDto();
    ch2Dto.setChapterNumber(2.0);
    ch2Dto.setTitle("Chapter Two");

    MvcResult ch2Result =
        mockMvc
            .perform(
                post("/api/series/" + savedSeries.getId() + "/chapters")
                    .header("Authorization", adminToken)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(ch2Dto)))
            .andExpect(status().isOk())
            .andReturn();

    ChapterDto savedCh2 =
        objectMapper.readValue(ch2Result.getResponse().getContentAsString(), ChapterDto.class);
    createdChapterIds.add(savedCh2.getId());

    // Reorder chapters (make Chapter Two -> Chapter 1.5)
    savedCh2.setChapterNumber(1.5);
    mockMvc
        .perform(
            put("/api/series/chapters/" + savedCh2.getId())
                .header("Authorization", adminToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(savedCh2)))
        .andExpect(status().isOk());

    Chapter chapterInDb = chapterRepository.findById(savedCh2.getId()).orElseThrow();
    assertEquals(1.5, chapterInDb.getChapterNumber());

    // Helper to generate valid PNG bytes with unique suffix
    java.util.function.Supplier<byte[]> generateMockPng =
        () -> {
          byte[] header =
              new byte[] {
                (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0
              };
          byte[] suffix = UUID.randomUUID().toString().getBytes();
          byte[] combined = new byte[header.length + suffix.length];
          System.arraycopy(header, 0, combined, 0, header.length);
          System.arraycopy(suffix, 0, combined, header.length, suffix.length);
          return combined;
        };

    // 4. Upload Page (Image)
    MockMultipartFile mockFile =
        new MockMultipartFile("file", "page01.png", "image/png", generateMockPng.get());

    MvcResult pageResult =
        mockMvc
            .perform(
                multipart("/api/images")
                    .file(mockFile)
                    .param("chapterId", savedCh1.getId().toString())
                    .param("pageNumber", "1")
                    .header("Authorization", adminToken))
            .andExpect(status().isOk())
            .andReturn();

    // Verify startPipeline enqueued a panel-detection job
    assertTrue(mockRedisListStore.containsKey("queue:panel-detection"));
    assertEquals(1, mockRedisListStore.get("queue:panel-detection").size());

    // Extract image ID from response
    Map<?, ?> uploadResponse =
        objectMapper.readValue(pageResult.getResponse().getContentAsString(), Map.class);
    UUID imageId = UUID.fromString(uploadResponse.get("imageId").toString());
    UUID pageId = UUID.fromString(uploadResponse.get("pageId").toString());
    createdImageIds.add(imageId);
    createdPageIds.add(pageId);

    // 5. Test page reordering (Upload second page first to have >1 pages)
    MockMultipartFile mockFile2 =
        new MockMultipartFile("file", "page02.png", "image/png", generateMockPng.get());
    MvcResult pageResult2 =
        mockMvc
            .perform(
                multipart("/api/images")
                    .file(mockFile2)
                    .param("chapterId", savedCh1.getId().toString())
                    .param("pageNumber", "2")
                    .header("Authorization", adminToken))
            .andExpect(status().isOk())
            .andReturn();
    Map<?, ?> uploadResponse2 =
        objectMapper.readValue(pageResult2.getResponse().getContentAsString(), Map.class);
    UUID pageId2 = UUID.fromString(uploadResponse2.get("pageId").toString());
    UUID imageId2 = UUID.fromString(uploadResponse2.get("imageId").toString());
    createdPageIds.add(pageId2);
    createdImageIds.add(imageId2);

    // Reorder pages: [pageId2, pageId]
    mockMvc
        .perform(
            put("/api/chapters/" + savedCh1.getId() + "/pages/reorder")
                .header("Authorization", adminToken)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    objectMapper.writeValueAsString(
                        List.of(pageId2.toString(), pageId.toString()))))
        .andExpect(status().isOk());

    Page dbPage1 = pageRepository.findById(pageId).orElseThrow();
    Page dbPage2 = pageRepository.findById(pageId2).orElseThrow();
    assertEquals(2, dbPage1.getPageNumber());
    assertEquals(1, dbPage2.getPageNumber());

    // 6. Sequential OCR Callback Pipeline Mocking
    // Step A: Panel Detection Callback -> triggers OCR
    PanelCallbackDto panelCallback = new PanelCallbackDto();
    panelCallback.setImageId(imageId);
    PanelCallbackDto.PanelData panelData = new PanelCallbackDto.PanelData();
    panelData.setX(10);
    panelData.setY(20);
    panelData.setWidth(500);
    panelData.setHeight(400);
    panelData.setGridRow(0);
    panelData.setGridCol(0);
    panelData.setReadingOrder(1);
    panelCallback.setPanels(List.of(panelData));

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/panel")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(panelCallback)))
        .andExpect(status().isOk());

    assertTrue(mockRedisListStore.containsKey("queue:ocr"));
    assertEquals(1, mockRedisListStore.get("queue:ocr").size());

    // Step B: OCR Callback -> triggers Layout
    OcrCallbackDto ocrCallback = new OcrCallbackDto();
    ocrCallback.setImageId(imageId);
    ocrCallback.setModelIdentifier("Tesseract/Mock");
    ocrCallback.setConfidence(0.95);
    OcrCallbackDto.OcrRegionData ocrRegion = new OcrCallbackDto.OcrRegionData();
    ocrRegion.setText("こんにちは");
    ocrRegion.setDetectedLanguage("ja");
    ocrRegion.setConfidence(0.9);
    ocrRegion.setRotation(0.0);
    ocrRegion.setX(15);
    ocrRegion.setY(25);
    ocrRegion.setWidth(100);
    ocrRegion.setHeight(40);
    ocrRegion.setBubbleReadingOrder(1);
    ocrRegion.setBackgroundColor("#ffffff");
    ocrRegion.setBubbleX(12);
    ocrRegion.setBubbleY(22);
    ocrRegion.setBubbleWidth(110);
    ocrRegion.setBubbleHeight(50);
    ocrRegion.setBubbleId("bubble_1");
    ocrRegion.setDetectionConfidence(0.99);
    ocrCallback.setRegions(List.of(ocrRegion));

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/ocr")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(ocrCallback)))
        .andExpect(status().isOk());

    assertTrue(mockRedisListStore.containsKey("queue:layout"));
    assertEquals(1, mockRedisListStore.get("queue:layout").size());

    // Step C: Layout Callback -> triggers Translation
    List<OcrRegion> savedOcrRegions = ocrRegionRepository.findByImageId(imageId);
    assertEquals(1, savedOcrRegions.size());
    UUID regionId = savedOcrRegions.get(0).getId();

    Map<String, Object> layoutCallback = new HashMap<>();
    layoutCallback.put("imageId", imageId.toString());
    layoutCallback.put(
        "regionTypes", List.of(Map.of("regionId", regionId.toString(), "regionType", "speech")));
    layoutCallback.put(
        "conversations",
        List.of(Map.of("sceneType", "dialogue", "regionIds", List.of(regionId.toString()))));

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/layout")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(layoutCallback)))
        .andExpect(status().isOk());

    assertTrue(mockRedisListStore.containsKey("queue:translation"));
    assertEquals(1, mockRedisListStore.get("queue:translation").size());

    // Step D: Translation Callback -> triggers Render
    Map<String, Object> translationCallback = new HashMap<>();
    translationCallback.put("imageId", imageId.toString());
    Map<String, Object> transDetail = new HashMap<>();
    transDetail.put("regionId", regionId.toString());
    transDetail.put("translatedText", "Hello");
    transDetail.put("translationFailed", false);
    transDetail.put("translationScore", 0.95);
    transDetail.put("modelIdentifier", "GPT/Mock");
    transDetail.put("confidence", 0.96);
    translationCallback.put("translations", List.of(transDetail));

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/translation")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(translationCallback)))
        .andExpect(status().isOk());

    assertTrue(mockRedisListStore.containsKey("queue:render"));
    assertEquals(1, mockRedisListStore.get("queue:render").size());

    // Step E: Render Callback -> triggers QA
    mockMvc
        .perform(
            post("/api/internal/jobs/callback/render")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("imageId", imageId.toString()))))
        .andExpect(status().isOk());

    assertTrue(mockRedisListStore.containsKey("queue:qa"));
    assertEquals(1, mockRedisListStore.get("queue:qa").size());

    // Step F: QA Callback -> Pipeline completion
    Map<String, Object> qaCallback = new HashMap<>();
    qaCallback.put("imageId", imageId.toString());
    Map<String, Object> qaResult = new HashMap<>();
    qaResult.put("regionId", regionId.toString());
    qaResult.put("qaStatus", "passed");
    qaResult.put("qaScore", 0.98);
    qaResult.put("qaFeedback", "Looks great!");
    qaCallback.put("qaResults", List.of(qaResult));

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/qa")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(qaCallback)))
        .andExpect(status().isOk());

    // 7. Redo Pipeline & Multi-layer OCR Layering
    // Trigger image redo for OCR
    mockMvc
        .perform(
            post("/api/images/" + imageId + "/redo")
                .param("type", "ocr")
                .header("Authorization", adminToken))
        .andExpect(status().isOk());

    // A second OCR callback triggers for the redo
    OcrCallbackDto ocrCallback2 = new OcrCallbackDto();
    ocrCallback2.setImageId(imageId);
    ocrCallback2.setModelIdentifier("Tesseract/Mock-v2");
    ocrCallback2.setConfidence(0.99);
    OcrCallbackDto.OcrRegionData ocrRegion2 = new OcrCallbackDto.OcrRegionData();
    ocrRegion2.setText("こんにちは、世界");
    ocrRegion2.setDetectedLanguage("ja");
    ocrRegion2.setConfidence(0.98);
    ocrRegion2.setRotation(0.0);
    ocrRegion2.setX(15);
    ocrRegion2.setY(25);
    ocrRegion2.setWidth(100);
    ocrRegion2.setHeight(40);
    ocrRegion2.setBubbleReadingOrder(1);
    ocrRegion2.setBackgroundColor("#ffffff");
    ocrRegion2.setBubbleX(12);
    ocrRegion2.setBubbleY(22);
    ocrRegion2.setBubbleWidth(110);
    ocrRegion2.setBubbleHeight(50);
    ocrRegion2.setBubbleId("bubble_1");
    ocrRegion2.setDetectionConfidence(0.99);
    ocrCallback2.setRegions(List.of(ocrRegion2));

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/ocr")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(ocrCallback2)))
        .andExpect(status().isOk());

    // Verify layered structure
    List<Layer> layers = layerRepository.findByImageId(imageId);
    // There should be two OCR layers
    long ocrLayerCount = layers.stream().filter(l -> "ocr".equalsIgnoreCase(l.getType())).count();
    assertEquals(2, ocrLayerCount);

    // Verify only the latest OCR layer is visible
    Layer latestOcrLayer =
        layers.stream()
            .filter(l -> "ocr".equalsIgnoreCase(l.getType()) && l.getVisible())
            .findFirst()
            .orElse(null);
    assertNotNull(latestOcrLayer);

    Layer oldOcrLayer =
        layers.stream()
            .filter(l -> "ocr".equalsIgnoreCase(l.getType()) && !l.getVisible())
            .findFirst()
            .orElse(null);
    assertNotNull(oldOcrLayer);
    assertTrue(latestOcrLayer.getZOrder() > oldOcrLayer.getZOrder());

    // Check GET /api/internal/images/{imageId} returns only latest visible layer regions
    MvcResult finalInfoResult =
        mockMvc
            .perform(get("/api/internal/images/" + imageId).header("Authorization", adminToken))
            .andExpect(status().isOk())
            .andReturn();

    Map<?, ?> finalInfo =
        objectMapper.readValue(
            finalInfoResult
                .getResponse()
                .getContentAsString(java.nio.charset.StandardCharsets.UTF_8),
            Map.class);
    List<?> finalOcrRegions = (List<?>) finalInfo.get("ocrRegions");
    assertEquals(1, finalOcrRegions.size());
    Map<?, ?> activeRegion = (Map<?, ?>) finalOcrRegions.get(0);
    assertEquals("こんにちは、世界", activeRegion.get("text"));
  }

  @Test
  public void testClonedOcrLayerRegionPreservationAndVisibility() throws Exception {
    // 1. Create a mock Image
    Image image =
        Image.builder()
            .filename("test-clone.png")
            .storagePath("originals/test-clone.png")
            .hash("test-clone-hash")
            .build();
    image = imageRepository.save(image);
    createdImageIds.add(image.getId());

    // 2. Create OCR Region
    OcrRegion ocrRegion =
        OcrRegion.builder()
            .image(image)
            .text("Original Text")
            .detectedLanguage("ja")
            .bboxX(10)
            .bboxY(10)
            .bboxW(100)
            .bboxH(50)
            .build();
    ocrRegion = ocrRegionRepository.save(ocrRegion);

    // 3. Create Layer (OCR)
    Layer ocrLayer = Layer.builder().image(image).type("ocr").visible(true).zOrder(0).build();
    ocrLayer = layerRepository.save(ocrLayer);

    // 4. Create Layer Element with Region
    LayerElement element =
        LayerElement.builder()
            .layer(ocrLayer)
            .region(ocrRegion)
            .text("Original Text")
            .x(10.0)
            .y(10.0)
            .build();
    element = layerElementRepository.save(element);

    // 5. Test frontend cloning behaviour via API /api/images/{imageId}/layers and
    // /api/layers/{layerId}/elements
    // We clone the layer. Since the frontend would call the create layer endpoint and then POST
    // each element, we simulate this.
    // Create new layer (the clone)
    Layer clonedLayer = Layer.builder().image(image).type("ocr").visible(true).zOrder(1).build();
    clonedLayer = layerRepository.save(clonedLayer);

    // Create cloned layer element, passing regionId in the DTO
    com.manga.library.dto.LayerElementDto dto = new com.manga.library.dto.LayerElementDto();
    dto.setText(element.getText());
    dto.setX(element.getX());
    dto.setY(element.getY());
    dto.setRegionId(ocrRegion.getId()); // regionId passed in the DTO

    MvcResult cloneResult =
        mockMvc
            .perform(
                post("/api/layers/" + clonedLayer.getId() + "/elements")
                    .header("Authorization", adminToken)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(dto)))
            .andExpect(status().isOk())
            .andReturn();

    Map<?, ?> clonedElement =
        objectMapper.readValue(cloneResult.getResponse().getContentAsString(), Map.class);
    assertNotNull(clonedElement.get("regionId"));
    assertEquals(ocrRegion.getId().toString(), clonedElement.get("regionId"));

    // 6. Test GET /api/internal/images/{imageId} with cloned layer
    MvcResult internalInfoResult =
        mockMvc
            .perform(
                get("/api/internal/images/" + image.getId()).header("Authorization", adminToken))
            .andExpect(status().isOk())
            .andReturn();

    Map<?, ?> info =
        objectMapper.readValue(
            internalInfoResult
                .getResponse()
                .getContentAsString(java.nio.charset.StandardCharsets.UTF_8),
            Map.class);
    List<?> ocrRegions = (List<?>) info.get("ocrRegions");
    assertEquals(1, ocrRegions.size());

    // 7. Toggle visibility of the cloned OCR layer to hidden
    clonedLayer.setVisible(false);
    layerRepository.save(clonedLayer);

    // Verify GET /api/internal/images/{imageId} STILL returns the region because it finds the
    // latest OCR layer regardless of visibility
    MvcResult hiddenInfoResult =
        mockMvc
            .perform(
                get("/api/internal/images/" + image.getId()).header("Authorization", adminToken))
            .andExpect(status().isOk())
            .andReturn();

    Map<?, ?> hiddenInfo =
        objectMapper.readValue(
            hiddenInfoResult
                .getResponse()
                .getContentAsString(java.nio.charset.StandardCharsets.UTF_8),
            Map.class);
    List<?> hiddenOcrRegions = (List<?>) hiddenInfo.get("ocrRegions");
    assertEquals(1, hiddenOcrRegions.size());
  }

  @SuppressWarnings("null")
  private <T> T mockGeneric(Class<?> clazz) {
    return (T) org.mockito.Mockito.mock(clazz);
  }

  @SuppressWarnings("null")
  private <T> T anyGeneric(Class<?> clazz) {
    return (T) org.mockito.ArgumentMatchers.any(clazz);
  }
}
