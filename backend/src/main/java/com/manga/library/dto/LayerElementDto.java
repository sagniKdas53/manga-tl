package com.manga.library.dto;


public record LayerElementDto(
  String text,
  String font,
  Double size,
  Boolean autoSize,
  Integer maxWidth,
  Integer maxHeight,
  Boolean wordWrap,
  Double rotation,
  Double x,
  Double y,
  Boolean visible,
  Boolean overflow,
  String backgroundColor,
  String textColor,
  String fontWeight,
  String fontStyle,
  String boxShape,
  String maskPolygon,
  java.util.UUID regionId
) {
}
