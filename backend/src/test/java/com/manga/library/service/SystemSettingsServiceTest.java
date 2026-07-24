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
@SuppressWarnings("null")
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
    assertEquals("openrouter", settings.ocrProvider());
    assertEquals("default-ocr-model", settings.ocrModel());
    assertEquals(2, settings.ocrVlmModelList().size());
    assertTrue(settings.ocrVlmModelList().contains("ocr1"));
    assertTrue(settings.ocrVlmModelList().contains("ocr2"));

    assertEquals("openrouter", settings.tlProvider());
    assertEquals("default-tl-model", settings.tlModel());
    assertEquals(2, settings.tlLlmModelList().size());

    assertEquals("openrouter", settings.qaProvider());
    assertEquals("default-qa-llm", settings.qaLlmModel());
    assertEquals("default-qa-vlm", settings.qaVlmModel());
  }

  @Test
  public void testGetSettings_FromRepository() {
    SystemSetting mockOcrProvider = new SystemSetting();
    mockOcrProvider.setSettingKey("ocrProvider");
    mockOcrProvider.setSettingValue("local");
    when(systemSettingsRepository.findById("ocrProvider")).thenReturn(Optional.of(mockOcrProvider));
    when(systemSettingsRepository.findById(argThat(key -> !key.equals("ocrProvider"))))
        .thenReturn(Optional.empty());

    SystemSettingsDto settings = systemSettingsService.getSettings();

    assertNotNull(settings);
    assertEquals("local", settings.ocrProvider());
    assertEquals("default-ocr-model", settings.ocrModel());
  }

  @Test
  public void testUpdateSettings() {
    SystemSettingsDto updateDto = new SystemSettingsDto(null, null, null, null, null, "local", "new-ocr-model", "gemini", "new-tl-model", "openai", "new-qa-llm", "new-qa-vlm", false, null, false, null, null, null, null);
    SystemSetting existingOcrProvider = new SystemSetting();
    existingOcrProvider.setSettingKey("ocrProvider");
    existingOcrProvider.setSettingValue("openrouter");
    when(systemSettingsRepository.findById("ocrProvider"))
        .thenReturn(Optional.of(existingOcrProvider));
    when(systemSettingsRepository.findById(argThat(key -> !key.equals("ocrProvider"))))
        .thenReturn(Optional.empty());

    SystemSettingsDto result = systemSettingsService.updateSettings(updateDto);

    assertNotNull(result);
    verify(systemSettingsRepository, atLeastOnce()).save(any(SystemSetting.class));
  }
}
