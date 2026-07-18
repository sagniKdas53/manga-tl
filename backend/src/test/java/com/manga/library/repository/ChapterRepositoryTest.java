package com.manga.library.repository;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.model.Chapter;
import com.manga.library.model.Series;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.test.context.ActiveProfiles;

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ActiveProfiles("test")
@SuppressWarnings({"null", "unchecked", "rawtypes", "unused"})
public class ChapterRepositoryTest {

  @Autowired private ChapterRepository chapterRepository;
  @Autowired private SeriesRepository seriesRepository;

  @Test
  public void testChapterCRUD() {
    // Parent Series
    Series series =
        Series.builder()
            .title("Chapter Test Series")
            .originalLanguage("ja")
            .readingDirection("rtl")
            .build();
    series = seriesRepository.save(series);

    // 1. Create
    Chapter chapter =
        Chapter.builder().chapterNumber(2.5).title("Chapter Two Point Five").series(series).build();

    Chapter saved = chapterRepository.save(chapter);
    assertNotNull(saved.getId());
    assertEquals(2.5, saved.getChapterNumber());
    assertEquals("Chapter Two Point Five", saved.getTitle());
    assertEquals(series.getId(), saved.getSeries().getId());

    // 2. Read
    Optional<Chapter> fetchedOpt = chapterRepository.findById(saved.getId());
    assertTrue(fetchedOpt.isPresent());
    Chapter fetched = fetchedOpt.get();
    assertEquals("Chapter Two Point Five", fetched.getTitle());

    // 3. Update
    fetched.setTitle("Updated Chapter Title");
    Chapter updated = chapterRepository.save(fetched);
    assertEquals("Updated Chapter Title", updated.getTitle());

    // 4. Delete
    chapterRepository.delete(updated);
    chapterRepository.flush();

    Optional<Chapter> deleted = chapterRepository.findById(saved.getId());
    assertTrue(deleted.isEmpty());
  }
}
