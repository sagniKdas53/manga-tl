package com.manga.library.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.config.JwtAuthFilter;
import com.manga.library.dto.OcrCallbackDto;
import com.manga.library.dto.PanelCallbackDto;
import com.manga.library.repository.*;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.MinioService;
import com.manga.library.service.SseService;
import java.util.Optional;
import java.util.UUID;
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

  @Test
  public void testGetImageInfo_NotFound() throws Exception {
    UUID imageId = UUID.randomUUID();
    when(imageRepository.findById(imageId)).thenReturn(Optional.empty());

    mockMvc.perform(get("/api/internal/images/" + imageId)).andExpect(status().isNotFound());
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
    doNothing().when(jobCoordinatorService).handleQaCallback(any(), any(), any());

    mockMvc
        .perform(
            post("/api/internal/jobs/callback/qa")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
        .andExpect(status().isOk());
  }
}
