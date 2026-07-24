package com.manga.library.dto;


public record ZipImageEntry(
  String name,
  byte[] bytes
) {
}
