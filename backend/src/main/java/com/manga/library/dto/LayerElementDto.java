package com.manga.library.dto;

import lombok.Data;

@Data
public class LayerElementDto {
  private String text;
  private String font;
  private Double size;
  private Boolean autoSize;
  private Integer maxWidth;
  private Integer maxHeight;
  private Boolean wordWrap;
  private Double rotation;
  private Double x;
  private Double y;
  private Boolean visible;
  private Boolean overflow;
  private String backgroundColor;
  private String textColor;
  private String fontWeight;
  private String fontStyle;
  private String boxShape;
  private String maskPolygon;
}
