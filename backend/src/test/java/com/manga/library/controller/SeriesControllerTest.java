package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
import com.manga.library.model.Series;
import com.manga.library.repository.ChapterRepository;
import com.manga.library.repository.ImageRepository;
import com.manga.library.repository.LayerElementRepository;
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
  @MockBean private LayerElementRepository layerElementRepository;
  @MockBean private PageService pageService;
  @MockBean private MinioService minioService;
  @MockBean private JobCoordinatorService jobCoordinatorService;
  @MockBean private JwtAuthFilter jwtAuthFilter;

  @Test
  public void testGetSeries_NotFound() throws Exception {
    UUID seriesId = UUID.randomUUID();
    when(seriesRepository.findById(seriesId)).thenReturn(Optional.empty());

    mockMvc.perform(get("/api/series/" + seriesId)).andExpect(status().isNotFound());
  }

  @Test
  public void testGetSeries_Success() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = Series.builder().id(seriesId).title("Test Series").build();
    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));

    mockMvc.perform(get("/api/series/" + seriesId)).andExpect(status().isOk());
  }

  @Test
  public void testListSeries_Success() throws Exception {
    Series series = Series.builder().id(UUID.randomUUID()).title("Test Series").build();
    when(seriesRepository.findAll()).thenReturn(java.util.List.of(series));
    when(pageRepository.findDefaultCoverImageIds()).thenReturn(new java.util.ArrayList<>());

    mockMvc.perform(get("/api/series")).andExpect(status().isOk());
  }

  @Test
  public void testCreateSeries_Success() throws Exception {
    Series series = Series.builder().id(UUID.randomUUID()).title("New Series").build();
    when(seriesRepository.save(any(Series.class))).thenReturn(series);

    String json =
        "{\"title\":\"New Series\",\"originalLanguage\":\"ja\",\"targetLanguage\":\"en\"}";
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

    String json =
        "{\"title\":\"Updated Series\",\"originalLanguage\":\"ja\",\"targetLanguage\":\"en\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/series/" + seriesId)
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
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete(
                "/api/series/" + seriesId))
        .andExpect(status().isOk());
  }

  @Test
  public void testCreateChapter_Success() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = Series.builder().id(seriesId).title("Test Series").build();
    com.manga.library.model.Chapter chapter =
        com.manga.library.model.Chapter.builder()
            .id(UUID.randomUUID())
            .chapterNumber(1.0)
            .title("Ch 1")
            .build();

    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));
    when(chapterRepository.save(any(com.manga.library.model.Chapter.class))).thenReturn(chapter);

    String json = "{\"chapterNumber\":1.0,\"title\":\"Ch 1\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(
                    "/api/series/" + seriesId + "/chapters")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isOk());
  }

  @Test
  public void testUpdateChapter_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID seriesId = UUID.randomUUID();
    Series series = Series.builder().id(seriesId).build();
    com.manga.library.model.Chapter chapter =
        com.manga.library.model.Chapter.builder()
            .id(chapterId)
            .series(series)
            .chapterNumber(1.0)
            .title("Old Title")
            .build();

    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    when(chapterRepository.save(any(com.manga.library.model.Chapter.class))).thenReturn(chapter);

    String json = "{\"chapterNumber\":2.0,\"title\":\"New Title\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/series/chapters/" + chapterId)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isOk());
  }

  @Test
  public void testListChapters_Success() throws Exception {
    UUID seriesId = UUID.randomUUID();
    when(seriesRepository.existsById(seriesId)).thenReturn(true);
    when(chapterRepository.findBySeriesId(seriesId)).thenReturn(java.util.Collections.emptyList());

    mockMvc.perform(get("/api/series/" + seriesId + "/chapters")).andExpect(status().isOk());
  }

  @Test
  public void testGetChapter_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Series series = Series.builder().id(UUID.randomUUID()).build();
    com.manga.library.model.Chapter chapter =
        com.manga.library.model.Chapter.builder().id(chapterId).series(series).build();
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));

    mockMvc.perform(get("/api/series/chapters/" + chapterId)).andExpect(status().isOk());
  }

  @Test
  public void testDeleteChapter_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    com.manga.library.model.Chapter chapter =
        com.manga.library.model.Chapter.builder().id(chapterId).build();

    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId)).thenReturn(null);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete(
                "/api/series/chapters/" + chapterId))
        .andExpect(status().isOk());

    verify(chapterRepository, times(1)).delete(chapter);
  }

  @Test
  public void testImportChapter_Success() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = Series.builder().id(seriesId).title("Test Series").build();
    com.manga.library.model.Chapter chapter =
        com.manga.library.model.Chapter.builder()
            .id(UUID.randomUUID())
            .chapterNumber(1.0)
            .title("Ch 1")
            .build();

    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));
    when(chapterRepository.save(any(com.manga.library.model.Chapter.class))).thenReturn(chapter);

    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos);
    zos.putNextEntry(new java.util.zip.ZipEntry("page1.png"));
    zos.write("dummy image content".getBytes());
    zos.closeEntry();
    zos.finish();

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.zip", "application/zip", baos.toByteArray());

    when(pageService.getFileExtension(anyString())).thenReturn(".png");

    com.manga.library.model.Image image =
        com.manga.library.model.Image.builder().id(UUID.randomUUID()).build();
    com.manga.library.model.Page page =
        com.manga.library.model.Page.builder().id(UUID.randomUUID()).image(image).build();
    when(pageService.createPageAndImage(any(), any(), any(), any(), any(), any(), any()))
        .thenReturn(page);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/series/" + seriesId + "/chapters/import")
                .file(file)
                .param("chapterNumber", "1.0")
                .param("title", "Ch 1"))
        .andExpect(status().isOk());
  }

  @Test
  public void testExportChapter_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    com.manga.library.model.Chapter chapter =
        com.manga.library.model.Chapter.builder()
            .id(chapterId)
            .chapterNumber(1.0)
            .title("Ch 1")
            .build();
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));

    com.manga.library.model.Image img =
        com.manga.library.model.Image.builder()
            .id(UUID.randomUUID())
            .filename("page1.png")
            .storagePath("orig/page1.png")
            .build();
    com.manga.library.model.Page page =
        com.manga.library.model.Page.builder()
            .id(UUID.randomUUID())
            .pageNumber(1)
            .image(img)
            .build();

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.List.of(page));
    when(minioService.downloadFile(anyString()))
        .thenReturn(new java.io.ByteArrayInputStream("dummy".getBytes()));

    com.manga.library.model.Layer activeLayer =
        com.manga.library.model.Layer.builder()
            .id(UUID.randomUUID())
            .type("translation")
            .visible(true)
            .build();
    when(layerRepository.findByImageId(any())).thenReturn(java.util.List.of(activeLayer));
    when(layerElementRepository.findByLayerId(any())).thenReturn(java.util.Collections.emptyList());

    mockMvc
        .perform(get("/api/series/chapters/" + chapterId + "/export").param("format", "zip"))
        .andExpect(status().isOk());
  }
}
