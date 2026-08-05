package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.manga.library.model.*;
import com.manga.library.repository.ImageRepository;
import com.manga.library.repository.PageRepository;
import com.manga.library.repository.SeriesRepository;
import com.manga.library.repository.LayerRepository;
import com.manga.library.repository.LayerElementRepository;
import com.manga.library.repository.OcrRegionRepository;
import java.util.UUID;
import java.util.Map;
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
  @Mock private LayerRepository layerRepository;
  @Mock private LayerElementRepository layerElementRepository;
  @Mock private OcrRegionRepository ocrRegionRepository;

  private PageService pageService;

  @BeforeEach
  public void setUp() {
    pageService =
        new PageService(
            imageRepository, pageRepository, seriesRepository, chapterRepository, minioService, layerRepository, layerElementRepository, ocrRegionRepository);
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
    Page page =
        new Page() {
          {
            setId(UUID.randomUUID());
          }
        };

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

  /**
   * AUDIT-B7: importing a duplicate image into an empty chapter passes pageNumber = null, which
   * resolves to safePageNumber 1. The cover recalculation must key off safePageNumber, not the raw
   * argument, or the chapter is left coverless.
   */
  @Test
  public void testCreatePageWithExistingImage_nullPageNumberOnEmptyChapterSetsCover() {
    Chapter chapter = new Chapter();
    chapter.setId(UUID.randomUUID());
    chapter.setChapterNumber(1.0);
    Series series = new Series();
    series.setId(UUID.randomUUID());
    chapter.setSeries(series);
    Image image = new Image();
    image.setId(UUID.randomUUID());
    User user = new User();
    Page saved =
        new Page() {
          {
            setId(UUID.randomUUID());
            setPageNumber(1);
            setImage(image);
          }
        };

    // Empty chapter: no page at 1 when we look for a collision, then the freshly saved page
    // when recalculateChapterCover goes looking for the cover.
    when(pageRepository.findByChapterIdAndPageNumber(chapter.getId(), 1))
        .thenReturn(java.util.Optional.empty())
        .thenReturn(java.util.Optional.of(saved));
    when(pageRepository.save(any(Page.class))).thenReturn(saved);
    when(chapterRepository.findById(chapter.getId())).thenReturn(java.util.Optional.of(chapter));
    when(seriesRepository.findById(series.getId())).thenReturn(java.util.Optional.of(series));
    when(chapterRepository.findMinChapterNumberWithCoverBySeriesId(series.getId()))
        .thenReturn(null);

    Page result = pageService.createPageWithExistingImage(chapter, image, null, user);

    assertNotNull(result);
    assertEquals(
        image.getId(),
        chapter.getCoverImageId(),
        "a duplicate import into an empty chapter must still set the chapter cover");
    verify(chapterRepository, times(1)).save(chapter);
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
    Series series =
        new Series() {
          {
            setId(UUID.randomUUID());
          }
        };
    Chapter chapter =
        new Chapter() {
          {
            setId(chapterId);
            setSeries(series);
          }
        };
    Image image =
        new Image() {
          {
            setId(pageId);
            setStoragePath("path");
            setThumbnailStoragePath("thumb");
          }
        };
    Page page =
        new Page() {
          {
            setId(pageId);
            setChapter(chapter);
            setImage(image);
          }
        };

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
    Chapter chapter =
        new Chapter() {
          {
            setId(chapterId);
          }
        };
    Image image =
        new Image() {
          {
            setId(pageId);
            setStoragePath("path");
          }
        };
    Page page1 =
        new Page() {
          {
            setId(pageId);
            setChapter(chapter);
            setImage(image);
          }
        };
    Page page2 =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setImage(image);
          }
        };

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
    Chapter chapter =
        new Chapter() {
          {
            setId(UUID.randomUUID());
            setChapterNumber(1.0);
          }
        };
    Series series =
        new Series() {
          {
            setId(UUID.randomUUID());
          }
        };
    chapter.setSeries(series);
    Image newImage =
        new Image() {
          {
            setId(UUID.randomUUID());
          }
        };
    Image existingImage =
        new Image() {
          {
            setId(UUID.randomUUID());
          }
        };
    User user = new User();

    Page conflictingPage =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setPageNumber(1);
            setImage(existingImage);
          }
        };
    Page newPage =
        new Page() {
          {
            setId(UUID.randomUUID());
          }
        };

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

    Page p1 =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setPageNumber(1);
          }
        };
    Page p2 =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setPageNumber(2);
          }
        };
    Page p3 =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setPageNumber(3);
          }
        };
    Page p4 =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setPageNumber(4);
          }
        };

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

    Page p1 =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setPageNumber(1);
          }
        };
    Page p2 =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setPageNumber(2);
          }
        };
    Page p3 =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setPageNumber(3);
          }
        };
    Page p4 =
        new Page() {
          {
            setId(UUID.randomUUID());
            setChapter(chapter);
            setPageNumber(4);
          }
        };

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

  @Test
  public void testCloneOcrData_NoSourceLayer_ReturnsEmpty() {
    Page sourcePage = new Page();
    sourcePage.setId(UUID.randomUUID());
    Page targetPage = new Page();
    targetPage.setId(UUID.randomUUID());

    when(layerRepository.findByPageId(sourcePage.getId())).thenReturn(java.util.Collections.emptyList());

    Map<UUID, UUID> result = pageService.cloneOcrData(sourcePage, targetPage);

    assertTrue(result.isEmpty());
    verify(ocrRegionRepository, never()).save(any(OcrRegion.class));
    verify(layerRepository, never()).save(any(Layer.class));
  }

  @Test
  public void testCloneOcrData_CopiesRegionsAndLayer() {
    Page sourcePage = new Page();
    sourcePage.setId(UUID.randomUUID());
    Page targetPage = new Page();
    targetPage.setId(UUID.randomUUID());

    Layer sourceOcrLayer = new Layer();
    sourceOcrLayer.setId(UUID.randomUUID());
    sourceOcrLayer.setType("ocr");
    sourceOcrLayer.setVisible(true);
    sourceOcrLayer.setZOrder(1);

    when(layerRepository.findByPageId(sourcePage.getId())).thenReturn(java.util.List.of(sourceOcrLayer));

    OcrRegion sourceRegion = new OcrRegion();
    sourceRegion.setId(UUID.randomUUID());
    sourceRegion.setText("Test Text");
    sourceRegion.setDetectedLanguage("ja");
    sourceRegion.setBboxX(10);
    sourceRegion.setBboxY(20);
    sourceRegion.setBboxW(100);
    sourceRegion.setBboxH(200);

    when(ocrRegionRepository.findByPageId(sourcePage.getId())).thenReturn(java.util.List.of(sourceRegion));
    when(ocrRegionRepository.save(any(OcrRegion.class))).thenAnswer(i -> {
      OcrRegion r = i.getArgument(0);
      r.setId(UUID.randomUUID());
      return r;
    });

    when(layerRepository.save(any(Layer.class))).thenAnswer(i -> {
      Layer l = i.getArgument(0);
      l.setId(UUID.randomUUID());
      return l;
    });

    LayerElement sourceEl = new LayerElement();
    sourceEl.setId(UUID.randomUUID());
    sourceEl.setLayer(sourceOcrLayer);
    sourceEl.setRegion(sourceRegion);
    sourceEl.setText("Test Text");
    sourceEl.setX(10.0);
    sourceEl.setY(20.0);

    when(layerElementRepository.findByLayerPageId(sourcePage.getId())).thenReturn(java.util.List.of(sourceEl));

    Map<UUID, UUID> result = pageService.cloneOcrData(sourcePage, targetPage);

    assertFalse(result.isEmpty());
    assertTrue(result.containsKey(sourceRegion.getId()));

    verify(ocrRegionRepository, times(1)).save(any(OcrRegion.class));
    verify(layerRepository, times(1)).save(any(Layer.class));
    verify(layerElementRepository, times(1)).save(any(LayerElement.class));
  }

  private static Layer translationLayer(String targetLanguage, int zOrder, boolean visible) {
    Layer layer = new Layer();
    layer.setId(UUID.randomUUID());
    layer.setType("translation");
    layer.setTargetLanguage(targetLanguage);
    layer.setZOrder(zOrder);
    layer.setVisible(visible);
    return layer;
  }

  @Test
  public void testCloneTranslationData_NoVisibleTranslationLayer_DoesNothing() {
    Page sourcePage = new Page();
    sourcePage.setId(UUID.randomUUID());
    Page targetPage = new Page();
    targetPage.setId(UUID.randomUUID());

    // An OCR layer and a *hidden* translation layer: neither is a clone source.
    Layer ocrLayer = new Layer();
    ocrLayer.setId(UUID.randomUUID());
    ocrLayer.setType("ocr");
    ocrLayer.setVisible(true);
    ocrLayer.setZOrder(0);

    when(layerRepository.findByPageId(sourcePage.getId()))
        .thenReturn(java.util.List.of(ocrLayer, translationLayer("en", 5, false)));

    pageService.cloneTranslationData(sourcePage, targetPage, Map.of());

    // Bailing out early matters: the regions on the target page were just written by
    // cloneOcrData, and a partial TL clone would overwrite them with nothing.
    verify(ocrRegionRepository, never()).save(any(OcrRegion.class));
    verify(layerRepository, never()).save(any(Layer.class));
    verify(layerElementRepository, never()).save(any(LayerElement.class));
  }

  @Test
  public void testCloneTranslationData_CopiesTranslationAndQaOntoMappedRegions() {
    Page sourcePage = new Page();
    sourcePage.setId(UUID.randomUUID());
    Page targetPage = new Page();
    targetPage.setId(UUID.randomUUID());

    Layer sourceTlLayer = translationLayer("en", 2, true);
    when(layerRepository.findByPageId(sourcePage.getId()))
        .thenReturn(java.util.List.of(sourceTlLayer));

    OcrRegion sourceRegion = new OcrRegion();
    sourceRegion.setId(UUID.randomUUID());
    sourceRegion.setText("元のテキスト");
    sourceRegion.setTranslatedText("Original text");
    sourceRegion.setApproved(true);
    sourceRegion.setTranslationFailed(false);
    sourceRegion.setTranslationScore(0.91);
    sourceRegion.setQaScore(0.77);
    sourceRegion.setQaFeedback("reads naturally");
    sourceRegion.setQaStatus("passed");

    // A region the caller never mapped -- cloneOcrData did not copy it, so there is no target
    // row to write to and it must be skipped rather than followed to a null.
    OcrRegion unmappedRegion = new OcrRegion();
    unmappedRegion.setId(UUID.randomUUID());
    unmappedRegion.setTranslatedText("should not be copied");

    OcrRegion targetRegion = new OcrRegion();
    targetRegion.setId(UUID.randomUUID());
    targetRegion.setText("元のテキスト");

    when(ocrRegionRepository.findByPageId(sourcePage.getId()))
        .thenReturn(java.util.List.of(sourceRegion, unmappedRegion));
    when(ocrRegionRepository.findById(targetRegion.getId()))
        .thenReturn(java.util.Optional.of(targetRegion));
    when(layerRepository.save(any(Layer.class)))
        .thenAnswer(
            i -> {
              Layer l = i.getArgument(0);
              l.setId(UUID.randomUUID());
              return l;
            });

    LayerElement sourceEl = new LayerElement();
    sourceEl.setId(UUID.randomUUID());
    sourceEl.setLayer(sourceTlLayer);
    sourceEl.setRegion(sourceRegion);
    sourceEl.setText("Original text");
    sourceEl.setFont("Comic Neue");
    sourceEl.setX(10.0);
    sourceEl.setY(20.0);
    sourceEl.setBoxShape("elliptical");
    when(layerElementRepository.findByLayerPageId(sourcePage.getId()))
        .thenReturn(java.util.List.of(sourceEl));

    pageService.cloneTranslationData(
        sourcePage, targetPage, Map.of(sourceRegion.getId(), targetRegion.getId()));

    // The translated string alone is not enough: the reader shows approval and QA state next to
    // it, so a clone that dropped them would look untranslated-but-typeset.
    assertEquals("Original text", targetRegion.getTranslatedText());
    assertEquals(Boolean.TRUE, targetRegion.getApproved());
    assertEquals(Boolean.FALSE, targetRegion.getTranslationFailed());
    assertEquals(0.91, targetRegion.getTranslationScore());
    assertEquals(0.77, targetRegion.getQaScore());
    assertEquals("reads naturally", targetRegion.getQaFeedback());
    assertEquals("passed", targetRegion.getQaStatus());
    verify(ocrRegionRepository, times(1)).save(any(OcrRegion.class));

    org.mockito.ArgumentCaptor<Layer> layerCaptor =
        org.mockito.ArgumentCaptor.forClass(Layer.class);
    verify(layerRepository, times(1)).save(layerCaptor.capture());
    Layer clonedLayer = layerCaptor.getValue();
    assertEquals(targetPage, clonedLayer.getPage());
    assertEquals("translation", clonedLayer.getType());
    assertEquals("en", clonedLayer.getTargetLanguage());
    assertEquals(2, clonedLayer.getZOrder());

    org.mockito.ArgumentCaptor<LayerElement> elementCaptor =
        org.mockito.ArgumentCaptor.forClass(LayerElement.class);
    verify(layerElementRepository, times(1)).save(elementCaptor.capture());
    LayerElement clonedEl = elementCaptor.getValue();
    assertEquals("Original text", clonedEl.getText());
    assertEquals("Comic Neue", clonedEl.getFont());
    assertEquals("elliptical", clonedEl.getBoxShape());
    // Re-pointed at the target page's region, not left aliasing the source page's.
    assertEquals(targetRegion, clonedEl.getRegion());
    assertEquals(clonedLayer, clonedEl.getLayer());
  }

  @Test
  public void testCloneTranslationData_PrefersHighestZOrderVisibleLayer() {
    Page sourcePage = new Page();
    sourcePage.setId(UUID.randomUUID());
    Page targetPage = new Page();
    targetPage.setId(UUID.randomUUID());

    // A retranslation leaves several TL layers on a page; the one on top is what the reader
    // sees, so it is the one worth carrying over.
    Layer older = translationLayer("en", 1, true);
    Layer newest = translationLayer("fr", 7, true);
    Layer hiddenOnTop = translationLayer("de", 9, false);

    when(layerRepository.findByPageId(sourcePage.getId()))
        .thenReturn(java.util.List.of(older, hiddenOnTop, newest));
    when(ocrRegionRepository.findByPageId(sourcePage.getId()))
        .thenReturn(java.util.Collections.emptyList());
    when(layerRepository.save(any(Layer.class))).thenAnswer(i -> i.getArgument(0));

    LayerElement onOlderLayer = new LayerElement();
    onOlderLayer.setId(UUID.randomUUID());
    onOlderLayer.setLayer(older);
    onOlderLayer.setText("stale");
    when(layerElementRepository.findByLayerPageId(sourcePage.getId()))
        .thenReturn(java.util.List.of(onOlderLayer));

    pageService.cloneTranslationData(sourcePage, targetPage, Map.of());

    org.mockito.ArgumentCaptor<Layer> layerCaptor =
        org.mockito.ArgumentCaptor.forClass(Layer.class);
    verify(layerRepository, times(1)).save(layerCaptor.capture());
    assertEquals("fr", layerCaptor.getValue().getTargetLanguage());
    // Elements belonging to the layers that lost are not dragged along.
    verify(layerElementRepository, never()).save(any(LayerElement.class));
  }

  @Test
  public void testPersistImageDimensions_RecordsOriginalPixelSize() {
    Image image = new Image();
    image.setId(UUID.randomUUID());
    when(imageRepository.findById(image.getId())).thenReturn(java.util.Optional.of(image));

    pageService.persistImageDimensions(image.getId(), 1654, 2339);

    // The reader draws overlays in original-image coordinates; without these it scales them off
    // whatever variant it happens to be showing.
    assertEquals(1654, image.getWidth());
    assertEquals(2339, image.getHeight());
    verify(imageRepository, times(1)).save(image);
  }

  @Test
  public void testPersistImageDimensions_IgnoresNonPositiveDimensions() {
    UUID imageId = UUID.randomUUID();

    pageService.persistImageDimensions(imageId, 0, 2339);
    pageService.persistImageDimensions(imageId, 1654, -1);

    // A zero here would make the reader divide by it when scaling overlays.
    verify(imageRepository, never()).findById(any(UUID.class));
    verify(imageRepository, never()).save(any(Image.class));
  }

  @Test
  public void testGenerateAndSaveReaderVariant_WebpSourceServesTheOriginal() {
    Image image = new Image();
    image.setId(UUID.randomUUID());
    image.setStoragePath("originals/page.webp");
    when(imageRepository.findById(image.getId())).thenReturn(java.util.Optional.of(image));

    // RIFF....WEBP container header -- the sniff the code does instead of trusting the extension.
    byte[] webpBytes = new byte[16];
    System.arraycopy("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII), 0, webpBytes, 0, 4);
    System.arraycopy("WEBP".getBytes(java.nio.charset.StandardCharsets.US_ASCII), 0, webpBytes, 8, 4);

    pageService.generateAndSaveReaderVariant(image.getId(), "uuid-1", webpBytes);

    // Recording the original path rather than leaving null is what lets the backfill retire.
    assertEquals("originals/page.webp", image.getReaderStoragePath());
    verify(imageRepository, times(1)).save(image);
    verifyNoInteractions(minioService);
  }

  @Test
  public void testGenerateAndSaveReaderVariant_UndecodableBytesChangeNothing() {
    UUID imageId = UUID.randomUUID();

    pageService.generateAndSaveReaderVariant(imageId, "uuid-2", "not an image".getBytes());

    // No reader claimed the bytes. Leaving readerStoragePath null keeps the image eligible for a
    // later retry rather than pinning it to an original that may not decode either.
    verify(imageRepository, never()).save(any(Image.class));
    verifyNoInteractions(minioService);
  }

  @Test
  public void testGenerateAndSaveReaderVariant_SmallerVariantIsUploadedAndRecorded()
      throws Exception {
    Image image = new Image();
    image.setId(UUID.randomUUID());
    image.setStoragePath("originals/page.png");

    java.awt.image.BufferedImage source =
        new java.awt.image.BufferedImage(4, 4, java.awt.image.BufferedImage.TYPE_INT_RGB);
    java.io.ByteArrayOutputStream png = new java.io.ByteArrayOutputStream();
    javax.imageio.ImageIO.write(source, "png", png);

    // The native WebP writer is loaded from java.library.path; on a platform without it
    // encodeWebp returns null by design and there is no variant to assert on.
    boolean webpWriterRegistered =
        javax.imageio.ImageIO.getImageWritersByFormatName("webp").hasNext();
    if (webpWriterRegistered) {
      when(imageRepository.findById(image.getId())).thenReturn(java.util.Optional.of(image));
    }

    pageService.generateAndSaveReaderVariant(image.getId(), "uuid-3", png.toByteArray());

    if (webpWriterRegistered) {
      // Uploaded under the reader/ prefix and recorded, so the reader serves the smaller bytes
      // while the OCR overlays keep using the original's dimensions.
      verify(minioService, times(1))
          .uploadFile(eq("reader/uuid-3.webp"), any(byte[].class), eq("image/webp"));
      assertEquals("reader/uuid-3.webp", image.getReaderStoragePath());
      verify(imageRepository, times(1)).save(image);
    } else {
      assertNull(image.getReaderStoragePath());
      verifyNoInteractions(minioService);
    }
  }
}
