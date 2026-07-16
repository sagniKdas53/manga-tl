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
  @MockBean private com.manga.library.service.ChapterExportService chapterExportService;
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
        .andExpect(status().isAccepted());
  }

  @Test
  public void testExportChapter_NoPages() throws Exception {
    UUID chapterId = UUID.randomUUID();
    com.manga.library.model.Chapter chapter =
        com.manga.library.model.Chapter.builder().id(chapterId).build();
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.Collections.emptyList());

    mockMvc
        .perform(get("/api/series/chapters/" + chapterId + "/export").param("format", "zip"))
        .andExpect(status().isBadRequest());
  }

  @Test
  public void testDeleteChapter_NotFound() throws Exception {
    UUID chapterId = UUID.randomUUID();
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.empty());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete(
                "/api/series/chapters/" + chapterId))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testImportChapter_Failure() throws Exception {
    UUID seriesId = UUID.randomUUID();
    when(seriesRepository.findById(seriesId)).thenThrow(new RuntimeException("db error"));

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.zip", "application/zip", "dummy zip".getBytes());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/series/" + seriesId + "/chapters/import")
                .file(file)
                .param("chapterNumber", "1.0")
                .param("title", "Ch 1"))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testUpdateSeries_NotFound() throws Exception {
    UUID seriesId = UUID.randomUUID();
    when(seriesRepository.findById(seriesId)).thenReturn(Optional.empty());

    String json = "{\"title\":\"Updated Series\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/series/" + seriesId)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testDeleteSeries_NotFound() throws Exception {
    UUID seriesId = UUID.randomUUID();
    when(seriesRepository.existsById(seriesId)).thenReturn(false);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete(
                "/api/series/" + seriesId))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testCreateChapter_SeriesNotFound() throws Exception {
    UUID seriesId = UUID.randomUUID();
    when(seriesRepository.findById(seriesId)).thenReturn(Optional.empty());

    String json = "{\"chapterNumber\":1.0,\"title\":\"Ch 1\"}";
    org.junit.jupiter.api.Assertions.assertThrows(
        Exception.class,
        () ->
            mockMvc.perform(
                org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(
                        "/api/series/" + seriesId + "/chapters")
                    .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                    .content(json)));
  }

  @Test
  public void testUpdateChapter_NotFound() throws Exception {
    UUID chapterId = UUID.randomUUID();
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.empty());

    String json = "{\"chapterNumber\":2.0,\"title\":\"New Title\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/series/chapters/" + chapterId)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testListChapters_SeriesNotFound() throws Exception {
    UUID seriesId = UUID.randomUUID();
    when(seriesRepository.existsById(seriesId)).thenReturn(false);

    mockMvc.perform(get("/api/series/" + seriesId + "/chapters")).andExpect(status().isOk());
  }

  @Test
  public void testGetChapter_NotFound() throws Exception {
    UUID chapterId = UUID.randomUUID();
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.empty());

    mockMvc.perform(get("/api/series/chapters/" + chapterId)).andExpect(status().isNotFound());
  }

  @Test
  public void testExportChapter_NotFound() throws Exception {
    UUID chapterId = UUID.randomUUID();
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.empty());

    org.junit.jupiter.api.Assertions.assertThrows(
        Exception.class,
        () ->
            mockMvc.perform(
                get("/api/series/chapters/" + chapterId + "/export").param("format", "zip")));
  }

  @Test
  public void testCreateChapter_Conflict() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = Series.builder().id(seriesId).title("Test Series").build();
    com.manga.library.model.Chapter chapter =
        com.manga.library.model.Chapter.builder()
            .id(UUID.randomUUID())
            .chapterNumber(1.0)
            .title("Ch 1")
            .build();

    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));
    when(chapterRepository.findBySeriesIdAndChapterNumber(seriesId, 1.0))
        .thenReturn(Optional.of(chapter));

    String json = "{\"chapterNumber\":1.0,\"title\":\"Ch 1\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(
                    "/api/series/" + seriesId + "/chapters")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isConflict());
  }

  @Test
  public void testUpdateChapter_Conflict() throws Exception {
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

    com.manga.library.model.Chapter existingChapter =
        com.manga.library.model.Chapter.builder()
            .id(UUID.randomUUID())
            .series(series)
            .chapterNumber(2.0)
            .title("Existing Title")
            .build();

    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    when(chapterRepository.findBySeriesIdAndChapterNumber(seriesId, 2.0))
        .thenReturn(Optional.of(existingChapter));

    String json = "{\"chapterNumber\":2.0,\"title\":\"New Title\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/series/chapters/" + chapterId)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isConflict());
  }

  @Test
  public void testImportChapter_Conflict() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = Series.builder().id(seriesId).title("Test Series").build();
    com.manga.library.model.Chapter existingChapter =
        com.manga.library.model.Chapter.builder()
            .id(UUID.randomUUID())
            .series(series)
            .chapterNumber(1.0)
            .title("Existing")
            .build();

    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));
    when(chapterRepository.findBySeriesIdAndChapterNumber(seriesId, 1.0))
        .thenReturn(Optional.of(existingChapter));

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.zip", "application/zip", "dummy zip".getBytes());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/series/" + seriesId + "/chapters/import")
                .file(file)
                .param("chapterNumber", "1.0")
                .param("title", "Ch 1"))
        .andExpect(status().isConflict());
  }

  @Test
  public void testImportChapter_EmptyZip() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = Series.builder().id(seriesId).title("Test Series").build();

    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));
    when(chapterRepository.findBySeriesIdAndChapterNumber(seriesId, 1.0))
        .thenReturn(Optional.empty());

    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos);
    zos.finish(); // empty zip

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.zip", "application/zip", baos.toByteArray());

    com.manga.library.model.Chapter chapter =
        com.manga.library.model.Chapter.builder()
            .id(UUID.randomUUID())
            .chapterNumber(1.0)
            .title("Ch 1")
            .build();
    when(chapterRepository.save(any(com.manga.library.model.Chapter.class))).thenReturn(chapter);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/series/" + seriesId + "/chapters/import")
                .file(file)
                .param("chapterNumber", "1.0")
                .param("title", "Ch 1"))
        .andExpect(status().isBadRequest());
  }

  @Test
  public void testExportChapter_WithMetadataAndCosts() throws Exception {
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

    com.fasterxml.jackson.databind.ObjectMapper mapper =
        new com.fasterxml.jackson.databind.ObjectMapper();
    com.fasterxml.jackson.databind.node.ObjectNode metadata = mapper.createObjectNode();
    metadata.put("model", "gpt-4o");

    com.fasterxml.jackson.databind.node.ObjectNode costNode = mapper.createObjectNode();
    costNode.put("estimated_cost", 0.0025);
    metadata.set("cost", costNode);

    com.fasterxml.jackson.databind.node.ObjectNode qaNode = mapper.createObjectNode();
    qaNode.put("status", "passed");
    com.fasterxml.jackson.databind.node.ObjectNode qaCostNode = mapper.createObjectNode();
    qaCostNode.put("estimated_cost", 0.0015);
    qaNode.set("cost", qaCostNode);
    metadata.set("qa", qaNode);

    com.manga.library.model.Layer activeLayer =
        com.manga.library.model.Layer.builder()
            .id(UUID.randomUUID())
            .type("translation")
            .visible(true)
            .metadataJson(metadata)
            .build();

    when(layerRepository.findByImageId(any())).thenReturn(java.util.List.of(activeLayer));
    when(layerElementRepository.findByLayerId(any())).thenReturn(java.util.Collections.emptyList());

    mockMvc
        .perform(get("/api/series/chapters/" + chapterId + "/export").param("format", "zip"))
        .andExpect(status().isAccepted());
  }
}
