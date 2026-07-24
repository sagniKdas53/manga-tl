package com.manga.library.controller;

import com.manga.library.dto.SystemSettingsDto;
import com.manga.library.service.SystemSettingsService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/settings")
public class SettingsController {

  private final SystemSettingsService systemSettingsService;
  public SettingsController(SystemSettingsService systemSettingsService) {
    this.systemSettingsService = systemSettingsService;
  }


  @GetMapping
  public ResponseEntity<SystemSettingsDto> getSettings() {
    return ResponseEntity.ok(systemSettingsService.getSettings());
  }

  @PutMapping
  public ResponseEntity<SystemSettingsDto> updateSettings(@RequestBody SystemSettingsDto dto) {
    return ResponseEntity.ok(systemSettingsService.updateSettings(dto));
  }
}
