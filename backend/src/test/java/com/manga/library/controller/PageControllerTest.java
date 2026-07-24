package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
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
@SuppressWarnings("null")
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

    Image image = new Image() {{ setId(imageId); setFilename("test.png"); }};
    Chapter chapter = new Chapter() {{ setId(chapterId); }};
    Page page = new Page() {{ setId(pageId); setPageNumber(1); setImage(image); setChapter(chapter); }};

    when(pageRepository.findById(pageId)).thenReturn(Optional.of(page));

    mockMvc
        .perform(get("/api/pages/" + pageId))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.page.id").value(pageId.toString()))
        .andExpect(jsonPath("$.page.pageNumber").value(1))
        .andExpect(jsonPath("$.page.imageId").value(imageId.toString()))
        .andExpect(jsonPath("$.page.chapterId").value(chapterId.toString()));
  }

  @Test
  public void testGetPage_NotFound_Returns404WithMessage() throws Exception {
    UUID pageId = UUID.randomUUID();
    when(pageRepository.findById(pageId)).thenReturn(Optional.empty());

    mockMvc
        .perform(get("/api/pages/" + pageId))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.status").value(404))
        .andExpect(jsonPath("$.detail").value("Page not found: " + pageId));
  }

  @Test
  public void testListPages_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID pageId = UUID.randomUUID();
    UUID imageId = UUID.randomUUID();

    Image image = new Image() {{ setId(imageId); setFilename("test.png"); }};
    Chapter chapter = new Chapter() {{ setId(chapterId); }};
    Page page = new Page() {{ setId(pageId); setPageNumber(1); setImage(image); setChapter(chapter); }};

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(Collections.singletonList(page));

    mockMvc
        .perform(get("/api/chapters/" + chapterId + "/pages"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].id").value(pageId.toString()))
        .andExpect(jsonPath("$[0].pageNumber").value(1));
  }

  @Test
  public void testDeletePage_Success() throws Exception {
    UUID pageId = UUID.randomUUID();
    when(pageService.deletePageDb(pageId)).thenReturn(java.util.Collections.emptyList());

    mockMvc.perform(delete("/api/pages/" + pageId)).andExpect(status().isOk());

    verify(pageService, times(1)).deletePageDb(pageId);
  }

  @Test
  public void testReorderPages_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID p1 = UUID.randomUUID();
    UUID p2 = UUID.randomUUID();

    Page page1 = new Page() {{ setId(p1); setPageNumber(1); }};
    Page page2 = new Page() {{ setId(p2); setPageNumber(2); }};

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.Arrays.asList(page1, page2));

    mockMvc
        .perform(
            put("/api/chapters/" + chapterId + "/pages/reorder")
                .contentType(MediaType.APPLICATION_JSON)
                .content("[\"" + p1 + "\", \"" + p2 + "\"]"))
        .andExpect(status().isOk());

    verify(pageRepository, atLeastOnce()).save(any(Page.class));
  }

  @Test
  public void testGetImageDetails_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    Image image = new Image() {{ setId(imageId); setFilename("test.png"); }};

    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));
    when(panelRepository.findByImageId(imageId)).thenReturn(Collections.emptyList());
    when(ocrRegionRepository.findByPageId(any())).thenReturn(Collections.emptyList());
    when(conversationRepository.findByPageId(any())).thenReturn(Collections.emptyList());

    mockMvc
        .perform(get("/api/images/" + imageId))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.image.id").value(imageId.toString()));
  }

  @Test
  public void testRedoOcrRegion_Success() throws Exception {
    UUID id = UUID.randomUUID();

    doNothing().when(jobCoordinatorService).triggerRedo(id, "translation");

    mockMvc
        .perform(post("/api/ocr-regions/" + id + "/redo").param("type", "translation"))
        .andExpect(status().isOk());

    verify(jobCoordinatorService, times(1)).triggerRedo(id, "translation");
  }

  @Test
  public void testGetImageFile_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    Image image =
        new Image() {{ setId(imageId); setFilename("test.png"); setStoragePath("path/test.png"); }};
    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));
    when(minioService.getFileStream(anyString()))
        .thenReturn(new java.io.ByteArrayInputStream("dummy".getBytes()));

    mockMvc.perform(get("/api/images/" + imageId + "/file")).andExpect(status().isOk());
  }

  @Test
  public void testGetImageThumbnail_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    Image image =
        new Image() {{ setId(imageId); setFilename("test.png"); setThumbnailStoragePath("path/thumb.jpg"); }};
    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));
    when(minioService.getFileStream(anyString()))
        .thenReturn(new java.io.ByteArrayInputStream("dummy".getBytes()));

    mockMvc.perform(get("/api/images/" + imageId + "/thumbnail")).andExpect(status().isOk());
  }

  @Test
  public void testUploadPage_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series()); }};
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".png");

    Image image = new Image() {{ setId(UUID.randomUUID()); }};
    Page page = new Page() {{ setId(UUID.randomUUID()); setImage(image); }};

    when(pageService.createPageAndImage(any(), any(), any(), any(), any(), any(), any()))
        .thenReturn(page);

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file",
            "test.png",
            "image/png",
            new byte[] {
              (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0
            });

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isOk());
  }

  @Test
  public void testUploadPage_ZipImport() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series()); }};
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".zip");

    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos);
    zos.putNextEntry(new java.util.zip.ZipEntry("page1.png"));
    zos.write(
        new byte[] {(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0});
    zos.closeEntry();
    zos.finish();

    Image image = new Image() {{ setId(UUID.randomUUID()); }};
    Page page = new Page() {{ setId(UUID.randomUUID()); setImage(image); }};

    when(pageService.createPageAndImage(any(), any(), any(), any(), any(), any(), any()))
        .thenReturn(page);

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.zip", "application/zip", baos.toByteArray());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isOk());
  }

  @Test
  public void testUploadPage_ZipProjectImport() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series()); }};
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".zip");

    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos);
    zos.putNextEntry(new java.util.zip.ZipEntry("page1.png"));
    zos.write(
        new byte[] {(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0});
    zos.closeEntry();

    zos.putNextEntry(new java.util.zip.ZipEntry("project.json"));
    zos.write(
        "{\"layers\":[{\"type\":\"translation\",\"elements\":[{\"text\":\"hello\"}]}]}".getBytes());
    zos.closeEntry();
    zos.finish();

    Image image = new Image() {{ setId(UUID.randomUUID()); }};
    Page page = new Page() {{ setId(UUID.randomUUID()); setImage(image); setPageNumber(1); }};

    when(pageService.createPageAndImage(any(), any(), any(), any(), any(), any(), any()))
        .thenReturn(page);
    when(pageRepository.findByChapterIdAndPageNumber(any(), any())).thenReturn(Optional.of(page));
    when(imageRepository.save(any(Image.class))).thenReturn(image);
    when(pageRepository.save(any(Page.class))).thenReturn(page);
    when(layerRepository.save(any(com.manga.library.model.Layer.class)))
        .thenReturn(new com.manga.library.model.Layer());
    when(layerElementRepository.save(any(com.manga.library.model.LayerElement.class)))
        .thenReturn(new com.manga.library.model.LayerElement());

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.zip", "application/zip", baos.toByteArray());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isOk());
  }

  @Test
  public void testImportProject_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series()); }};
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".png");

    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos);
    zos.putNextEntry(new java.util.zip.ZipEntry("original.png"));
    zos.write(
        new byte[] {(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0});
    zos.closeEntry();

    zos.putNextEntry(new java.util.zip.ZipEntry("project.json"));
    zos.write(
        "{\"layers\":[{\"type\":\"translation\",\"elements\":[{\"text\":\"hello\"}]}]}".getBytes());
    zos.closeEntry();
    zos.finish();

    Image image = new Image() {{ setId(UUID.randomUUID()); }};
    Page page = new Page() {{ setId(UUID.randomUUID()); setImage(image); setPageNumber(1); }};

    when(pageService.createPageAndImage(any(), any(), any(), any(), any(), any(), any()))
        .thenReturn(page);
    when(pageRepository.findByChapterIdAndPageNumber(any(), any())).thenReturn(Optional.of(page));
    when(imageRepository.save(any(Image.class))).thenReturn(image);
    when(pageRepository.save(any(Page.class))).thenReturn(page);
    when(layerRepository.save(any(com.manga.library.model.Layer.class)))
        .thenReturn(new com.manga.library.model.Layer());
    when(layerElementRepository.save(any(com.manga.library.model.LayerElement.class)))
        .thenReturn(new com.manga.library.model.LayerElement());

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.zip", "application/zip", baos.toByteArray());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/chapters/" + chapterId + "/import-project")
                .file(file))
        .andExpect(status().isOk());
  }

  @Test
  public void testUpdateOcrRegion_Success() throws Exception {
    UUID regionId = UUID.randomUUID();
    com.manga.library.model.OcrRegion region =
        new com.manga.library.model.OcrRegion() {{ setId(regionId); }};
    when(ocrRegionRepository.findById(regionId)).thenReturn(Optional.of(region));
    when(ocrRegionRepository.save(any(com.manga.library.model.OcrRegion.class))).thenReturn(region);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch(
                    "/api/ocr-regions/" + regionId)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content("{\"text\":\"new text\"}"))
        .andExpect(status().isOk());
  }

  @Test
  public void testImageRedo_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    doNothing().when(jobCoordinatorService).triggerImageRedo(imageId, "ocr");

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post(
                    "/api/images/" + imageId + "/redo")
                .param("type", "ocr"))
        .andExpect(status().isOk());
  }

  @Test
  public void testUploadPage_DuplicateImage() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series()); }};
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".png");

    UUID existingImageId = UUID.randomUUID();
    Image existingImage = new Image() {{ setId(existingImageId); setHash("somehash"); }};
    when(imageRepository.findByHash(anyString())).thenReturn(Optional.of(existingImage));

    Page page = new Page() {{ setId(UUID.randomUUID()); setImage(existingImage); }};
    when(pageService.createPageWithExistingImage(any(), any(), any(), any())).thenReturn(page);

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file",
            "test.png",
            "image/png",
            new byte[] {
              (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0
            });

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("duplicate"));
  }

  @Test
  public void testDeletePage_Failure() throws Exception {
    UUID pageId = UUID.randomUUID();
    when(pageService.deletePageDb(pageId)).thenThrow(new RuntimeException("database error"));

    mockMvc.perform(delete("/api/pages/" + pageId)).andExpect(status().isInternalServerError());
  }

  @Test
  public void testGetImageFile_NotFound() throws Exception {
    UUID imageId = UUID.randomUUID();
    when(imageRepository.findById(imageId)).thenReturn(Optional.empty());

    mockMvc.perform(get("/api/images/" + imageId + "/file")).andExpect(status().isNotFound());
  }

  @Test
  public void testGetImageThumbnail_NotFound() throws Exception {
    UUID imageId = UUID.randomUUID();
    when(imageRepository.findById(imageId)).thenReturn(Optional.empty());

    mockMvc.perform(get("/api/images/" + imageId + "/thumbnail")).andExpect(status().isNotFound());
  }

  @Test
  public void testUploadPage_Failure() throws Exception {
    UUID chapterId = UUID.randomUUID();
    when(chapterRepository.findWithSeriesById(chapterId))
        .thenThrow(new RuntimeException("db error"));

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file",
            "test.png",
            "image/png",
            new byte[] {
              (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0
            });

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testGetImageDetails_Failure() throws Exception {
    UUID imageId = UUID.randomUUID();
    when(imageRepository.findById(imageId)).thenReturn(Optional.empty());

    mockMvc.perform(get("/api/images/" + imageId)).andExpect(status().isNotFound());
  }

  @Test
  public void testUploadPage_DuplicateImage_MissingTranslation() throws Exception {
    UUID chapterId = UUID.randomUUID();
    com.manga.library.model.Series series =
        new com.manga.library.model.Series() {{ setId(UUID.randomUUID()); setTargetLanguage("en"); }};
    Chapter chapter = new Chapter() {{ setId(chapterId); setSeries(series); }};
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".png");

    UUID existingImageId = UUID.randomUUID();
    Image existingImage = new Image() {{ setId(existingImageId); setHash("somehash"); }};
    when(imageRepository.findByHash(anyString())).thenReturn(Optional.of(existingImage));

    when(layerRepository.findByPageId(any())).thenReturn(Collections.emptyList());

    Page page = new Page() {{ setId(UUID.randomUUID()); setImage(existingImage); }};
    when(pageService.createPageWithExistingImage(any(), any(), any(), any())).thenReturn(page);

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file",
            "test.png",
            "image/png",
            new byte[] {
              (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0
            });

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.status").value("duplicate"));

    verify(jobCoordinatorService, times(1)).triggerPageRedo(page.getId(), "translation", chapterId);
  }

  @Test
  public void testUploadPage_ZipNoImages() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series()); }};
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".zip");

    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos);
    zos.finish();

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.zip", "application/zip", baos.toByteArray());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isBadRequest());
  }

  @Test
  public void testUploadPage_ZipProjectNoImages() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series()); }};
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".zip");

    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos);
    zos.putNextEntry(new java.util.zip.ZipEntry("project.json"));
    zos.write("{}".getBytes());
    zos.closeEntry();
    zos.finish();

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.zip", "application/zip", baos.toByteArray());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isBadRequest());
  }

  @Test
  public void testReorderPages_InvalidIds() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID p1 = UUID.randomUUID();

    Page page1 = new Page() {{ setId(p1); setPageNumber(1); }};

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.Collections.singletonList(page1));

    mockMvc
        .perform(
            put("/api/chapters/" + chapterId + "/pages/reorder")
                .contentType(MediaType.APPLICATION_JSON)
                .content("[]"))
        .andExpect(status().isBadRequest());
  }

  @Test
  public void testReorderPages_Exception() throws Exception {
    UUID chapterId = UUID.randomUUID();
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenThrow(new RuntimeException("database failure"));

    mockMvc
        .perform(
            put("/api/chapters/" + chapterId + "/pages/reorder")
                .contentType(MediaType.APPLICATION_JSON)
                .content("[]"))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testDeletePage_Exception() throws Exception {
    UUID pageId = UUID.randomUUID();
    when(pageService.deletePageDb(pageId)).thenThrow(new RuntimeException("deletion failed"));

    mockMvc.perform(delete("/api/pages/" + pageId)).andExpect(status().isInternalServerError());
  }

  @Test
  public void testUpdateOcrRegion_Success_FullPayload() throws Exception {
    UUID id = UUID.randomUUID();
    com.manga.library.model.OcrRegion region =
        new com.manga.library.model.OcrRegion() {{ setId(id); setText("original text"); setConfidence(0.8); }};

    when(ocrRegionRepository.findById(id)).thenReturn(Optional.of(region));
    when(ocrRegionRepository.save(any(com.manga.library.model.OcrRegion.class))).thenReturn(region);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch(
                    "/api/ocr-regions/" + id)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"text\":\"updated text\",\"translatedText\":\"Hello\",\"approved\":true,\"confidence\":0.95}"))
        .andExpect(status().isOk());
  }

  @Test
  public void testUpdateOcrRegion_NotFound() throws Exception {
    UUID id = UUID.randomUUID();
    when(ocrRegionRepository.findById(id)).thenReturn(Optional.empty());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch(
                    "/api/ocr-regions/" + id)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\":\"updated text\"}"))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testUploadPage_WithMarkdownFile_ReturnsBadRequest() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series()); }};
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".md");

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.md", "text/markdown", "# Markdown Data".getBytes());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isBadRequest())
        .andExpect(
            jsonPath("$.status")
                .value("Invalid file type. Accepted formats: PNG, JPEG, WebP, BMP"));
  }

  @Test
  public void testUploadPage_WithBmpFile_ReturnsOkAndConverts() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {{ setId(chapterId); setSeries(new com.manga.library.model.Series()); }};
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".bmp");

    // Create a 1x1 valid BMP in memory
    java.awt.image.BufferedImage img =
        new java.awt.image.BufferedImage(1, 1, java.awt.image.BufferedImage.TYPE_INT_RGB);
    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    javax.imageio.ImageIO.write(img, "bmp", baos);
    byte[] bmpBytes = baos.toByteArray();

    Page page =
        new Page() {{ setId(UUID.randomUUID()); setImage(new Image() {{ setId(UUID.randomUUID()); }}); }};
    when(pageService.createPageAndImage(any(), any(), any(), any(), any(), any(), any()))
        .thenReturn(page);

    org.springframework.mock.web.MockMultipartFile file =
        new org.springframework.mock.web.MockMultipartFile(
            "file", "test.bmp", "image/bmp", bmpBytes);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart(
                    "/api/images")
                .file(file)
                .param("chapterId", chapterId.toString())
                .param("pageNumber", "1"))
        .andExpect(status().isOk());
  }

  @Test
  public void testReorderPagesCoverRecalculation() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID pageId1 = UUID.randomUUID();
    UUID pageId2 = UUID.randomUUID();

    Page page1 = new Page();
    page1.setId(pageId1);
    page1.setPageNumber(1);

    Page page2 = new Page();
    page2.setId(pageId2);
    page2.setPageNumber(2);

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.List.of(page1, page2));

    String payload = "[\"" + pageId2.toString() + "\", \"" + pageId1.toString() + "\"]";

    mockMvc
        .perform(
            put("/api/chapters/" + chapterId + "/pages/reorder")
                .contentType(MediaType.APPLICATION_JSON)
                .content(payload))
        .andExpect(status().isOk());

    verify(pageService, times(1)).recalculateChapterCover(chapterId);
  }
}
