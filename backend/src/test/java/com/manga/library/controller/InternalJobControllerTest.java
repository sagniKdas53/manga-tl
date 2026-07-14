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
        Image.builder().id(imageId).filename("test.png").storagePath("orig/test.png").build();

    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));
    when(minioService.generatePresignedUrl(anyString())).thenReturn("http://presigned-url");
    when(panelRepository.findByImageId(imageId)).thenReturn(Collections.emptyList());

    // Set up active OCR layer and elements
    UUID ocrLayerId = UUID.randomUUID();
    Layer ocrLayer = Layer.builder().id(ocrLayerId).type("ocr").zOrder(1).build();
    when(layerRepository.findByImageId(imageId)).thenReturn(Collections.singletonList(ocrLayer));

    UUID regionId = UUID.randomUUID();
    OcrRegion region = OcrRegion.builder().id(regionId).build();
    when(ocrRegionRepository.findByImageId(imageId)).thenReturn(Collections.singletonList(region));

    LayerElement element = LayerElement.builder().id(UUID.randomUUID()).region(region).build();
    when(layerElementRepository.findByLayerId(ocrLayerId))
        .thenReturn(Collections.singletonList(element));
    when(layerElementRepository.findByLayerImageId(imageId))
        .thenReturn(Collections.singletonList(element));

    // Page, Chapter, Series context
    Series series =
        Series.builder().id(UUID.randomUUID()).title("Series Title").originalLanguage("ja").build();
    Chapter chapter =
        Chapter.builder().id(UUID.randomUUID()).series(series).chapterNumber(2.0).build();
    Page page =
        Page.builder().id(UUID.randomUUID()).chapter(chapter).pageNumber(2).image(image).build();
    when(pageRepository.findByImageId(imageId)).thenReturn(Collections.singletonList(page));

    // Previous page text
    Page prevPage =
        Page.builder()
            .id(UUID.randomUUID())
            .pageNumber(1)
            .image(Image.builder().id(UUID.randomUUID()).build())
            .build();
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(any()))
        .thenReturn(Arrays.asList(prevPage, page));
    OcrRegion prevRegion =
        OcrRegion.builder()
            .id(UUID.randomUUID())
            .text("prev text")
            .translatedText("translated prev")
            .build();
    when(ocrRegionRepository.findByImageId(prevPage.getImage().getId()))
        .thenReturn(Collections.singletonList(prevRegion));

    // Previous chapter summary
    Chapter prevChapter = Chapter.builder().id(UUID.randomUUID()).summaryJson("summary").build();
    when(chapterRepository.findBySeriesIdAndChapterNumber(any(), eq(1.0)))
        .thenReturn(Optional.of(prevChapter));

    // Conversations
    Conversation conv = Conversation.builder().id(UUID.randomUUID()).sceneType("dialogue").build();
    when(conversationRepository.findByImageId(imageId)).thenReturn(Collections.singletonList(conv));
    ConversationRegion cr = ConversationRegion.builder().regionId(regionId).position(1).build();
    when(conversationRegionRepository.findByConversationId(conv.getId()))
        .thenReturn(Collections.singletonList(cr));

    mockMvc.perform(get("/api/internal/images/" + imageId)).andExpect(status().isOk());
  }

  @Test
  public void testPanelCallback_Success() throws Exception {
    PanelCallbackDto dto = new PanelCallbackDto();
    dto.setImageId(UUID.randomUUID());

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
    PanelCallbackDto dto = new PanelCallbackDto();
    dto.setImageId(UUID.randomUUID());
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
    OcrCallbackDto dto = new OcrCallbackDto();
    dto.setImageId(UUID.randomUUID());
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
    OcrCallbackDto dto = new OcrCallbackDto();
    dto.setImageId(UUID.randomUUID());
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
    PanelCallbackDto dto = new PanelCallbackDto();
    dto.setImageId(UUID.randomUUID());
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
    PanelCallbackDto dto = new PanelCallbackDto();
    dto.setImageId(UUID.randomUUID());
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
    PanelCallbackDto dto = new PanelCallbackDto();
    dto.setImageId(UUID.randomUUID());
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
        OcrRegion.builder()
            .id(regionId)
            .image(Image.builder().id(UUID.randomUUID()).build())
            .build();
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
    PanelCallbackDto dto = new PanelCallbackDto();
    dto.setImageId(imageId);

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
    Image image = Image.builder().id(imageId).filename("test.png").build();
    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));

    Series series = Series.builder().id(UUID.randomUUID()).title("Series Title").build();
    Chapter chapter =
        Chapter.builder().id(UUID.randomUUID()).series(series).chapterNumber(1.0).build();
    Page page =
        Page.builder().id(UUID.randomUUID()).pageNumber(1).image(image).chapter(chapter).build();
    when(pageRepository.findByImageId(imageId)).thenReturn(Collections.singletonList(page));

    mockMvc.perform(get("/api/internal/images/" + imageId)).andExpect(status().isOk());
  }

  @Test
  public void testGetJob_Success() throws Exception {
    Job job = Job.builder().id("job1").type("ocr").status("PENDING").build();
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
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testUpdateJobStatus_WithAttemptUpdate() throws Exception {
    Job job = Job.builder()
        .id("job1")
        .type("ocr")
        .status("PROCESSING")
        .payload("{\"attempt\": 1, \"jobId\": \"job1\"}")
        .attempt(1)
        .build();
    when(jobRepository.findById("job1")).thenReturn(Optional.of(job));

    Map<String, String> payload = new HashMap<>();
    payload.put("status", "PENDING");
    payload.put("attempt", "2");

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch("/api/internal/jobs/job1/status")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(payload)))
        .andExpect(status().isOk());

    org.junit.jupiter.api.Assertions.assertEquals(2, job.getAttempt());
    org.junit.jupiter.api.Assertions.assertTrue(job.getPayload().contains("\"attempt\":2"));
    verify(jobCoordinatorService, times(1)).pushJobToRedis(job);
  }
}
