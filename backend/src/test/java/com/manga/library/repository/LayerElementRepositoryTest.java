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
public class LayerElementRepositoryTest {

  @Autowired private LayerElementRepository layerElementRepository;
  @Autowired private LayerRepository layerRepository;
  @Autowired private ImageRepository imageRepository;
  @Autowired private PageRepository pageRepository;
  @Autowired private ChapterRepository chapterRepository;
  @Autowired private SeriesRepository seriesRepository;

  @Test
  public void testLayerElementCRUD() {
    // Parent Image and Layer
    Image image = new Image();
    image.setFilename("el_img.png");
    image.setStoragePath("path/el_img.png");
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

    Layer layer = new Layer();
    layer.setPage(savedPage);
    layer.setType("translation");
    Layer savedLayer = layerRepository.save(layer);

    // 1. Create
    LayerElement element = new LayerElement();
    element.setLayer(savedLayer);
    element.setText("Hello World");
    element.setFont("Arial");
    element.setSize(14.0);
    element.setX(100.0);
    element.setY(200.0);
    element.setVisible(true);

    LayerElement saved = layerElementRepository.save(element);
    assertNotNull(saved.getId());
    assertEquals("Hello World", saved.getText());
    assertEquals("Arial", saved.getFont());
    assertEquals(14.0, saved.getSize());
    assertEquals(100.0, saved.getX());
    assertEquals(200.0, saved.getY());
    assertTrue(saved.getVisible());
    assertEquals(savedLayer.getId(), saved.getLayer().getId());

    // 2. Read
    Optional<LayerElement> fetchedOpt = layerElementRepository.findById(saved.getId());
    assertTrue(fetchedOpt.isPresent());
    LayerElement fetched = fetchedOpt.get();
    assertEquals("Hello World", fetched.getText());

    // 3. Update
    fetched.setText("Goodbye World");
    fetched.setX(150.0);
    LayerElement updated = layerElementRepository.save(fetched);
    assertEquals("Goodbye World", updated.getText());
    assertEquals(150.0, updated.getX());

    // 4. Delete
    layerElementRepository.delete(updated);
    layerElementRepository.flush();

    Optional<LayerElement> deleted = layerElementRepository.findById(saved.getId());
    assertTrue(deleted.isEmpty());
  }
}
