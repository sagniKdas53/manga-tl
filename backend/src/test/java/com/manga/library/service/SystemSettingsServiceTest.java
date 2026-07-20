package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.manga.library.dto.SystemSettingsDto;
import com.manga.library.model.SystemSetting;
import com.manga.library.repository.SystemSettingsRepository;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

@ExtendWith(MockitoExtension.class)
@SuppressWarnings({"null", "unchecked"})
public class SystemSettingsServiceTest {

  @Mock private SystemSettingsRepository systemSettingsRepository;

  private SystemSettingsService systemSettingsService;

  @BeforeEach
  public void setUp() {
    systemSettingsService = new SystemSettingsService(systemSettingsRepository);

    // Set @Value properties via ReflectionTestUtils
    ReflectionTestUtils.setField(systemSettingsService, "defaultOcrProvider", "openrouter");
    ReflectionTestUtils.setField(systemSettingsService, "defaultOcrModel", "default-ocr-model");
    ReflectionTestUtils.setField(systemSettingsService, "ocrVlmModelList", "ocr1, ocr2");

    ReflectionTestUtils.setField(systemSettingsService, "defaultTlProvider", "openrouter");
    ReflectionTestUtils.setField(systemSettingsService, "defaultTlModel", "default-tl-model");
    ReflectionTestUtils.setField(systemSettingsService, "tlLlmModelList", "tl1, tl2");

    ReflectionTestUtils.setField(systemSettingsService, "defaultQaProvider", "openrouter");
    ReflectionTestUtils.setField(systemSettingsService, "defaultQaLlmModel", "default-qa-llm");
    ReflectionTestUtils.setField(systemSettingsService, "defaultQaVlmModel", "default-qa-vlm");
    ReflectionTestUtils.setField(systemSettingsService, "qaLlmModelList", "qa-llm1, qa-llm2");
    ReflectionTestUtils.setField(systemSettingsService, "qaVlmModelList", "qa-vlm1, qa-vlm2");
  }

  @Test
  public void testGetSettings_DefaultFallback() {
    when(systemSettingsRepository.findById(anyString())).thenReturn(Optional.empty());

    SystemSettingsDto settings = systemSettingsService.getSettings();

    assertNotNull(settings);
    assertEquals("openrouter", settings.getOcrProvider());
    assertEquals("default-ocr-model", settings.getOcrModel());
    assertEquals(2, settings.getOcrVlmModelList().size());
    assertTrue(settings.getOcrVlmModelList().contains("ocr1"));
    assertTrue(settings.getOcrVlmModelList().contains("ocr2"));

    assertEquals("openrouter", settings.getTlProvider());
    assertEquals("default-tl-model", settings.getTlModel());
    assertEquals(2, settings.getTlLlmModelList().size());

    assertEquals("openrouter", settings.getQaProvider());
    assertEquals("default-qa-llm", settings.getQaLlmModel());
    assertEquals("default-qa-vlm", settings.getQaVlmModel());
  }

  @Test
  public void testGetSettings_FromRepository() {
    SystemSetting mockOcrProvider = new SystemSetting("ocrProvider", "local", null);
    when(systemSettingsRepository.findById("ocrProvider")).thenReturn(Optional.of(mockOcrProvider));
    when(systemSettingsRepository.findById(argThat(key -> !key.equals("ocrProvider"))))
        .thenReturn(Optional.empty());

    SystemSettingsDto settings = systemSettingsService.getSettings();

    assertNotNull(settings);
    assertEquals("local", settings.getOcrProvider());
    assertEquals("default-ocr-model", settings.getOcrModel());
  }

  @Test
  public void testUpdateSettings() {
    SystemSettingsDto updateDto = new SystemSettingsDto();
    updateDto.setOcrProvider("local");
    updateDto.setOcrModel("new-ocr-model");
    updateDto.setTlProvider("gemini");
    updateDto.setTlModel("new-tl-model");
    updateDto.setQaProvider("openai");
    updateDto.setQaLlmModel("new-qa-llm");
    updateDto.setQaVlmModel("new-qa-vlm");

    SystemSetting existingOcrProvider = new SystemSetting("ocrProvider", "openrouter", null);
    when(systemSettingsRepository.findById("ocrProvider"))
        .thenReturn(Optional.of(existingOcrProvider));
    when(systemSettingsRepository.findById(argThat(key -> !key.equals("ocrProvider"))))
        .thenReturn(Optional.empty());

    SystemSettingsDto result = systemSettingsService.updateSettings(updateDto);

    assertNotNull(result);
    verify(systemSettingsRepository, atLeastOnce()).save(any(SystemSetting.class));
  }
}
