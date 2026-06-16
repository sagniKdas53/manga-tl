package com.manga.library.dto;

import java.util.UUID;
import lombok.AllArgsConstructor;
import lombok.Data;

@Data
@AllArgsConstructor
public class AuthResponse {
  private String token;
  private UUID id;
  private String email;
  private String displayName;
  private String role;
}
