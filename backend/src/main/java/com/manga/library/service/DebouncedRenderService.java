package com.manga.library.service;

import com.manga.library.model.Page;
import com.manga.library.repository.PageRepository;
import java.time.OffsetDateTime;
import java.util.List;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Slf4j
public class DebouncedRenderService {

  private final PageRepository pageRepository;
  private final JobCoordinatorService jobCoordinatorService;

  // Run every 30 seconds
  @Scheduled(fixedDelay = 30000)
  @Transactional
  public void processPendingRenders() {
    OffsetDateTime oneMinuteAgo = OffsetDateTime.now().minusMinutes(1);

    // Find pages that were edited more than a minute ago, and either never rendered or rendered
    // before the last edit
    List<Page> pages = pageRepository.findPagesNeedingRender(oneMinuteAgo);
    int triggeredCount = 0;

    for (Page page : pages) {
      log.info("Debounced render triggered for page: {}", page.getId());
      try {
        jobCoordinatorService.triggerPageRedo(page.getId(), "render");
        page.setLastRenderedAt(OffsetDateTime.now());
        pageRepository.save(page);
        triggeredCount++;
      } catch (Exception e) {
        log.error("Failed to enqueue debounced render for page: " + page.getId(), e);
      }
    }

    if (triggeredCount > 0) {
      log.info("Enqueued {} debounced render jobs", triggeredCount);
    }
  }
}

