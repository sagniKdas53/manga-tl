package com.manga.library.repository;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.model.*;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.test.context.ActiveProfiles;

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ActiveProfiles("test")
@SuppressWarnings({"null", "unchecked"})
public class PageRepositoryTest {

  @Autowired private PageRepository pageRepository;
  @Autowired private ChapterRepository chapterRepository;
  @Autowired private SeriesRepository seriesRepository;
  @Autowired private ImageRepository imageRepository;

  @Test
  public void testFindByChapterIdOrderByPageNumberAsc() {
    Series series =
        Series.builder()
            .title("Test Series Rep")
            .originalLanguage("ja")
            .sourceLanguage("ja")
            .targetLanguage("en")
            .readingDirection("rtl")
            .build();
    series = seriesRepository.save(series);

    Chapter chapter = Chapter.builder().chapterNumber(1.0).title("Ch 1").series(series).build();
    chapter = chapterRepository.save(chapter);

    Image img1 = Image.builder().filename("img1.png").storagePath("p1").hash("h1").build();
    img1 = imageRepository.save(img1);
    Image img2 = Image.builder().filename("img2.png").storagePath("p2").hash("h2").build();
    img2 = imageRepository.save(img2);

    Page p2 = Page.builder().chapter(chapter).pageNumber(2).image(img2).build();
    pageRepository.save(p2);
    Page p1 = Page.builder().chapter(chapter).pageNumber(1).image(img1).build();
    pageRepository.save(p1);

    List<Page> pages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapter.getId());
    assertEquals(2, pages.size());
    assertEquals(1, pages.get(0).getPageNumber());
    assertEquals(2, pages.get(1).getPageNumber());
  }

  @Autowired private PanelRepository panelRepository;
  @Autowired private OcrRegionRepository ocrRegionRepository;
  @Autowired private LayerRepository layerRepository;
  @Autowired private LayerElementRepository layerElementRepository;
  @Autowired private ConversationRepository conversationRepository;
  @Autowired private ConversationRegionRepository conversationRegionRepository;
  @Autowired private LayerEditHistoryRepository layerEditHistoryRepository;
  @Autowired private jakarta.persistence.EntityManager entityManager;

  @Test
  public void testDeletePageCascade() {
    Series series =
        Series.builder()
            .title("Delete Test Series")
            .originalLanguage("ja")
            .readingDirection("rtl")
            .build();
    series = seriesRepository.save(series);

    Chapter chapter = Chapter.builder().chapterNumber(1.0).title("Ch 1").series(series).build();
    chapter = chapterRepository.save(chapter);

    Image image = Image.builder().filename("test.png").storagePath("path/test.png").build();
    image = imageRepository.save(image);

    Page page = Page.builder().chapter(chapter).pageNumber(1).image(image).build();
    page = pageRepository.save(page);

    Panel panel =
        Panel.builder()
            .image(image)
            .bboxX(0)
            .bboxY(0)
            .bboxW(100)
            .bboxH(100)
            .readingOrder(1)
            .build();
    panel = panelRepository.save(panel);

    OcrRegion region =
        OcrRegion.builder()
            .image(image)
            .panel(panel)
            .bboxX(10)
            .bboxY(10)
            .bboxW(50)
            .bboxH(50)
            .detectedLanguage("ja")
            .build();
    region = ocrRegionRepository.save(region);

    Conversation conversation = Conversation.builder().image(image).sceneType("dialogue").build();
    conversation = conversationRepository.save(conversation);

    ConversationRegion convRegion =
        ConversationRegion.builder()
            .conversationId(conversation.getId())
            .regionId(region.getId())
            .position(1)
            .build();
    conversationRegionRepository.save(convRegion);

    Layer layer = Layer.builder().image(image).type("translation").build();
    layer = layerRepository.save(layer);

    LayerElement element =
        LayerElement.builder().layer(layer).region(region).x(10.0).y(10.0).build();
    element = layerElementRepository.save(element);

    LayerEditHistory history = LayerEditHistory.builder().layerElement(element).build();
    layerEditHistoryRepository.save(history);

    // Assert everything exists
    assertNotNull(pageRepository.findById(page.getId()).orElse(null));
    assertNotNull(imageRepository.findById(image.getId()).orElse(null));

    // Perform deletion mimicking PageService.deletePageDb
    pageRepository.delete(page);
    imageRepository.delete(image);
    pageRepository.flush();
    entityManager.clear();

    // Verify page and image are gone
    assertTrue(pageRepository.findById(page.getId()).isEmpty());
    assertTrue(imageRepository.findById(image.getId()).isEmpty());

    // Verify cascading deletions at database level
    assertTrue(panelRepository.findById(panel.getId()).isEmpty());
    assertTrue(ocrRegionRepository.findById(region.getId()).isEmpty());
    assertTrue(conversationRepository.findById(conversation.getId()).isEmpty());
    assertTrue(layerRepository.findById(layer.getId()).isEmpty());
    assertTrue(layerElementRepository.findById(element.getId()).isEmpty());
  }

  @Test
  public void testDeletePageAndResequence() {
    Series series =
        Series.builder().title("Resequence").originalLanguage("ja").readingDirection("rtl").build();
    series = seriesRepository.save(series);
    Chapter chapter = Chapter.builder().chapterNumber(1.0).title("Ch 1").series(series).build();
    chapter = chapterRepository.save(chapter);

    Image img1 = Image.builder().filename("1.png").storagePath("p1").build();
    img1 = imageRepository.save(img1);
    Image img2 = Image.builder().filename("2.png").storagePath("p2").build();
    img2 = imageRepository.save(img2);
    Image img3 = Image.builder().filename("3.png").storagePath("p3").build();
    img3 = imageRepository.save(img3);

    Page p1 = Page.builder().chapter(chapter).pageNumber(1).image(img1).build();
    pageRepository.save(p1);
    Page p2 = Page.builder().chapter(chapter).pageNumber(2).image(img2).build();
    pageRepository.save(p2);
    Page p3 = Page.builder().chapter(chapter).pageNumber(3).image(img3).build();
    pageRepository.save(p3);
    pageRepository.flush();

    // Now delete p1
    pageRepository.delete(p1);
    imageRepository.delete(img1);
    pageRepository.flush();

    // Re-sequence remaining pages
    List<Page> remaining = pageRepository.findByChapterIdOrderByPageNumberAsc(chapter.getId());
    for (int i = 0; i < remaining.size(); i++) {
      Page p = remaining.get(i);
      p.setPageNumber(i + 1);
      pageRepository.save(p);
    }
    pageRepository.flush();

    // Verify remaining pages have correct numbers
    List<Page> finalPages = pageRepository.findByChapterIdOrderByPageNumberAsc(chapter.getId());
    assertEquals(2, finalPages.size());
    assertEquals(1, finalPages.get(0).getPageNumber());
    assertEquals(2, finalPages.get(1).getPageNumber());
  }
}
