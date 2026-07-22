package com.manga.library.dto;

import java.util.List;
import java.util.UUID;
import lombok.Data;

@Data
public class PanelCallbackDto {
  private UUID imageId;
  private UUID pageId;
  private List<PanelData> panels;


  @Data
  public static class PanelData {
    private Integer x;
    private Integer y;
    private Integer width;
    private Integer height;
    private Integer gridRow;
    private Integer gridCol;
    private Integer readingOrder;
  }
}
