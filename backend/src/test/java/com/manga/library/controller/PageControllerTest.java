package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.hamcrest.Matchers.endsWith;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
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
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(PageController.class)
@AutoConfigureMockMvc(addFilters = false)
@SuppressWarnings("null")
public class PageControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockitoBean private SeriesRepository seriesRepository;
  @MockitoBean private ChapterRepository chapterRepository;
  @MockitoBean private ImageRepository imageRepository;
  @MockitoBean private PageRepository pageRepository;
  @MockitoBean private PanelRepository panelRepository;
  @MockitoBean private OcrRegionRepository ocrRegionRepository;
  @MockitoBean private LayerRepository layerRepository;
  @MockitoBean private LayerElementRepository layerElementRepository;
  @MockitoBean private MinioService minioService;
  @MockitoBean private JobCoordinatorService jobCoordinatorService;
  @MockitoBean private PageService pageService;
  @MockitoBean private ConversationRepository conversationRepository;
  @MockitoBean private ConversationRegionRepository conversationRegionRepository;
  @MockitoBean private SseService sseService;
  @MockitoBean private LayerEditHistoryRepository layerEditHistoryRepository;
  @MockitoBean private JwtAuthFilter jwtAuthFilter;
  @MockitoBean private com.manga.library.config.SseTicketAuthFilter sseTicketAuthFilter;

  @Test
  public void testGetPage_Success() throws Exception {
    UUID pageId = UUID.randomUUID();
    UUID imageId = UUID.randomUUID();
    UUID chapterId = UUID.randomUUID();

    Image image =
        new Image() {
          {
            setId(imageId);
            setFilename("test.png");
          }
        };
    Chapter chapter =
        new Chapter() {
          {
            setId(chapterId);
          }
        };
    Page page =
        new Page() {
          {
            setId(pageId);
            setPageNumber(1);
            setImage(image);
            setChapter(chapter);
          }
        };

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

  private static Page pageFixture(UUID pageId, int pageNumber, UUID imageId, UUID chapterId) {
    Image image =
        new Image() {
          {
            setId(imageId);
            setFilename("test.png");
          }
        };
    Chapter chapter =
        new Chapter() {
          {
            setId(chapterId);
          }
        };
    return new Page() {
      {
        setId(pageId);
        setPageNumber(pageNumber);
        setImage(image);
        setChapter(chapter);
      }
    };
  }

  @Test
  public void testListPages_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID pageId = UUID.randomUUID();
    UUID imageId = UUID.randomUUID();

    Page page = pageFixture(pageId, 1, imageId, chapterId);

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(
            eq(chapterId), any(org.springframework.data.domain.Pageable.class)))
        .thenReturn(
            new org.springframework.data.domain.PageImpl<>(
                Collections.singletonList(page),
                org.springframework.data.domain.PageRequest.of(0, 25),
                1));

    mockMvc
        .perform(get("/api/chapters/" + chapterId + "/pages"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.content[0].id").value(pageId.toString()))
        .andExpect(jsonPath("$.content[0].pageNumber").value(1))
        .andExpect(
            jsonPath("$.content[0].thumbnailUrl")
                .value(endsWith("/api/images/" + imageId + "/thumbnail")))
        .andExpect(jsonPath("$.page").value(0))
        .andExpect(jsonPath("$.size").value(25))
        .andExpect(jsonPath("$.totalElements").value(1))
        .andExpect(jsonPath("$.totalPages").value(1));
  }

  @Test
  public void testListPages_DefaultSizeIsTwentyFive() throws Exception {
    UUID chapterId = UUID.randomUUID();
    org.mockito.ArgumentCaptor<org.springframework.data.domain.Pageable> captor =
        org.mockito.ArgumentCaptor.forClass(org.springframework.data.domain.Pageable.class);

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(eq(chapterId), captor.capture()))
        .thenReturn(
            new org.springframework.data.domain.PageImpl<>(
                Collections.emptyList(),
                org.springframework.data.domain.PageRequest.of(0, 25),
                0));

    mockMvc
        .perform(get("/api/chapters/" + chapterId + "/pages"))
        .andExpect(status().isOk());

    org.junit.jupiter.api.Assertions.assertEquals(25, captor.getValue().getPageSize());
    org.junit.jupiter.api.Assertions.assertEquals(0, captor.getValue().getPageNumber());
  }

  /**
   * AUDIT-B11. {@code @PageableDefault(size = 25)} sets only the default — a caller passing
   * {@code ?size=2000} overrode it and got Spring's own ceiling of 2000, which is the unbounded
   * list response AUDIT-F8 existed to remove, one query parameter away.
   *
   * <p>Unlike the sort question in AUDIT-B10, a {@code @WebMvcTest} really can prove this one:
   * {@code spring.data.web.pageable.max-page-size} is applied by {@code
   * PageableHandlerMethodArgumentResolver} before the controller runs, so the cap is visible in
   * the {@code Pageable} the (mocked) repository is handed. Nothing here depends on what Spring
   * Data would do with it.
   */
  @Test
  public void testListPages_SizeIsCappedAtTheConfiguredMaximum() throws Exception {
    UUID chapterId = UUID.randomUUID();
    org.mockito.ArgumentCaptor<org.springframework.data.domain.Pageable> captor =
        org.mockito.ArgumentCaptor.forClass(org.springframework.data.domain.Pageable.class);

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(eq(chapterId), captor.capture()))
        .thenReturn(
            new org.springframework.data.domain.PageImpl<>(
                Collections.emptyList(),
                org.springframework.data.domain.PageRequest.of(0, 100),
                0));

    mockMvc
        .perform(get("/api/chapters/" + chapterId + "/pages").param("size", "2000"))
        .andExpect(status().isOk());

    org.junit.jupiter.api.Assertions.assertEquals(100, captor.getValue().getPageSize());
  }

  /** AUDIT-B11: a size below the ceiling is still honoured — the cap clamps, it doesn't pin. */
  @Test
  public void testListPages_SizeBelowTheCeilingIsHonoured() throws Exception {
    UUID chapterId = UUID.randomUUID();
    org.mockito.ArgumentCaptor<org.springframework.data.domain.Pageable> captor =
        org.mockito.ArgumentCaptor.forClass(org.springframework.data.domain.Pageable.class);

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(eq(chapterId), captor.capture()))
        .thenReturn(
            new org.springframework.data.domain.PageImpl<>(
                Collections.emptyList(),
                org.springframework.data.domain.PageRequest.of(0, 50),
                0));

    mockMvc
        .perform(get("/api/chapters/" + chapterId + "/pages").param("size", "50"))
        .andExpect(status().isOk());

    org.junit.jupiter.api.Assertions.assertEquals(50, captor.getValue().getPageSize());
  }

  @Test
  public void testListPages_BoundaryPage_PartialFinalPage() throws Exception {
    UUID chapterId = UUID.randomUUID();
    UUID imageId = UUID.randomUUID();

    // 30 total pages at size 25 -> page 1 (0-indexed) holds the trailing 5 (26..30). Spring's
    // PageImpl recomputes totalElements from offset + content.size() whenever the passed total
    // looks inconsistent with the page, so the content list has to actually hold all 5 for the
    // total to round-trip as 30 rather than being silently corrected down to 26.
    List<Page> trailingFive = new ArrayList<>();
    for (int pageNumber = 26; pageNumber <= 30; pageNumber++) {
      trailingFive.add(pageFixture(UUID.randomUUID(), pageNumber, imageId, chapterId));
    }

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(
            eq(chapterId), any(org.springframework.data.domain.Pageable.class)))
        .thenReturn(
            new org.springframework.data.domain.PageImpl<>(
                trailingFive,
                org.springframework.data.domain.PageRequest.of(1, 25),
                30));

    mockMvc
        .perform(get("/api/chapters/" + chapterId + "/pages").param("page", "1"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.content.length()").value(5))
        .andExpect(jsonPath("$.content[0].pageNumber").value(26))
        .andExpect(jsonPath("$.page").value(1))
        .andExpect(jsonPath("$.totalElements").value(30))
        .andExpect(jsonPath("$.totalPages").value(2));
  }

  @Test
  public void testListPages_EmptyResult() throws Exception {
    UUID chapterId = UUID.randomUUID();

    when(pageRepository.findByChapterIdOrderByPageNumberAsc(
            eq(chapterId), any(org.springframework.data.domain.Pageable.class)))
        .thenReturn(
            new org.springframework.data.domain.PageImpl<>(
                Collections.emptyList(),
                org.springframework.data.domain.PageRequest.of(0, 25),
                0));

    mockMvc
        .perform(get("/api/chapters/" + chapterId + "/pages"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.content").isEmpty())
        .andExpect(jsonPath("$.totalElements").value(0))
        .andExpect(jsonPath("$.totalPages").value(0));
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

    Page page1 =
        new Page() {
          {
            setId(p1);
            setPageNumber(1);
          }
        };
    Page page2 =
        new Page() {
          {
            setId(p2);
            setPageNumber(2);
          }
        };

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
    Image image =
        new Image() {
          {
            setId(imageId);
            setFilename("test.png");
          }
        };

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
        new Image() {
          {
            setId(imageId);
            setFilename("test.png");
            setStoragePath("path/test.png");
          }
        };
    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));
    when(minioService.getFileStream(anyString()))
        .thenReturn(new java.io.ByteArrayInputStream("dummy".getBytes()));

    mockMvc
        .perform(get("/api/images/" + imageId + "/file"))
        .andExpect(status().isOk())
        .andExpect(content().contentType("image/png"));
  }

  @Test
  public void testGetImageFile_WebpContentType() throws Exception {
    UUID imageId = UUID.randomUUID();
    Image image =
        new Image() {
          {
            setId(imageId);
            setFilename("test.webp");
            setStoragePath("path/test.webp");
          }
        };
    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));
    when(minioService.getFileStream(anyString()))
        .thenReturn(new java.io.ByteArrayInputStream("dummy".getBytes()));

    mockMvc
        .perform(get("/api/images/" + imageId + "/file"))
        .andExpect(status().isOk())
        .andExpect(content().contentType("image/webp"));
  }

  @Test
  public void testGetImageThumbnail_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    Image image =
        new Image() {
          {
            setId(imageId);
            setFilename("test.png");
            setThumbnailStoragePath("path/thumb.webp");
          }
        };
    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));
    when(minioService.getFileStream(anyString()))
        .thenReturn(new java.io.ByteArrayInputStream("dummy".getBytes()));

    mockMvc
        .perform(get("/api/images/" + imageId + "/thumbnail"))
        .andExpect(status().isOk())
        .andExpect(content().contentType("image/webp"));
  }

  @Test
  public void testGetImageThumbnail_MissingThumbnailDoesNotStreamOriginal() throws Exception {
    UUID imageId = UUID.randomUUID();
    Image image =
        new Image() {
          {
            setId(imageId);
            setStoragePath("path/original.png");
          }
        };
    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));

    mockMvc
        .perform(get("/api/images/" + imageId + "/thumbnail"))
        .andExpect(status().isNotFound());

    verify(minioService, never()).getFileStream(anyString());
  }

  @Test
  public void testUploadPage_Success() throws Exception {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter =
        new Chapter() {
          {
            setId(chapterId);
            setSeries(new com.manga.library.model.Series());
          }
        };
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".png");

    Image image =
        new Image() {
          {
            setId(UUID.randomUUID());
          }
        };
    Page page =
        new Page() {
          {
            setId(UUID.randomUUID());
            setImage(image);
          }
        };

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
        new Chapter() {
          {
            setId(chapterId);
            setSeries(new com.manga.library.model.Series());
          }
        };
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".zip");

    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos);
    zos.putNextEntry(new java.util.zip.ZipEntry("page1.png"));
    zos.write(
        new byte[] {(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0});
    zos.closeEntry();
    zos.finish();

    Image image =
        new Image() {
          {
            setId(UUID.randomUUID());
          }
        };
    Page page =
        new Page() {
          {
            setId(UUID.randomUUID());
            setImage(image);
          }
        };

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
        new Chapter() {
          {
            setId(chapterId);
            setSeries(new com.manga.library.model.Series());
          }
        };
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

    Image image =
        new Image() {
          {
            setId(UUID.randomUUID());
          }
        };
    Page page =
        new Page() {
          {
            setId(UUID.randomUUID());
            setImage(image);
            setPageNumber(1);
          }
        };

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
        new Chapter() {
          {
            setId(chapterId);
            setSeries(new com.manga.library.model.Series());
          }
        };
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

    Image image =
        new Image() {
          {
            setId(UUID.randomUUID());
          }
        };
    Page page =
        new Page() {
          {
            setId(UUID.randomUUID());
            setImage(image);
            setPageNumber(1);
          }
        };

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
        new com.manga.library.model.OcrRegion() {
          {
            setId(regionId);
          }
        };
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
        new Chapter() {
          {
            setId(chapterId);
            setSeries(new com.manga.library.model.Series());
          }
        };
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".png");

    UUID existingImageId = UUID.randomUUID();
    Image existingImage =
        new Image() {
          {
            setId(existingImageId);
            setHash("somehash");
          }
        };
    when(imageRepository.findByHash(anyString())).thenReturn(Optional.of(existingImage));

    Page page =
        new Page() {
          {
            setId(UUID.randomUUID());
            setImage(existingImage);
          }
        };
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
        new com.manga.library.model.Series() {
          {
            setId(UUID.randomUUID());
            setTargetLanguage("en");
          }
        };
    Chapter chapter =
        new Chapter() {
          {
            setId(chapterId);
            setSeries(series);
          }
        };
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".png");

    UUID existingImageId = UUID.randomUUID();
    Image existingImage =
        new Image() {
          {
            setId(existingImageId);
            setHash("somehash");
          }
        };
    when(imageRepository.findByHash(anyString())).thenReturn(Optional.of(existingImage));

    Page page =
        new Page() {
          {
            setId(UUID.randomUUID());
            setImage(existingImage);
            setChapter(chapter);
          }
        };
    when(pageService.createPageWithExistingImage(any(), any(), any(), any())).thenReturn(page);

    Page sourcePage = new Page();
    sourcePage.setId(UUID.randomUUID());
    Chapter sourceChapter = new Chapter();
    sourceChapter.setId(UUID.randomUUID());
    sourcePage.setChapter(sourceChapter);

    when(pageRepository.findByImageId(existingImageId)).thenReturn(java.util.Collections.singletonList(sourcePage));

    com.manga.library.model.Layer ocrLayer = new com.manga.library.model.Layer();
    ocrLayer.setType("ocr");
    when(layerRepository.findByPageId(sourcePage.getId())).thenReturn(java.util.Collections.singletonList(ocrLayer));

    com.manga.library.service.JobCoordinatorService.ResolvedPipelineConfig sourceConfig =
        new com.manga.library.service.JobCoordinatorService.ResolvedPipelineConfig("ocr1", "model1", "tl1", "tlmodel1", "qa1", "qallm1", "qavlm1", "qamode1");
    com.manga.library.service.JobCoordinatorService.ResolvedPipelineConfig targetConfig =
        new com.manga.library.service.JobCoordinatorService.ResolvedPipelineConfig("ocr1", "model1", "tl2", "tlmodel2", "qa2", "qallm2", "qavlm2", "qamode2");

    when(jobCoordinatorService.resolveConfigForChapter(sourceChapter)).thenReturn(sourceConfig);
    when(jobCoordinatorService.resolveConfigForChapter(chapter)).thenReturn(targetConfig);
    when(pageService.cloneOcrData(sourcePage, page)).thenReturn(java.util.Collections.emptyMap());


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
        new Chapter() {
          {
            setId(chapterId);
            setSeries(new com.manga.library.model.Series());
          }
        };
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
        new Chapter() {
          {
            setId(chapterId);
            setSeries(new com.manga.library.model.Series());
          }
        };
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

    Page page1 =
        new Page() {
          {
            setId(p1);
            setPageNumber(1);
          }
        };

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
        new com.manga.library.model.OcrRegion() {
          {
            setId(id);
            setText("original text");
            setConfidence(0.8);
          }
        };

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
        new Chapter() {
          {
            setId(chapterId);
            setSeries(new com.manga.library.model.Series());
          }
        };
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
        new Chapter() {
          {
            setId(chapterId);
            setSeries(new com.manga.library.model.Series());
          }
        };
    when(chapterRepository.findWithSeriesById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageService.getFileExtension(anyString())).thenReturn(".bmp");

    // Create a 1x1 valid BMP in memory
    java.awt.image.BufferedImage img =
        new java.awt.image.BufferedImage(1, 1, java.awt.image.BufferedImage.TYPE_INT_RGB);
    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    javax.imageio.ImageIO.write(img, "bmp", baos);
    byte[] bmpBytes = baos.toByteArray();

    Page page =
        new Page() {
          {
            setId(UUID.randomUUID());
            setImage(
                new Image() {
                  {
                    setId(UUID.randomUUID());
                  }
                });
          }
        };
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
