package com.manga.library.repository;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.TestcontainersConfig;
import com.manga.library.model.*;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ActiveProfiles("integration")
@Import(TestcontainersConfig.class)
@SuppressWarnings("null")
public class PageRepositoryTest {

  @Autowired private PageRepository pageRepository;
  @Autowired private ChapterRepository chapterRepository;
  @Autowired private SeriesRepository seriesRepository;
  @Autowired private ImageRepository imageRepository;

  @Test
  public void testFindByChapterIdOrderByPageNumberAsc() {
    Series series =
        new Series() {{ setTitle("Test Series Rep"); setOriginalLanguage("ja"); setSourceLanguage("ja"); setTargetLanguage("en"); setReadingDirection("rtl"); }};
    series = seriesRepository.save(series);

    Chapter chapter = new Chapter() {{ setChapterNumber(1.0); setTitle("Ch 1"); setSeries(series); }};
    chapter = chapterRepository.save(chapter);

    Image img1 = new Image() {{ setFilename("img1.png"); setStoragePath("p1"); setHash("h1"); }};
    img1 = imageRepository.save(img1);
    Image img2 = new Image() {{ setFilename("img2.png"); setStoragePath("p2"); setHash("h2"); }};
    img2 = imageRepository.save(img2);

    Page p2 = new Page() {{ setChapter(chapter); setPageNumber(2); setImage(img2); }};
    pageRepository.save(p2);
    Page p1 = new Page() {{ setChapter(chapter); setPageNumber(1); setImage(img1); }};
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
        new Series() {{ setTitle("Delete Test Series"); setOriginalLanguage("ja"); setReadingDirection("rtl"); }};
    series = seriesRepository.save(series);

    Chapter chapter = new Chapter() {{ setChapterNumber(1.0); setTitle("Ch 1"); setSeries(series); }};
    chapter = chapterRepository.save(chapter);

    Image image = new Image() {{ setFilename("test.png"); setStoragePath("path/test.png"); }};
    image = imageRepository.save(image);

    Page page = new Page() {{ setChapter(chapter); setPageNumber(1); setImage(image); }};
    page = pageRepository.save(page);

    Panel panel =
        new Panel() {{ setImage(image); setBboxX(0); setBboxY(0); setBboxW(100); setBboxH(100); setReadingOrder(1); }};
    panel = panelRepository.save(panel);

    OcrRegion region =
        new OcrRegion() {{ setPage(page); setPanel(panel); setBboxX(10); setBboxY(10); setBboxW(50); setBboxH(50); setDetectedLanguage("ja"); }};
    region = ocrRegionRepository.save(region);

    Conversation conversation = new Conversation() {{ setPage(page); setSceneType("dialogue"); }};
    conversation = conversationRepository.save(conversation);

    ConversationRegion convRegion =
        new ConversationRegion() {{ setConversationId(conversation.getId()); setRegionId(region.getId()); setPosition(1); }};
    conversationRegionRepository.save(convRegion);

    Layer layer = new Layer() {{ setPage(page); setType("translation"); }};
    layer = layerRepository.save(layer);

    LayerElement element =
        new LayerElement() {{ setLayer(layer); setRegion(region); setX(10.0); setY(10.0); }};
    element = layerElementRepository.save(element);

    LayerEditHistory history = new LayerEditHistory() {{ setLayerElement(element); }};
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
        new Series() {{ setTitle("Resequence"); setOriginalLanguage("ja"); setReadingDirection("rtl"); }};
    series = seriesRepository.save(series);
    Chapter chapter = new Chapter() {{ setChapterNumber(1.0); setTitle("Ch 1"); setSeries(series); }};
    chapter = chapterRepository.save(chapter);

    Image img1 = new Image() {{ setFilename("1.png"); setStoragePath("p1"); }};
    img1 = imageRepository.save(img1);
    Image img2 = new Image() {{ setFilename("2.png"); setStoragePath("p2"); }};
    img2 = imageRepository.save(img2);
    Image img3 = new Image() {{ setFilename("3.png"); setStoragePath("p3"); }};
    img3 = imageRepository.save(img3);

    Page p1 = new Page() {{ setChapter(chapter); setPageNumber(1); setImage(img1); }};
    pageRepository.save(p1);
    Page p2 = new Page() {{ setChapter(chapter); setPageNumber(2); setImage(img2); }};
    pageRepository.save(p2);
    Page p3 = new Page() {{ setChapter(chapter); setPageNumber(3); setImage(img3); }};
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
