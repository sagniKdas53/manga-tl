package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.manga.library.model.*;
import com.manga.library.repository.ImageRepository;
import com.manga.library.repository.PageRepository;
import com.manga.library.repository.SeriesRepository;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
@SuppressWarnings("null")
public class PageServiceTest {

  @Mock private ImageRepository imageRepository;
  @Mock private PageRepository pageRepository;
  @Mock private SeriesRepository seriesRepository;
  @Mock private com.manga.library.repository.ChapterRepository chapterRepository;
  @Mock private MinioService minioService;

  private PageService pageService;

  @BeforeEach
  public void setUp() {
    pageService =
        new PageService(
            imageRepository, pageRepository, seriesRepository, chapterRepository, minioService);
  }

  @Test
  public void testCreatePageAndImage() {
    Chapter chapter = new Chapter();
    chapter.setId(UUID.randomUUID());
    chapter.setChapterNumber(1.0);
    Series series = new Series();
    series.setId(UUID.randomUUID());
    chapter.setSeries(series);
    User user = new User();
    Image image = Image.builder().id(UUID.randomUUID()).build();
    Page page = Page.builder().id(UUID.randomUUID()).image(image).build();

    when(pageRepository.findByChapterIdAndPageNumber(chapter.getId(), 1))
        .thenReturn(java.util.Optional.of(page));
    when(imageRepository.save(any(Image.class))).thenReturn(image);
    when(pageRepository.save(any(Page.class))).thenReturn(page);

    when(chapterRepository.findById(chapter.getId())).thenReturn(java.util.Optional.of(chapter));
    when(seriesRepository.findById(series.getId())).thenReturn(java.util.Optional.of(series));
    when(chapterRepository.findMinChapterNumberWithCoverBySeriesId(series.getId())).thenReturn(1.0);

    Page result =
        pageService.createPageAndImage(
            chapter, "file.png", "path/file.png", "thumb/file.png", 1, "hash123", user);

    assertNotNull(result);
    verify(imageRepository, times(1)).save(any(Image.class));
    verify(pageRepository, times(1)).save(any(Page.class));
  }

  @Test
  public void testCreatePageWithExistingImage() {
    Chapter chapter = new Chapter();
    chapter.setId(UUID.randomUUID());
    chapter.setChapterNumber(1.0);
    Series series = new Series();
    series.setId(UUID.randomUUID());
    chapter.setSeries(series);
    Image image = new Image();
    image.setId(UUID.randomUUID());
    User user = new User();
    Page page = Page.builder().id(UUID.randomUUID()).build();

    when(pageRepository.findByChapterIdAndPageNumber(chapter.getId(), 1))
        .thenReturn(java.util.Optional.empty());
    when(pageRepository.save(any(Page.class))).thenReturn(page);
    when(chapterRepository.findById(chapter.getId())).thenReturn(java.util.Optional.of(chapter));
    when(seriesRepository.findById(series.getId())).thenReturn(java.util.Optional.of(series));
    when(chapterRepository.findMinChapterNumberWithCoverBySeriesId(series.getId())).thenReturn(1.0);

    Page result = pageService.createPageWithExistingImage(chapter, image, 1, user);

    assertNotNull(result);
    verify(pageRepository, times(1)).save(any(Page.class));
  }

  @Test
  public void testGetFileExtension() {
    assertEquals(".jpg", pageService.getFileExtension("image.jpg"));
    assertEquals(".png", pageService.getFileExtension("archive.png"));
    assertEquals(".jpg", pageService.getFileExtension("no-extension"));
    assertEquals(".jpg", pageService.getFileExtension(null));
  }

  @Test
  public void testDeletePageDb_Success() {
    UUID pageId = UUID.randomUUID();
    UUID chapterId = UUID.randomUUID();
    Series series = Series.builder().id(UUID.randomUUID()).build();
    Chapter chapter = Chapter.builder().id(chapterId).series(series).build();
    Image image =
        Image.builder().id(pageId).storagePath("path").thumbnailStoragePath("thumb").build();
    Page page = Page.builder().id(pageId).chapter(chapter).image(image).build();

    when(pageRepository.findById(pageId)).thenReturn(java.util.Optional.of(page));
    when(pageRepository.findByImageId(pageId)).thenReturn(java.util.List.of(page));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.Collections.emptyList());

