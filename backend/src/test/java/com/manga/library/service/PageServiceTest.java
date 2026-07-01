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
}
