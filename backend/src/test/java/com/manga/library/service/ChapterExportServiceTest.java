package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

import com.manga.library.model.Chapter;
import com.manga.library.model.Image;
import com.manga.library.model.Page;
import com.manga.library.model.Series;
import com.manga.library.repository.ChapterRepository;
import com.manga.library.repository.JobCostRepository;
import com.manga.library.repository.LayerElementRepository;
import com.manga.library.repository.LayerRepository;
import com.manga.library.repository.PageRepository;
import io.minio.Result;
import io.minio.messages.Item;
import java.io.ByteArrayInputStream;
import java.time.ZonedDateTime;
import java.util.Collections;
import java.util.Iterator;
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
@SuppressWarnings("null")
public class ChapterExportServiceTest {

  @Mock private ChapterRepository chapterRepository;
  @Mock private PageRepository pageRepository;
  @Mock private MinioService minioService;
  @Mock private LayerRepository layerRepository;
  @Mock private LayerElementRepository layerElementRepository;
  @Mock private JobCostRepository jobCostRepository;
  @Mock private SseService sseService;

  @InjectMocks private ChapterExportService chapterExportService;

  private UUID chapterId;
  private UUID userId;

  @BeforeEach
  void setUp() {
    chapterId = UUID.randomUUID();
    userId = UUID.randomUUID();
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

    when(layerRepository.findByPageId(page.getId())).thenReturn(List.of(layer));
    when(jobCostRepository.findByImageId(image.getId())).thenReturn(List.of());


    when(minioService.downloadFile("originals/001.png"))
        .thenReturn(new ByteArrayInputStream(new byte[] {1, 2, 3}));

    when(minioService.uploadFile(anyString(), any(byte[].class), eq("application/zip")))
        .thenReturn("mocked-path");

    assertDoesNotThrow(() -> chapterExportService.buildAndUploadExport(chapterId, userId, false));

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
    when(layerRepository.findByPageId(page.getId())).thenReturn(List.of(layer));

    when(jobCostRepository.findByImageId(image.getId())).thenReturn(List.of());

    // Fake the hash check for cache hit by mocking minioService.fileExists to true when it matches
    // the hash
    // We'll just return true for any fileExists call that starts with "exports/"
    when(minioService.fileExists(anyString()))
        .thenAnswer(
            invocation -> {
              String path = invocation.getArgument(0);
              return path.startsWith("exports/");
            });

    assertDoesNotThrow(() -> chapterExportService.buildAndUploadExport(chapterId, userId, false));

    verify(minioService, never()).uploadFile(anyString(), any(byte[].class), anyString());
    verify(sseService)
        .emitNotificationToUser(
            eq(userId), eq("EXPORT_SUCCESS"), anyString(), anyString(), any(), any());
  }

  @Test
  void testBuildAndUploadExport_ChapterNotFound() {
    when(chapterRepository.findById(chapterId)).thenReturn(Optional.empty());

    chapterExportService.buildAndUploadExport(chapterId, userId, false);

    verify(sseService)
        .emitNotificationToUser(
            eq(userId), eq("EXPORT_ERROR"), anyString(), anyString());
  }

  @Test
  void testBuildAndUploadExport_EmptyPages() {
    Chapter chapter = new Chapter();
    chapter.setId(chapterId);
    chapter.setChapterNumber(1.0);

    when(chapterRepository.findById(chapterId)).thenReturn(Optional.of(chapter));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(Collections.emptyList());

    chapterExportService.buildAndUploadExport(chapterId, userId, false);

    verify(sseService)
        .emitNotificationToUser(
            eq(userId), eq("EXPORT_ERROR"), anyString(), anyString());
  }

  @Test
  void testClearChapterExports() throws Exception {
    when(minioService.listObjects(anyString())).thenReturn(Collections.emptyList());

    assertDoesNotThrow(() -> chapterExportService.clearChapterExports(chapterId));

    verify(minioService).listObjects(contains(chapterId.toString()));
  }

  @Test
  void testClearChapterExports_HandlesException() throws Exception {
    when(minioService.listObjects(anyString()))
        .thenThrow(new RuntimeException("MinIO error"));

    assertDoesNotThrow(() -> chapterExportService.clearChapterExports(chapterId));
  }

  @Test
  void testCleanupStaleExports() throws Exception {
    ZonedDateTime oldDate = ZonedDateTime.now().minusDays(10);
    Item fileItem = mock(Item.class);
    when(fileItem.lastModified()).thenReturn(oldDate);
    when(fileItem.objectName()).thenReturn("exports/old.zip");

    Result<Item> result = mock(Result.class);
    when(result.get()).thenReturn(fileItem);

    when(minioService.listObjects(eq("exports/")))
        .thenAnswer(inv -> singleItemIterable(result));

    assertDoesNotThrow(() -> chapterExportService.cleanupStaleExports());

    verify(minioService).deleteFile("exports/old.zip");
  }

  @Test
  void testCleanupStaleExports_NoOldFiles() throws Exception {
    when(minioService.listObjects(eq("exports/")))
        .thenReturn(Collections.emptyList());

    assertDoesNotThrow(() -> chapterExportService.cleanupStaleExports());

    verify(minioService, never()).deleteFile(anyString());
  }

  private Iterable<Result<Item>> singleItemIterable(Result<Item> result) {
    return () -> new Iterator<Result<Item>>() {
      private boolean hasNext = true;
      @Override public boolean hasNext() { return hasNext; }
      @Override public Result<Item> next() { hasNext = false; return result; }
    };
  }
}
