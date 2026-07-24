package com.manga.library.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.config.JwtAuthFilter;
import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.model.*;
import com.manga.library.repository.*;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.MinioService;
import com.manga.library.service.SseService;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(InternalJobController.class)
@AutoConfigureMockMvc(addFilters = false)
@SuppressWarnings("null")
public class InternalJobControllerTest {

  @Autowired private MockMvc mockMvc;
  @Autowired private ObjectMapper objectMapper;

  @MockBean private JobCoordinatorService jobCoordinatorService;
  @MockBean private ImageRepository imageRepository;
  @MockBean private PanelRepository panelRepository;
  @MockBean private OcrRegionRepository ocrRegionRepository;
  @MockBean private ConversationRepository conversationRepository;
  @MockBean private ConversationRegionRepository conversationRegionRepository;
  @MockBean private PageRepository pageRepository;
  @MockBean private ChapterRepository chapterRepository;
  @MockBean private MinioService minioService;
  @MockBean private LayerElementRepository layerElementRepository;
  @MockBean private LayerRepository layerRepository;
  @MockBean private SeriesRepository seriesRepository;
  @MockBean private SseService sseService;
  @MockBean private JwtAuthFilter jwtAuthFilter;
  @MockBean private JobRepository jobRepository;

  @Test
  public void testGetImageInfo_NotFound() throws Exception {
    UUID imageId = UUID.randomUUID();
    when(imageRepository.findById(imageId)).thenReturn(Optional.empty());

    mockMvc.perform(get("/api/internal/images/" + imageId)).andExpect(status().isNotFound());
  }

