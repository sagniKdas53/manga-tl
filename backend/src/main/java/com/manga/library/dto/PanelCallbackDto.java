package com.manga.library.dto;

import java.util.List;
import java.util.UUID;

public record PanelCallbackDto(
  UUID imageId,
  UUID pageId,
  List<PanelData> panels
) {

  public record PanelData(
    Integer x,
    Integer y,
    Integer width,
    Integer height,
    Integer gridRow,
    Integer gridCol,
    Integer readingOrder
  ) {}
}
