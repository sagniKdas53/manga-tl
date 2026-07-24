package com.manga.library.dto;

import java.util.UUID;

public record AuthResponse(
  String token,
  UUID id,
  String email,
  String displayName,
  String role
) {
}
