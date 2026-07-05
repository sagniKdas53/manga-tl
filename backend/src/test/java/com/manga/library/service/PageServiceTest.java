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
public class PageServiceTest {

  @Mock private ImageRepository imageRepository;
  @Mock private PageRepository pageRepository;
  @Mock private SeriesRepository seriesRepository;

  private PageService pageService;

  @BeforeEach
  public void setUp() {
    pageService = new PageService(imageRepository, pageRepository, seriesRepository);
  }

  @Test
  public void testCreatePageAndImage() {
    Chapter chapter = new Chapter();
    User user = new User();
    Image image = Image.builder().id(UUID.randomUUID()).build();
    Page page = Page.builder().id(UUID.randomUUID()).build();

    when(imageRepository.save(any(Image.class))).thenReturn(image);
    when(pageRepository.save(any(Page.class))).thenReturn(page);

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
    Image image = new Image();
    User user = new User();
    Page page = Page.builder().id(UUID.randomUUID()).build();

    when(pageRepository.save(any(Page.class))).thenReturn(page);

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
    Series series = Series.builder().id(UUID.randomUUID()).coverImageUrl("some_url/" + pageId).build();
    Chapter chapter = Chapter.builder().id(chapterId).series(series).build();
    Image image = Image.builder().id(pageId).storagePath("path").thumbnailStoragePath("thumb").build();
    Page page = Page.builder().id(pageId).chapter(chapter).image(image).build();

    when(pageRepository.findById(pageId)).thenReturn(java.util.Optional.of(page));
    when(pageRepository.findByChapterIdOrderByPageNumberAsc(chapterId)).thenReturn(java.util.Collections.emptyList());

    java.util.List<String> paths = pageService.deletePageDb(pageId);

    assertNotNull(paths);
    assertEquals(3, paths.size());
    verify(pageRepository, times(1)).delete(page);
    verify(imageRepository, times(1)).delete(image);
    verify(seriesRepository, times(1)).save(series);
  }

  @Test
  public void testGenerateThumbnail_Success() throws Exception {
    java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(10, 10, java.awt.image.BufferedImage.TYPE_INT_RGB);
    java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
    javax.imageio.ImageIO.write(img, "png", baos);
    
    byte[] thumbnail = pageService.generateThumbnail(baos.toByteArray());
    assertNotNull(thumbnail);
  }
}