    java.util.List<String> paths = pageService.deletePageDb(pageId);

    assertNotNull(paths);
    assertEquals(3, paths.size());
    verify(pageRepository, times(1)).delete(page);
    verify(imageRepository, times(1)).delete(image);
  }

  @Test
  public void testDeletePageDb_SharedImage() {
    UUID pageId = UUID.randomUUID();
    UUID chapterId = UUID.randomUUID();
    Chapter chapter = Chapter.builder().id(chapterId).build();
    Image image = Image.builder().id(pageId).storagePath("path").build();
    Page page1 = Page.builder().id(pageId).chapter(chapter).image(image).build();
    Page page2 = Page.builder().id(UUID.randomUUID()).chapter(chapter).image(image).build();

    when(pageRepository.findById(pageId)).thenReturn(java.util.Optional.of(page1));
    when(pageRepository.findByImageId(pageId)).thenReturn(java.util.List.of(page1, page2));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.Collections.emptyList());

    java.util.List<String> paths = pageService.deletePageDb(pageId);

    assertNotNull(paths);
    assertEquals(0, paths.size()); // should not delete image files
    verify(pageRepository, times(1)).delete(page1);
    verify(imageRepository, never()).delete(image);
  }

  @Test
  public void testCreatePageWithExistingImage_Conflict() {
    Chapter chapter = Chapter.builder().id(UUID.randomUUID()).chapterNumber(1.0).build();
    Series series = Series.builder().id(UUID.randomUUID()).build();
    chapter.setSeries(series);
    Image newImage = Image.builder().id(UUID.randomUUID()).build();
    Image existingImage = Image.builder().id(UUID.randomUUID()).build();
    User user = new User();

    Page conflictingPage =
        Page.builder()
            .id(UUID.randomUUID())
            .chapter(chapter)
            .pageNumber(1)
            .image(existingImage)
            .build();
    Page newPage = Page.builder().id(UUID.randomUUID()).build();

    when(pageRepository.findByChapterIdAndPageNumber(chapter.getId(), 1))
        .thenReturn(java.util.Optional.of(conflictingPage));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapter.getId()))
        .thenReturn(java.util.List.of(conflictingPage));
    when(pageRepository.save(any(Page.class))).thenReturn(newPage);
    when(chapterRepository.findById(chapter.getId())).thenReturn(java.util.Optional.of(chapter));
    when(seriesRepository.findById(series.getId())).thenReturn(java.util.Optional.of(series));
    when(chapterRepository.findMinChapterNumberWithCoverBySeriesId(series.getId())).thenReturn(1.0);

    Page result = pageService.createPageWithExistingImage(chapter, newImage, 1, user);

    assertNotNull(result);
    verify(pageRepository, times(2)).save(any(Page.class)); // 1 for shift, 1 for new
  }

  @Test
  public void testDeletePageDb_NotFound() {
    UUID pageId = UUID.randomUUID();
    when(pageRepository.findById(pageId)).thenReturn(java.util.Optional.empty());

    assertThrows(IllegalArgumentException.class, () -> pageService.deletePageDb(pageId));
  }

  @Test
  public void testRecalculateSeriesCover() {
    UUID seriesId = UUID.randomUUID();
    Series series = new Series();
    series.setId(seriesId);

    UUID coverId = UUID.randomUUID();
    Chapter chapter = new Chapter();
    chapter.setId(UUID.randomUUID());
    chapter.setCoverImageId(coverId);

    when(seriesRepository.findById(seriesId)).thenReturn(java.util.Optional.of(series));
    when(chapterRepository.findMinChapterNumberWithCoverBySeriesId(seriesId)).thenReturn(1.0);
    when(chapterRepository.findBySeriesIdAndChapterNumber(seriesId, 1.0))
        .thenReturn(java.util.Optional.of(chapter));

    pageService.recalculateSeriesCover(seriesId);

    verify(seriesRepository, times(1)).save(series);
    assertEquals(coverId, series.getCoverImageId());
  }

  @Test
  public void testRecalculateChapterCover() {
    UUID chapterId = UUID.randomUUID();
    Series series = new Series();
    series.setId(UUID.randomUUID());

    Chapter chapter = new Chapter();
    chapter.setId(chapterId);
    chapter.setSeries(series);

    UUID imageId = UUID.randomUUID();
    Image image = new Image();
    image.setId(imageId);

    Page firstPage = new Page();
    firstPage.setId(UUID.randomUUID());
    firstPage.setImage(image);

    when(chapterRepository.findById(chapterId)).thenReturn(java.util.Optional.of(chapter));
    when(pageRepository.findByChapterIdAndPageNumber(chapterId, 1))
        .thenReturn(java.util.Optional.of(firstPage));

    // For the cascaded series recalculation
    when(seriesRepository.findById(series.getId())).thenReturn(java.util.Optional.of(series));

    pageService.recalculateChapterCover(chapterId);

    verify(chapterRepository, times(1)).save(chapter);
    assertEquals(imageId, chapter.getCoverImageId());
    verify(seriesRepository, times(1)).save(series);
  }

  @Test
  public void testUpdatePageNumber_MoveForward() {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter = new Chapter();
    chapter.setId(chapterId);

    Page p1 = Page.builder().id(UUID.randomUUID()).chapter(chapter).pageNumber(1).build();
    Page p2 = Page.builder().id(UUID.randomUUID()).chapter(chapter).pageNumber(2).build();
    Page p3 = Page.builder().id(UUID.randomUUID()).chapter(chapter).pageNumber(3).build();
    Page p4 = Page.builder().id(UUID.randomUUID()).chapter(chapter).pageNumber(4).build();

    when(pageRepository.findById(p2.getId())).thenReturn(java.util.Optional.of(p2));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.List.of(p1, p2, p3, p4));

    pageService.updatePageNumber(p2.getId(), 4);

    // p2 is moved to 4. p3 and p4 shift down to 2 and 3.
    // p2 is saved twice (once temporarily, once final)
    verify(pageRepository, times(1)).save(argThat(p -> p.getId().equals(p3.getId())));
    verify(pageRepository, times(1)).save(argThat(p -> p.getId().equals(p4.getId())));
    verify(pageRepository, times(2)).save(argThat(p -> p.getId().equals(p2.getId())));
  }

  @Test
  public void testUpdatePageNumber_MoveBackward() {
    UUID chapterId = UUID.randomUUID();
    Chapter chapter = new Chapter();
    chapter.setId(chapterId);

    Page p1 = Page.builder().id(UUID.randomUUID()).chapter(chapter).pageNumber(1).build();
    Page p2 = Page.builder().id(UUID.randomUUID()).chapter(chapter).pageNumber(2).build();
    Page p3 = Page.builder().id(UUID.randomUUID()).chapter(chapter).pageNumber(3).build();
    Page p4 = Page.builder().id(UUID.randomUUID()).chapter(chapter).pageNumber(4).build();

    when(pageRepository.findById(p4.getId())).thenReturn(java.util.Optional.of(p4));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId))
        .thenReturn(java.util.List.of(p1, p2, p3, p4));

    pageService.updatePageNumber(p4.getId(), 2);

    // p4 is moved to 2. p2 and p3 shift up to 3 and 4.
    // p4 is saved twice (once temporarily, once final)
    verify(pageRepository, times(1)).save(argThat(p -> p.getId().equals(p2.getId())));
    verify(pageRepository, times(1)).save(argThat(p -> p.getId().equals(p3.getId())));
    verify(pageRepository, times(2)).save(argThat(p -> p.getId().equals(p4.getId())));
  }
}
