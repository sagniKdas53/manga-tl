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
}
