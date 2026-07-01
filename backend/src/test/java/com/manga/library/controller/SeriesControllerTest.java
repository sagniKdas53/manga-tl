package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
import com.manga.library.model.Series;
import com.manga.library.repository.ChapterRepository;
import com.manga.library.repository.ImageRepository;
import com.manga.library.repository.LayerRepository;
import com.manga.library.repository.PageRepository;
import com.manga.library.repository.SeriesRepository;
import com.manga.library.service.JobCoordinatorService;
import com.manga.library.service.MinioService;
import com.manga.library.service.PageService;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(SeriesController.class)
@AutoConfigureMockMvc(addFilters = false)
public class SeriesControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockBean private SeriesRepository seriesRepository;
  @MockBean private ChapterRepository chapterRepository;
  @MockBean private PageRepository pageRepository;
  @MockBean private ImageRepository imageRepository;
  @MockBean private LayerRepository layerRepository;
  @MockBean private PageService pageService;
  @MockBean private MinioService minioService;
  @MockBean private JobCoordinatorService jobCoordinatorService;
  @MockBean private JwtAuthFilter jwtAuthFilter;

  @Test
  public void testGetSeries_NotFound() throws Exception {
    UUID seriesId = UUID.randomUUID();
    when(seriesRepository.findById(seriesId)).thenReturn(Optional.empty());

    mockMvc
        .perform(get("/api/series/" + seriesId))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testGetSeries_Success() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = Series.builder().id(seriesId).title("Test Series").build();
    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));

    mockMvc
        .perform(get("/api/series/" + seriesId))
        .andExpect(status().isOk());
  }

  @Test
  public void testListSeries_Success() throws Exception {
    Series series = Series.builder().id(UUID.randomUUID()).title("Test Series").build();
    when(seriesRepository.findAll()).thenReturn(java.util.List.of(series));
    when(pageRepository.findDefaultCoverImageIds()).thenReturn(new java.util.ArrayList<>());

    mockMvc
        .perform(get("/api/series"))
        .andExpect(status().isOk());
  }

  @Test
  public void testCreateSeries_Success() throws Exception {
    Series series = Series.builder().id(UUID.randomUUID()).title("New Series").build();
    when(seriesRepository.save(any(Series.class))).thenReturn(series);

    String json = "{\"title\":\"New Series\",\"originalLanguage\":\"ja\",\"targetLanguage\":\"en\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/series")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isOk());
  }

  @Test
  public void testUpdateSeries_Success() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = Series.builder().id(seriesId).title("Old Series").build();
    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));
    when(seriesRepository.save(any(Series.class))).thenReturn(series);

    String json = "{\"title\":\"Updated Series\",\"originalLanguage\":\"ja\",\"targetLanguage\":\"en\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put("/api/series/" + seriesId)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isOk());
  }

  @Test
  public void testDeleteSeries_Success() throws Exception {
    UUID seriesId = UUID.randomUUID();
    when(seriesRepository.existsById(seriesId)).thenReturn(true);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete("/api/series/" + seriesId))
        .andExpect(status().isOk());
  }
}
