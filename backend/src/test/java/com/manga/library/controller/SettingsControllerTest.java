package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
import com.manga.library.dto.SystemSettingsDto;
import com.manga.library.service.SystemSettingsService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(SettingsController.class)
@AutoConfigureMockMvc(addFilters = false)
@SuppressWarnings({"null", "unchecked"})
public class SettingsControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockBean private SystemSettingsService systemSettingsService;
  @MockBean private JwtAuthFilter jwtAuthFilter;

  @Test
  public void testGetSettings() throws Exception {
    SystemSettingsDto settings = new SystemSettingsDto();
    settings.setOcrProvider("local");
    when(systemSettingsService.getSettings()).thenReturn(settings);

    mockMvc.perform(get("/api/settings")).andExpect(status().isOk());
    verify(systemSettingsService, times(1)).getSettings();
  }

  @Test
  public void testUpdateSettings() throws Exception {
    SystemSettingsDto settings = new SystemSettingsDto();
    settings.setOcrProvider("local");
    when(systemSettingsService.updateSettings(any(SystemSettingsDto.class))).thenReturn(settings);

    String json = "{\"ocrProvider\":\"local\"}";
    mockMvc
        .perform(put("/api/settings").contentType(MediaType.APPLICATION_JSON).content(json))
        .andExpect(status().isOk());
    verify(systemSettingsService, times(1)).updateSettings(any(SystemSettingsDto.class));
  }
}
