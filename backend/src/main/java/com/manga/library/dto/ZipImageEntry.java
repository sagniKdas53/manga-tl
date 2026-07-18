package com.manga.library.dto;

import lombok.AllArgsConstructor;
import lombok.Getter;

@Getter
@AllArgsConstructor
public class ZipImageEntry {
  private final String name;
  private final byte[] bytes;
}
