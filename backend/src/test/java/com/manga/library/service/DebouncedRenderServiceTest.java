package com.manga.library.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

import com.manga.library.model.Page;
import com.manga.library.repository.PageRepository;
import java.time.OffsetDateTime;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
@SuppressWarnings("null")
public class DebouncedRenderServiceTest {

  @Mock private PageRepository pageRepository;
  @Mock private JobCoordinatorService jobCoordinatorService;

  @InjectMocks private DebouncedRenderService debouncedRenderService;

  @BeforeEach
  void setUp() {
    // No setup needed
  }

  @Test
  void processPendingRenders_emptyList() {
    when(pageRepository.findPagesNeedingRender(any(OffsetDateTime.class)))
        .thenReturn(Collections.emptyList());

    debouncedRenderService.processPendingRenders();

    verify(jobCoordinatorService, never()).triggerPageRedo(any(), any());
    verify(pageRepository, never()).save(any());
  }

  @Test
  void processPendingRenders_triggersRenders() {
    Page page1 = new Page();
    page1.setId(UUID.randomUUID());
    Page page2 = new Page();
    page2.setId(UUID.randomUUID());

    when(pageRepository.findPagesNeedingRender(any(OffsetDateTime.class)))
        .thenReturn(List.of(page1, page2));

    debouncedRenderService.processPendingRenders();

    verify(jobCoordinatorService, times(2)).triggerPageRedo(any(), eq("render"));
    verify(pageRepository, times(2)).save(any());
  }
}