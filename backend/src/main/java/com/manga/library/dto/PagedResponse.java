package com.manga.library.dto;

import java.util.List;
import java.util.function.Function;
import org.springframework.data.domain.Page;

public record PagedResponse<T>(
    List<T> content, int page, int size, long totalElements, int totalPages) {

  public static <S, T> PagedResponse<T> from(Page<S> source, Function<S, T> mapper) {
    return new PagedResponse<>(
        source.getContent().stream().map(mapper).toList(),
        source.getNumber(),
        source.getSize(),
        source.getTotalElements(),
        source.getTotalPages());
  }
}
