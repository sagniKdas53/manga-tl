package com.manga.library.dto;

import lombok.Data;

@Data
public class RegisterRequest {
    private String email;
    private String password;
    private String displayName;
}
