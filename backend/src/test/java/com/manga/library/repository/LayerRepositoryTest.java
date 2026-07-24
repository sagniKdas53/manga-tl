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
        new Image() {{ setFilename("layer_img.png"); setStoragePath("path/layer_img.png"); }};
    image = imageRepository.save(image);

    Series series =
        seriesRepository.save(
            new Series() {{ setTitle("Test"); setOriginalLanguage("ja"); setReadingDirection("rtl"); }});
    Chapter chapter =
        chapterRepository.save(new Chapter() {{ setSeries(series); setChapterNumber(1.0); }});

    com.manga.library.model.Page page =
        new com.manga.library.model.Page() {{ setChapter(chapter); setImage(image); setPageNumber(1); }};
    page = pageRepository.save(page);

    // 1. Create
    Layer layer =
        new Layer() {{ setPage(page); setType("translation"); setTargetLanguage("en"); setVisible(true); setZOrder(5); }};

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