  @Test
  public void testGetImageInfo_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    Image image =
        new Image() {{ setId(imageId); setFilename("test.png"); setStoragePath("orig/test.png"); }};

    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));
    when(minioService.generatePresignedUrl(anyString())).thenReturn("http://presigned-url");
    when(panelRepository.findByImageId(imageId)).thenReturn(Collections.emptyList());

    // Set up active OCR layer and elements
    UUID ocrLayerId = UUID.randomUUID();
    Layer ocrLayer = new Layer() {{ setId(ocrLayerId); setType("ocr"); setZOrder(1); }};
    when(layerRepository.findByPageId(any())).thenReturn(Collections.singletonList(ocrLayer));

    UUID regionId = UUID.randomUUID();
    OcrRegion region = new OcrRegion() {{ setId(regionId); }};
    when(ocrRegionRepository.findByPageId(any())).thenReturn(Collections.singletonList(region));

    LayerElement element = new LayerElement() {{ setId(UUID.randomUUID()); setRegion(region); }};
    when(layerElementRepository.findByLayerId(ocrLayerId))
        .thenReturn(Collections.singletonList(element));
    when(layerElementRepository.findByLayerPageId(any()))
        .thenReturn(Collections.singletonList(element));

    // Page, Chapter, Series context
    Series series =
        new Series() {{ setId(UUID.randomUUID()); setTitle("Series Title"); setOriginalLanguage("ja"); }};
    Chapter chapter =
        new Chapter() {{ setId(UUID.randomUUID()); setSeries(series); setChapterNumber(2.0); }};
    Page page =
        new Page() {{ setId(UUID.randomUUID()); setChapter(chapter); setPageNumber(2); setImage(image); }};
    when(pageRepository.findByImageId(imageId)).thenReturn(Collections.singletonList(page));

    // Previous page text
    Page prevPage =
        new Page() {{ setId(UUID.randomUUID()); setPageNumber(1); setImage(new Image() {{ setId(UUID.randomUUID()); }}); }};
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(any()))
        .thenReturn(Arrays.asList(prevPage, page));
    OcrRegion prevRegion =
        new OcrRegion() {{ setId(UUID.randomUUID()); setText("prev text"); setTranslatedText("translated prev"); }};
    when(ocrRegionRepository.findByPageId(prevPage.getId()))
        .thenReturn(Collections.singletonList(prevRegion));

    // Previous chapter summary
    Chapter prevChapter = new Chapter() {{ setId(UUID.randomUUID()); setSummaryJson("summary"); }};
    when(chapterRepository.findBySeriesIdAndChapterNumber(any(), eq(1.0)))
        .thenReturn(Optional.of(prevChapter));

    // Conversations
    Conversation conv = new Conversation() {{ setId(UUID.randomUUID()); setSceneType("dialogue"); }};
    when(conversationRepository.findByPageId(any())).thenReturn(Collections.singletonList(conv));
    ConversationRegion cr = new ConversationRegion() {{ setRegionId(regionId); setPosition(1); }};
    when(conversationRegionRepository.findByConversationId(conv.getId()))
        .thenReturn(Collections.singletonList(cr));

    mockMvc.perform(get("/api/internal/images/" + imageId)).andExpect(status().isOk());
  }

  @Test
  public void testPanelCallback_Success() throws Exception {
    PanelCallbackDto dto = new PanelCallbackDto(UUID.randomUUID(), null, null);
    mockMvc
        .perform(
            post("/api/internal/jobs/callback/panel")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
        .andExpect(status().isOk());

    verify(jobCoordinatorService, times(1)).handlePanelCallback(any(PanelCallbackDto.class));
  }

  @Test
  public void testPanelCallback_Failure() throws Exception {
    PanelCallbackDto dto = new PanelCallbackDto(UUID.randomUUID(), null, null);
    doThrow(new RuntimeException("error"))
        .when(jobCoordinatorService)
        .handlePanelCallback(any(PanelCallbackDto.class));

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/panel")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testOcrCallback_Success() throws Exception {
    OcrCallbackDto dto = new OcrCallbackDto(UUID.randomUUID(), null, null, null, null, null);
    doNothing().when(jobCoordinatorService).handleOcrCallback(any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/ocr")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
        .andExpect(status().isOk());
  }

  @Test
  public void testOcrCallback_Failure() throws Exception {
    OcrCallbackDto dto = new OcrCallbackDto(UUID.randomUUID(), null, null, null, null, null);
    doThrow(new RuntimeException("error")).when(jobCoordinatorService).handleOcrCallback(any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/ocr")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testTranslateCallback_Success() throws Exception {
    PanelCallbackDto dto = new PanelCallbackDto(UUID.randomUUID(), null, null);
    doNothing().when(jobCoordinatorService).handleTranslationCallback(any(), any(), any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/translation")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
        .andExpect(status().isOk());
  }

  @Test
  public void testLayoutCallback_Success() throws Exception {
    PanelCallbackDto dto = new PanelCallbackDto(UUID.randomUUID(), null, null);
    doNothing().when(jobCoordinatorService).handleLayoutCallback(any(), any(), any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/layout")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
        .andExpect(status().isOk());
  }

  @Test
  public void testQaCallback_Success() throws Exception {
    PanelCallbackDto dto = new PanelCallbackDto(UUID.randomUUID(), null, null);
    doReturn("PASSED").when(jobCoordinatorService).handleQaCallback(any(), any(), any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/qa")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
        .andExpect(status().isOk());
  }

  @Test
  public void testQaReOcrCallback_Success() throws Exception {
    Map<String, Object> payload = new HashMap<>();
    payload.put("imageId", UUID.randomUUID().toString());
    payload.put("results", List.of());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/qa-re-ocr")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isOk());
  }

  @Test
  public void testRegionCallback_Success() throws Exception {
    UUID regionId = UUID.randomUUID();
    OcrRegion region =
        new OcrRegion() {{ setId(regionId); setPage(
                new Page() {{ setId(UUID.randomUUID()); setImage(new Image() {{ setId(UUID.randomUUID()); }}); }}); }};
    when(ocrRegionRepository.findById(regionId)).thenReturn(Optional.of(region));

    Map<String, Object> payload = new HashMap<>();
    payload.put("text", "updated text");
    payload.put("translatedText", "updated translation");

    mockMvc
        .perform(
            post("/api/internal/ocr-regions/" + regionId + "/callback")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isOk());
  }

  @Test
  public void testRenderCallback_Success() throws Exception {
    Map<String, String> payload = new HashMap<>();
    payload.put("imageId", UUID.randomUUID().toString());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/render")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isOk());
  }

  @Test
  public void testLayoutCallback_Failure() throws Exception {
    Map<String, Object> payload = new HashMap<>();
    payload.put("imageId", UUID.randomUUID().toString());
    doThrow(new RuntimeException("error"))
        .when(jobCoordinatorService)
        .handleLayoutCallback(any(), any(), any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/layout")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testTranslationCallback_Failure() throws Exception {
    Map<String, Object> payload = new HashMap<>();
    payload.put("imageId", UUID.randomUUID().toString());
    doThrow(new RuntimeException("error"))
        .when(jobCoordinatorService)
        .handleTranslationCallback(any(), any(), any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/translation")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testQaReOcrCallback_Failure() throws Exception {
    Map<String, Object> payload = new HashMap<>();
    payload.put("imageId", UUID.randomUUID().toString());
    doThrow(new RuntimeException("error"))
        .when(jobCoordinatorService)
        .handleQaReOcrCallback(any(), any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/qa-re-ocr")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testRegionCallback_Failure() throws Exception {
    UUID regionId = UUID.randomUUID();
    when(ocrRegionRepository.findById(regionId)).thenThrow(new RuntimeException("error"));

    mockMvc
        .perform(
            post("/api/internal/ocr-regions/" + regionId + "/callback")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}"))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testRenderCallback_Failure() throws Exception {
    Map<String, String> payload = new HashMap<>();
    payload.put("imageId", UUID.randomUUID().toString());
    doThrow(new RuntimeException("error")).when(jobCoordinatorService).handleRenderCallback(any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/render")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testQaCallback_Failure() throws Exception {
    Map<String, Object> payload = new HashMap<>();
    payload.put("imageId", UUID.randomUUID().toString());
    doThrow(new RuntimeException("error"))
        .when(jobCoordinatorService)
        .handleQaCallback(any(), any(), any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/qa")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testResolveNotificationContext_Exception() throws Exception {
    UUID imageId = UUID.randomUUID();
    when(pageRepository.findByImageId(imageId)).thenThrow(new RuntimeException("db error"));
    PanelCallbackDto dto = new PanelCallbackDto(imageId, null, null);

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/panel")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
        .andExpect(status().isOk());
  }

  @Test
  public void testGetImageInfo_PageOneNoChapter() throws Exception {
    UUID imageId = UUID.randomUUID();
    Image image = new Image() {{ setId(imageId); setFilename("test.png"); }};
    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));

    Series series = new Series() {{ setId(UUID.randomUUID()); setTitle("Series Title"); }};
    Chapter chapter =
        new Chapter() {{ setId(UUID.randomUUID()); setSeries(series); setChapterNumber(1.0); }};
    Page page =
        new Page() {{ setId(UUID.randomUUID()); setPageNumber(1); setImage(image); setChapter(chapter); }};
    when(pageRepository.findByImageId(imageId)).thenReturn(Collections.singletonList(page));

    mockMvc.perform(get("/api/internal/images/" + imageId)).andExpect(status().isOk());
  }

  @Test
  public void testGetJob_Success() throws Exception {
    Job job = new Job() {{ setId("job1"); setType("ocr"); setStatus("PENDING"); }};
    when(jobRepository.findById("job1")).thenReturn(Optional.of(job));

    mockMvc
        .perform(get("/api/internal/jobs/job1"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.id").value("job1"))
        .andExpect(jsonPath("$.status").value("PENDING"));
  }

  @Test
  public void testGetJob_NotFound() throws Exception {
    when(jobRepository.findById("job1")).thenReturn(Optional.empty());

    mockMvc.perform(get("/api/internal/jobs/job1")).andExpect(status().isNotFound());
  }

  @Test
  public void testQaHybridPrepare_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    Map<String, Object> payload = new HashMap<>();
    payload.put(
        "qaResults",
        List.of(Map.of("regionId", UUID.randomUUID().toString(), "qaStatus", "passed")));

    doNothing().when(jobCoordinatorService).prepareHybridQa(any(), any());

    mockMvc
        .perform(
            post("/api/internal/images/" + imageId + "/qa-hybrid-prepare")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isOk());
  }

  @Test
  public void testQaHybridPrepare_Failure() throws Exception {
    UUID imageId = UUID.randomUUID();
    Map<String, Object> payload = new HashMap<>();
    payload.put(
        "qaResults",
        List.of(Map.of("regionId", UUID.randomUUID().toString(), "qaStatus", "passed")));

    doThrow(new RuntimeException("prepare error"))
        .when(jobCoordinatorService)
        .prepareHybridQa(any(), any());

    mockMvc
        .perform(
            post("/api/internal/images/" + imageId + "/qa-hybrid-prepare")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testUpdateJobStatus_WithAttemptUpdate() throws Exception {
    Job job =
        new Job() {{ setId("job1"); setType("ocr"); setStatus("PROCESSING"); setPayload("{\"attempt\": 1, \"jobId\": \"job1\"}"); setAttempt(1); }};
    when(jobRepository.findById("job1")).thenReturn(Optional.of(job));

    Map<String, String> payload = new HashMap<>();
    payload.put("status", "PENDING");
    payload.put("attempt", "2");

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch(
                    "/api/internal/jobs/job1/status")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isOk());

    org.junit.jupiter.api.Assertions.assertEquals(2, job.getAttempt());
    org.junit.jupiter.api.Assertions.assertTrue(job.getPayload().contains("\"attempt\":2"));
    verify(jobCoordinatorService, times(1)).pushJobToRedis(job);
  }

  @Test
  public void testTranslationCallback_WithBooleanType_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    Map<String, Object> payload =
        Map.of(
            "imageId", imageId.toString(),
            "translationFailed", false,
            "translations",
                List.of(
                    Map.of(
                        "regionId",
                        UUID.randomUUID().toString(),
                        "translatedText",
                        "Hello world",
                        "translationFailed",
                        false)));

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/translation")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isOk());

    verify(jobCoordinatorService, times(1)).handleTranslationCallback(eq(imageId), any(), any());
  }

  @Test
  public void testRenderCallback_WithStringMap_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    Map<String, String> payload =
        Map.of("imageId", imageId.toString(), "storagePath", "renders/output.png");

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/render")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isOk());

    verify(jobCoordinatorService, times(1)).handleRenderCallback(any());
  }
}
