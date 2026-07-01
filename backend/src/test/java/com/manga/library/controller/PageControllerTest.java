package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.config.JwtAuthFilter;
import com.manga.library.dto.PageDto;
import com.manga.library.model.Chapter;
import com.manga.library.model.Image;
import com.manga.library.model.Page;
import com.manga.library.repository.*;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.MinioService;
import com.manga.library.service.PageService;
import com.manga.library.service.SseService;
import java.util.Collections;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(PageController.class)
@AutoConfigureMockMvc(addFilters = false)
public class PageControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockBean private SeriesRepository seriesRepository;
  @MockBean private ChapterRepository chapterRepository;
  @MockBean private ImageRepository imageRepository;
  @MockBean private PageRepository pageRepository;
  @MockBean private PanelRepository panelRepository;
  @MockBean private OcrRegionRepository ocrRegionRepository;
  @MockBean private LayerRepository layerRepository;
  @MockBean private LayerElementRepository layerElementRepository;
  @MockBean private MinioService minioService;
  @MockBean private JobCoordinatorService jobCoordinatorService;
  @MockBean private PageService pageService;
  @MockBean private ConversationRepository conversationRepository;
  @MockBean private ConversationRegionRepository conversationRegionRepository;
  @MockBean private SseService sseService;
  @MockBean private LayerEditHistoryRepository layerEditHistoryRepository;
  @MockBean private JwtAuthFilter jwtAuthFilter;

  @Test
  public void testGetPage_Success() throws Exception {
    UUID pageId = UUID.randomUUID();
    UUID imageId = UUID.randomUUID();
    UUID chapterId = UUID.randomUUID();

    Image image = Image.builder().id(imageId).filename("test.png").build();
    Chapter chapter = Chapter.builder().id(chapterId).build();
    Page page = Page.builder()
        .id(pageId)
        .pageNumber(1)
        .image(image)
        .chapter(chapter)
        .build();

    when(pageRepository.findById(pageId)).thenReturn(Optional.of(page));

    mockMvc
        .perform(get("/api/pages/" + pageId))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.id").value(pageId.toString()))
        .andExpect(jsonPath("$.pageNumber").value(1))
        .andExpect(jsonPath("$.imageId").value(imageId.toString()))
        .andExpect(jsonPath("$.chapterId").value(chapterId.toString()));
  }

  @Test
  public void testGetPage_NotFound() throws Exception {
    UUID pageId = UUID.randomUUID();
    when(pageRepository.findById(pageId)).thenReturn(Optional.empty());

    mockMvc
        .perform(get("/api/pages/" + pageId))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testListPages_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID pageId = UUID.randomUUID();
    UUID imageId = UUID.randomUUID();

    Image image = Image.builder().id(imageId).filename("test.png").build();
    Chapter chapter = Chapter.builder().id(chapterId).build();
    Page page = Page.builder()
        .id(pageId)
        .pageNumber(1)
        .image(image)
        .chapter(chapter)
        .build();

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(Collections.singletonList(page));

    mockMvc
        .perform(get("/api/chapters/" + chapterId + "/pages"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].id").value(pageId.toString()))
        .andExpect(jsonPath("$[0].pageNumber").value(1));
  }
}
