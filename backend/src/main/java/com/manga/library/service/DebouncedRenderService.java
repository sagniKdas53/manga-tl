package com.manga.library.service;

import com.manga.library.model.Image;
import com.manga.library.repository.ImageRepository;
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
@SuppressWarnings("null")
public class DebouncedRenderService {

  private final ImageRepository imageRepository;
  private final JobCoordinatorService jobCoordinatorService;

  // Run every 30 seconds
  @Scheduled(fixedDelay = 30000)
  @Transactional
  public void processPendingRenders() {
    OffsetDateTime oneMinuteAgo = OffsetDateTime.now().minusMinutes(1);

    // Find images that were edited more than a minute ago, and either never rendered or rendered
    // before the last edit
    List<Image> images = imageRepository.findImagesNeedingRender(oneMinuteAgo);
    int triggeredCount = 0;

    for (Image img : images) {
      log.info("Debounced render triggered for image: {}", img.getId());
      try {
        jobCoordinatorService.triggerImageRedo(img.getId(), "render");
        img.setLastRenderedAt(OffsetDateTime.now());
        imageRepository.save(img);
        triggeredCount++;
      } catch (Exception e) {
        log.error("Failed to enqueue debounced render for image: " + img.getId(), e);
      }
    }

    if (triggeredCount > 0) {
      log.info("Enqueued {} debounced render jobs", triggeredCount);
    }
  }
}
