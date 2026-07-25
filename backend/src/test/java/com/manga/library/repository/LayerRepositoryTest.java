package com.manga.library.repository;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.TestcontainersConfig;
import com.manga.library.model.*;
import java.util.Optional;
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
public class LayerRepositoryTest {

  @Autowired private LayerRepository layerRepository;
  @Autowired private ImageRepository imageRepository;
  @Autowired private PageRepository pageRepository;
  @Autowired private ChapterRepository chapterRepository;
  @Autowired private SeriesRepository seriesRepository;

  @Test
  public void testLayerCRUD() {
    // Parent Image and Page
    Image image = new Image();
    image.setFilename("layer_img.png");
    image.setStoragePath("path/layer_img.png");
    Image savedImage = imageRepository.save(image);

    Series series = new Series();
    series.setTitle("Test");
    series.setOriginalLanguage("ja");
    series.setReadingDirection("rtl");
    Series savedSeries = seriesRepository.save(series);

    Chapter chapter = new Chapter();
    chapter.setSeries(savedSeries);
    chapter.setChapterNumber(1.0);
    Chapter savedChapter = chapterRepository.save(chapter);

    Page page = new Page();
    page.setChapter(savedChapter);
    page.setImage(savedImage);
    page.setPageNumber(1);
    Page savedPage = pageRepository.save(page);

    // 1. Create
    Layer layer = new Layer();
    layer.setPage(savedPage);
    layer.setType("translation");
    layer.setTargetLanguage("en");
    layer.setVisible(true);
    layer.setZOrder(5);

    Layer saved = layerRepository.save(layer);
    assertNotNull(saved.getId());
    assertEquals("translation", saved.getType());
    assertEquals("en", saved.getTargetLanguage());
    assertTrue(saved.getVisible());
    assertEquals(5, saved.getZOrder());
    assertEquals(savedPage.getId(), saved.getPage().getId());

    // 2. Read
    Optional<Layer> fetchedOpt = layerRepository.findById(saved.getId());
    assertTrue(fetchedOpt.isPresent());
    Layer fetched = fetchedOpt.get();
    assertEquals("translation", fetched.getType());

    // 3. Update
    fetched.setZOrder(10);
    fetched.setVisible(false);
    Layer updated = layerRepository.save(fetched);
    assertEquals(10, updated.getZOrder());
    assertFalse(updated.getVisible());

    // 4. Delete
    layerRepository.delete(updated);
    layerRepository.flush();

    Optional<Layer> deleted = layerRepository.findById(saved.getId());
    assertTrue(deleted.isEmpty());
  }
}
