package com.manga.library.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
@SuppressWarnings("null")
public class ChangePasswordRequest {
  @NotBlank private String currentPassword;

  @NotBlank
  @Size(min = 6)
  private String newPassword;
}
