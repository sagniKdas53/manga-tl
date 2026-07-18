package com.manga.library.dto;

import lombok.AllArgsConstructor;
import lombok.Getter;

@Getter
@AllArgsConstructor
@SuppressWarnings("null")
public class ZipImageEntry {
  private final String name;
  private final byte[] bytes;
}
