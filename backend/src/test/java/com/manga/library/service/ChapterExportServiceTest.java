package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

import com.manga.library.model.Chapter;
import com.manga.library.model.Image;
import com.manga.library.model.Page;
import com.manga.library.model.Series;
import com.manga.library.repository.ChapterRepository;
import com.manga.library.repository.LayerElementRepository;
import com.manga.library.repository.LayerRepository;
import com.manga.library.repository.PageRepository;
import java.io.ByteArrayInputStream;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
public class ChapterExportServiceTest {

  @Mock private ChapterRepository chapterRepository;
  @Mock private PageRepository pageRepository;
  @Mock private MinioService minioService;
  @Mock private LayerRepository layerRepository;
  @Mock private LayerElementRepository layerElementRepository;
  @Mock private SseService sseService;

  @InjectMocks private ChapterExportService chapterExportService;

  private UUID chapterId;
  private UUID userId;
  private String exportId;

  @BeforeEach
  void setUp() {
    chapterId = UUID.randomUUID();
    userId = UUID.randomUUID();
    exportId = "export-123";
  }

  @Test
  void testBuildAndUploadExport_Success() throws Exception {
    Series series = new Series();
    series.setId(UUID.randomUUID());
    series.setTitle("Test Series");

    Chapter chapter = new Chapter();
    chapter.setId(chapterId);
    chapter.setSeries(series);
    chapter.setChapterNumber(1.0);
    chapter.setTitle("Chapter 1");

    Image image = new Image();
    image.setId(UUID.randomUUID());
    image.setFilename("001.png");
    image.setStoragePath("originals/001.png");

    Page page = new Page();
    page.setId(UUID.randomUUID());
    page.setPageNumber(1);
    page.setImage(image);

    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId)).thenReturn(List.of(page));
    when(minioService.fileExists(anyString())).thenReturn(false);
    com.manga.library.model.Layer layer = new com.manga.library.model.Layer();
    layer.setId(UUID.randomUUID());
    layer.setType("translation");
    layer.setTargetLanguage("en");
    layer.setVisible(true);

    com.fasterxml.jackson.databind.ObjectMapper mapper =
        new com.fasterxml.jackson.databind.ObjectMapper();
    com.fasterxml.jackson.databind.node.ObjectNode meta = mapper.createObjectNode();
    meta.put("model", "test-model");

    com.fasterxml.jackson.databind.node.ObjectNode costNode = mapper.createObjectNode();
    costNode.put("estimated_cost", 0.05);
    meta.set("cost", costNode);

    com.fasterxml.jackson.databind.node.ObjectNode qaNode = mapper.createObjectNode();
    qaNode.put("status", "manual_review");
    meta.set("qa", qaNode);

    layer.setMetadataJson(meta);

    when(layerRepository.findByImageId(image.getId())).thenReturn(List.of(layer));

    when(minioService.downloadFile("originals/001.png"))
        .thenReturn(new ByteArrayInputStream(new byte[] {1, 2, 3}));

    when(minioService.uploadFile(anyString(), any(byte[].class), eq("application/zip")))
        .thenReturn("mocked-path");

    assertDoesNotThrow(
        () -> chapterExportService.buildAndUploadExport(chapterId, userId, exportId));

    verify(minioService).uploadFile(anyString(), any(byte[].class), eq("application/zip"));
    verify(sseService)
        .emitNotificationToUser(
            eq(userId), eq("EXPORT_SUCCESS"), anyString(), anyString(), any(), any());
  }

  @Test
  void testBuildAndUploadExport_CacheHit() throws Exception {
    Series series = new Series();
    series.setId(UUID.randomUUID());
    series.setTitle("Test Series");

    Chapter chapter = new Chapter();
    chapter.setId(chapterId);
    chapter.setSeries(series);
    chapter.setChapterNumber(1.0);

    Image image = new Image();
    image.setId(UUID.randomUUID());
    image.setFilename("001.png");

    Page page = new Page();
    page.setId(UUID.randomUUID());
    page.setPageNumber(1);
    page.setImage(image);

    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId)).thenReturn(List.of(page));
    com.manga.library.model.Layer layer = new com.manga.library.model.Layer();
    layer.setId(UUID.randomUUID());
    layer.setType("translation");
    layer.setTargetLanguage("en");
    layer.setVisible(true);
    when(layerRepository.findByImageId(image.getId())).thenReturn(List.of(layer));

    // Fake the hash check for cache hit by mocking minioService.fileExists to true when it matches
    // the hash
    // We'll just return true for any fileExists call that starts with "exports/"
    when(minioService.fileExists(anyString()))
        .thenAnswer(
            invocation -> {
              String path = invocation.getArgument(0);
              return path.startsWith("exports/");
            });

    assertDoesNotThrow(
        () -> chapterExportService.buildAndUploadExport(chapterId, userId, exportId));

    verify(minioService, never()).uploadFile(anyString(), any(byte[].class), anyString());
    verify(sseService)
        .emitNotificationToUser(
            eq(userId), eq("EXPORT_SUCCESS"), anyString(), anyString(), any(), any());
  }
}
