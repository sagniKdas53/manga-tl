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
import com.manga.library.service.SystemSettingsService;
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
@SuppressWarnings("null")
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
  @MockBean private SystemSettingsService systemSettingsService;
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
    UUID coverId = UUID.randomUUID();
    Series series =
        new Series() {{ setId(seriesId); setTitle("Test Series"); setCoverImageId(coverId); }};
    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));

    mockMvc
        .perform(get("/api/series/" + seriesId))
        .andExpect(status().isOk())
        .andExpect(
            org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath(
                    "$.coverImageUrl")
                .value(
                    org.hamcrest.Matchers.containsString("/api/images/" + coverId + "/thumbnail")));
  }

  @Test
  public void testListSeries_Success() throws Exception {
    Series series = new Series() {{ setId(UUID.randomUUID()); setTitle("Test Series"); }};
    when(seriesRepository.findAll()).thenReturn(java.util.List.of(series));
    mockMvc.perform(get("/api/series")).andExpect(status().isOk());
  }

  @Test
  public void testCreateSeries_Success() throws Exception {
    Series series = new Series() {{ setId(UUID.randomUUID()); setTitle("New Series"); }};
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
  public void testCreateSeries_WithOverrides() throws Exception {
    Series series =
        new Series() {{ setId(UUID.randomUUID()); setTitle("Override Series"); setOcrProvider("openrouter"); setOcrModel("google/gemini-2.5-flash"); setTlProvider("openrouter"); setTlModel("deepseek/deepseek-v4-flash"); setQaProvider("openrouter"); setQaLlmModel("tencent/hy3:free"); setQaVlmModel("google/gemini-2.5-flash"); setQaMode("hybrid"); setRoutingStrategy("lowest-cost"); }};
    when(seriesRepository.save(any(Series.class))).thenReturn(series);

    String json =
        "{"
            + "\"title\":\"Override Series\","
            + "\"originalLanguage\":\"ja\","
            + "\"targetLanguage\":\"en\","
            + "\"ocrProvider\":\"openrouter\","
            + "\"ocrModel\":\"google/gemini-2.5-flash\","
            + "\"tlProvider\":\"openrouter\","
            + "\"tlModel\":\"deepseek/deepseek-v4-flash\","
            + "\"qaProvider\":\"openrouter\","
            + "\"qaLlmModel\":\"tencent/hy3:free\","
            + "\"qaVlmModel\":\"google/gemini-2.5-flash\","
            + "\"qaMode\":\"hybrid\","
            + "\"routingStrategy\":\"lowest-cost\","
            + "\"useFallbackModels\":false"
            + "}";

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/series")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isOk());

    org.mockito.ArgumentCaptor<Series> savedCaptor =
        org.mockito.ArgumentCaptor.forClass(Series.class);
    verify(seriesRepository).save(savedCaptor.capture());
    Series saved = savedCaptor.getValue();

    org.junit.jupiter.api.Assertions.assertEquals("openrouter", saved.getOcrProvider());
    org.junit.jupiter.api.Assertions.assertEquals("google/gemini-2.5-flash", saved.getOcrModel());
    org.junit.jupiter.api.Assertions.assertEquals("openrouter", saved.getTlProvider());
    org.junit.jupiter.api.Assertions.assertEquals("deepseek/deepseek-v4-flash", saved.getTlModel());
    org.junit.jupiter.api.Assertions.assertEquals("openrouter", saved.getQaProvider());
    org.junit.jupiter.api.Assertions.assertEquals("tencent/hy3:free", saved.getQaLlmModel());
    org.junit.jupiter.api.Assertions.assertEquals("google/gemini-2.5-flash", saved.getQaVlmModel());
    org.junit.jupiter.api.Assertions.assertEquals("hybrid", saved.getQaMode());
    org.junit.jupiter.api.Assertions.assertEquals("lowest-cost", saved.getRoutingStrategy());
    org.junit.jupiter.api.Assertions.assertEquals(Boolean.FALSE, saved.getUseFallbackModels());
  }

  @Test
  public void testCreateSeries_NullUseFallbackModels_Inherits() throws Exception {
    // When useFallbackModels is not sent, it should be stored as null (inherit from global)
    Series series = new Series() {{ setId(UUID.randomUUID()); setTitle("Inherit Series"); }};
    when(seriesRepository.save(any(Series.class))).thenReturn(series);

    String json =
        "{\"title\":\"Inherit Series\",\"originalLanguage\":\"ja\",\"targetLanguage\":\"en\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/series")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isOk());

    org.mockito.ArgumentCaptor<Series> savedCaptor =
        org.mockito.ArgumentCaptor.forClass(Series.class);
    verify(seriesRepository).save(savedCaptor.capture());
    Series saved = savedCaptor.getValue();

    // null means inherit — NOT forced to true
    org.junit.jupiter.api.Assertions.assertNull(saved.getUseFallbackModels());
  }

  @Test
  public void testUpdateSeries_Success() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = new Series() {{ setId(seriesId); setTitle("Old Series"); }};
    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));
    when(seriesRepository.save(any(Series.class))).thenReturn(series);

    String json =
        "{\"title\":\"Updated Series\",\"originalLanguage\":\"ja\",\"targetLanguage\":\"en\",\"routingStrategy\":\"highest-throughput\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/series/" + seriesId)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isOk());

    org.mockito.ArgumentCaptor<Series> savedSeriesCaptor =
        org.mockito.ArgumentCaptor.forClass(Series.class);
    verify(seriesRepository).save(savedSeriesCaptor.capture());
    org.junit.jupiter.api.Assertions.assertEquals(
        "highest-throughput", savedSeriesCaptor.getValue().getRoutingStrategy());
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
    Series series = new Series() {{ setId(seriesId); setTitle("Test Series"); }};
    com.manga.library.model.Chapter chapter =
        new com.manga.library.model.Chapter() {{ setId(UUID.randomUUID()); setChapterNumber(1.0); setTitle("Ch 1"); setSeries(series); }};

    when(seriesRepository.findById(seriesId)).thenReturn(Optional.of(series));
    when(chapterRepository.save(any(com.manga.library.model.Chapter.class))).thenReturn(chapter);

    String json =
        "{\"chapterNumber\":1.0,\"title\":\"Ch 1\",\"routingStrategy\":\"highest-throughput\"}";
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(
                    "/api/series/" + seriesId + "/chapters")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isOk());

    verify(chapterRepository)
        .save(argThat(saved -> "highest-throughput".equals(saved.getRoutingStrategy())));
  }

  @Test
  public void testUpdateChapter_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID seriesId = UUID.randomUUID();
    Series series = new Series() {{ setId(seriesId); }};
    com.manga.library.model.Chapter chapter =
        new com.manga.library.model.Chapter() {{ setId(chapterId); setSeries(series); setChapterNumber(1.0); setTitle("Old Title"); }};

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
    UUID coverId = UUID.randomUUID();
    Series series = new Series() {{ setId(UUID.randomUUID()); }};
    com.manga.library.model.Chapter chapter =
        new com.manga.library.model.Chapter() {{ setId(chapterId); setSeries(series); setCoverImageId(coverId); }};
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));

    mockMvc
        .perform(get("/api/series/chapters/" + chapterId))
        .andExpect(status().isOk())
        .andExpect(
            org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath(
                    "$.coverImageUrl")
                .value(
                    org.hamcrest.Matchers.containsString("/api/images/" + coverId + "/thumbnail")));
  }

  @Test
  public void testDeleteChapter_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    com.manga.library.model.Chapter chapter =
        new com.manga.library.model.Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series() {{ setId(UUID.randomUUID()); }}); }};

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
    Series series = new Series() {{ setId(seriesId); setTitle("Test Series"); }};
    com.manga.library.model.Chapter chapter =
        new com.manga.library.model.Chapter() {{ setId(UUID.randomUUID()); setChapterNumber(1.0); setTitle("Ch 1"); setSeries(series); }};

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
        new com.manga.library.model.Image() {{ setId(UUID.randomUUID()); }};
    com.manga.library.model.Page page =
        new com.manga.library.model.Page() {{ setId(UUID.randomUUID()); setImage(image); }};
    when(pageService.createPageAndImage(any(), any(), any(), any(), any(), any(), any()))
        .thenReturn(page);
    doNothing().when(pageService).generateAndSaveThumbnailAsync(any(), any(), any());
    when(minioService.uploadFile(anyString(), any(), anyString())).thenReturn("path/to/file.png");
    doNothing().when(jobCoordinatorService).startPipeline(any(), any());
    when(systemSettingsService.getSettings()).thenReturn(null);

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
        new com.manga.library.model.Chapter() {{ setId(chapterId); setChapterNumber(1.0); setTitle("Ch 1"); }};
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));

    com.manga.library.model.Image img =
        new com.manga.library.model.Image() {{ setId(UUID.randomUUID()); setFilename("page1.png"); setStoragePath("orig/page1.png"); }};
    com.manga.library.model.Page page =
        new com.manga.library.model.Page() {{ setId(UUID.randomUUID()); setPageNumber(1); setImage(img); }};

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.List.of(page));
    when(minioService.downloadFile(anyString()))
        .thenReturn(new java.io.ByteArrayInputStream("dummy".getBytes()));

    com.manga.library.model.Layer activeLayer =
        new com.manga.library.model.Layer() {{ setId(UUID.randomUUID()); setType("translation"); setVisible(true); }};
    when(layerRepository.findByPageId(any())).thenReturn(java.util.List.of(activeLayer));

    when(layerElementRepository.findByLayerId(any())).thenReturn(java.util.Collections.emptyList());

    mockMvc
        .perform(get("/api/series/chapters/" + chapterId + "/export").param("format", "zip"))
        .andExpect(status().isAccepted());
  }

  @Test
  public void testExportChapter_NoPages() throws Exception {
    UUID chapterId = UUID.randomUUID();
    com.manga.library.model.Chapter chapter =
        new com.manga.library.model.Chapter() {{ setId(chapterId); }};
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
    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(
                    "/api/series/" + seriesId + "/chapters")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(json))
        .andExpect(status().isNotFound());
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

    mockMvc
        .perform(get("/api/series/chapters/" + chapterId + "/export").param("format", "zip"))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testCreateChapter_Conflict() throws Exception {
    UUID seriesId = UUID.randomUUID();
    Series series = new Series() {{ setId(seriesId); setTitle("Test Series"); }};
    com.manga.library.model.Chapter chapter =
        new com.manga.library.model.Chapter() {{ setId(UUID.randomUUID()); setChapterNumber(1.0); setTitle("Ch 1"); setSeries(series); }};

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
    Series series = new Series() {{ setId(seriesId); }};
    com.manga.library.model.Chapter chapter =
        new com.manga.library.model.Chapter() {{ setId(chapterId); setSeries(series); setChapterNumber(1.0); setTitle("Old Title"); }};

    com.manga.library.model.Chapter existingChapter =
        new com.manga.library.model.Chapter() {{ setId(UUID.randomUUID()); setSeries(series); setChapterNumber(2.0); setTitle("Existing Title"); }};

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
    Series series = new Series() {{ setId(seriesId); setTitle("Test Series"); }};
    com.manga.library.model.Chapter existingChapter =
        new com.manga.library.model.Chapter() {{ setId(UUID.randomUUID()); setSeries(series); setChapterNumber(1.0); setTitle("Existing"); }};

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
    Series series = new Series() {{ setId(seriesId); setTitle("Test Series"); }};

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
        new com.manga.library.model.Chapter() {{ setId(UUID.randomUUID()); setChapterNumber(1.0); setTitle("Ch 1"); setSeries(series); }};
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
        new com.manga.library.model.Chapter() {{ setId(chapterId); setChapterNumber(1.0); setTitle("Ch 1"); }};
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));

    com.manga.library.model.Image img =
        new com.manga.library.model.Image() {{ setId(UUID.randomUUID()); setFilename("page1.png"); setStoragePath("orig/page1.png"); }};
    com.manga.library.model.Page page =
        new com.manga.library.model.Page() {{ setId(UUID.randomUUID()); setPageNumber(1); setImage(img); }};

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
        new com.manga.library.model.Layer() {{ setId(UUID.randomUUID()); setType("translation"); setVisible(true); setMetadataJson(metadata); }};

    when(layerRepository.findByPageId(any())).thenReturn(java.util.List.of(activeLayer));

    when(layerElementRepository.findByLayerId(any())).thenReturn(java.util.Collections.emptyList());

    mockMvc
        .perform(get("/api/series/chapters/" + chapterId + "/export").param("format", "zip"))
        .andExpect(status().isAccepted());
  }

  @Test
  public void testDeleteChapterCoverRecalculation() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID seriesId = UUID.randomUUID();
    com.manga.library.model.Series series = new com.manga.library.model.Series();
    series.setId(seriesId);
    com.manga.library.model.Chapter chapter = new com.manga.library.model.Chapter();
    chapter.setId(chapterId);
    chapter.setSeries(series);

    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    doNothing().when(chapterRepository).delete(chapter);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete(
                "/api/series/chapters/" + chapterId))
        .andExpect(status().isOk());

    verify(pageService, times(1)).recalculateSeriesCover(seriesId);
  }

  @Test
  public void testUpdateChapterCoverRecalculation() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID seriesId = UUID.randomUUID();
    com.manga.library.model.Series series = new com.manga.library.model.Series();
    series.setId(seriesId);
    com.manga.library.model.Chapter chapter = new com.manga.library.model.Chapter();
    chapter.setId(chapterId);
    chapter.setSeries(series);
    chapter.setChapterNumber(2.0);

    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    when(chapterRepository.save(any(com.manga.library.model.Chapter.class))).thenReturn(chapter);

    String payload = "{\"chapterNumber\": 1.0}";

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/series/chapters/" + chapterId)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(payload))
        .andExpect(status().isOk());

    verify(pageService, times(1)).recalculateSeriesCover(seriesId);
  }
}
