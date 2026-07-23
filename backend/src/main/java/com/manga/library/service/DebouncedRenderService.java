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
import com.manga.library.repository.JobRepository;
import com.manga.library.model.Job;

@Service
@RequiredArgsConstructor
@Slf4j
public class DebouncedRenderService {

  private final PageRepository pageRepository;
  private final JobCoordinatorService jobCoordinatorService;
  private final JobRepository jobRepository;

  // Run every 5 seconds
  @Scheduled(fixedDelay = 5000)
  @Transactional
  public void processPendingRenders() {
    OffsetDateTime threshold = OffsetDateTime.now().minusSeconds(10);

    // Find pages that were edited more than 10 seconds ago, and either never rendered or rendered
    // before the last edit
    List<Page> pages = pageRepository.findPagesNeedingRender(threshold);
    int triggeredCount = 0;

    for (Page page : pages) {
      // Skip if there's a recently-failed render job
      Job lastFailed = jobRepository.findFirstByImageIdAndTypeOrderByCreatedAtDesc(page.getImage().getId(), "render");
      if (lastFailed != null && "FAILED".equals(lastFailed.getStatus()) && lastFailed.getUpdatedAt() != null &&
          lastFailed.getUpdatedAt().isAfter(OffsetDateTime.now().minusMinutes(5))) {
          log.debug("Skipping render for page {} - recent failure within 5 minutes", page.getId());
          continue;
      }

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

