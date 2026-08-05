package com.manga.library.dto;

import java.util.List;
import java.util.UUID;

/**
 * @param jobId the id of the job row this callback reports on, echoed back by the worker from the
 *     payload the backend enqueued. Resolving the row by id instead of guessing "newest job of this
 *     type for this image" is AUDIT-P5; null when the callback comes from a worker predating it.
 */
public record PanelCallbackDto(String jobId, UUID imageId, UUID pageId, List<PanelData> panels) {

  public record PanelData(
      Integer x,
      Integer y,
      Integer width,
      Integer height,
      Integer gridRow,
      Integer gridCol,
      Integer readingOrder) {}
}
