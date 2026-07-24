package com.manga.library.repository;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.TestcontainersConfig;
import com.manga.library.model.Series;
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
public class SeriesRepositoryTest {

  @Autowired private SeriesRepository seriesRepository;

  @Test
  public void testSeriesCRUD() {
    // 1. Create
    Series series =
        new Series() {{ setTitle("Test Series CRUD"); setOriginalLanguage("ja"); setSourceLanguage("ja"); setTargetLanguage("en"); setReadingDirection("rtl"); }};

    Series saved = seriesRepository.save(series);
    assertNotNull(saved.getId());
    assertEquals("Test Series CRUD", saved.getTitle());

    // 2. Read
    Optional<Series> fetchedOpt = seriesRepository.findById(saved.getId());
    assertTrue(fetchedOpt.isPresent());
    Series fetched = fetchedOpt.get();
    assertEquals("Test Series CRUD", fetched.getTitle());
    assertEquals("ja", fetched.getOriginalLanguage());

    // 3. Update
    fetched.setTitle("Updated Series Title");
    Series updated = seriesRepository.save(fetched);
    assertEquals("Updated Series Title", updated.getTitle());

    // 4. Delete
    seriesRepository.delete(updated);
    seriesRepository.flush();

    Optional<Series> deleted = seriesRepository.findById(saved.getId());
    assertTrue(deleted.isEmpty());
  }
}
