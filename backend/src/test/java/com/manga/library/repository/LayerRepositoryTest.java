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
    Image image =
        Image.builder().filename("layer_img.png").storagePath("path/layer_img.png").build();
    image = imageRepository.save(image);

    Series series =
        seriesRepository.save(
            Series.builder().title("Test").originalLanguage("ja").readingDirection("rtl").build());
    Chapter chapter =
        chapterRepository.save(Chapter.builder().series(series).chapterNumber(1.0).build());

    com.manga.library.model.Page page =
        com.manga.library.model.Page.builder().chapter(chapter).image(image).pageNumber(1).build();
    page = pageRepository.save(page);

    // 1. Create
    Layer layer =
        Layer.builder()
            .page(page)
            .type("translation")
            .targetLanguage("en")
            .visible(true)
            .zOrder(5)
            .build();

    Layer saved = layerRepository.save(layer);
    assertNotNull(saved.getId());
    assertEquals("translation", saved.getType());
    assertEquals("en", saved.getTargetLanguage());
    assertTrue(saved.getVisible());
    assertEquals(5, saved.getZOrder());
    assertEquals(page.getId(), saved.getPage().getId());

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
