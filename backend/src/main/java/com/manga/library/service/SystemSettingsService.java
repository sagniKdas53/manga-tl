package com.manga.library.service;

import com.manga.library.dto.SystemSettingsDto;
import com.manga.library.model.SystemSetting;
import com.manga.library.repository.SystemSettingsRepository;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class SystemSettingsService {

  private final SystemSettingsRepository systemSettingsRepository;

  @Value("${OCR_MODEL_PROVIDER:openrouter}")
  private String defaultOcrProvider;

  @Value("${OCR_VLM_MODEL:}")
  private String defaultOcrModel;

  @Value("${OCR_VLM_MODEL_LIST:}")
  private String ocrVlmModelList;

  @Value("${TL_MODEL_PROVIDER:openrouter}")
  private String defaultTlProvider;

  @Value("${TL_LLM_MODEL:}")
  private String defaultTlModel;

  @Value("${TL_LLM_MODEL_LIST:}")
  private String tlLlmModelList;

  @Value("${QA_MODEL_PROVIDER:openrouter}")
  private String defaultQaProvider;

  @Value("${QA_LLM_MODEL:}")
  private String defaultQaLlmModel;

  @Value("${QA_VLM_MODEL:}")
  private String defaultQaVlmModel;

  @Value("${QA_LLM_MODEL_LIST:}")
  private String qaLlmModelList;

  @Value("${QA_VLM_MODEL_LIST:}")
  private String qaVlmModelList;

  public SystemSettingsDto getSettings() {
    SystemSettingsDto dto = new SystemSettingsDto();

    dto.setOcrVlmModelList(parseList(ocrVlmModelList));
    dto.setTlLlmModelList(parseList(tlLlmModelList));
    dto.setQaLlmModelList(parseList(qaLlmModelList));
    dto.setQaVlmModelList(parseList(qaVlmModelList));

    dto.setOcrProvider(getSettingValue("ocrProvider", defaultOcrProvider));
    dto.setOcrModel(getSettingValue("ocrModel", defaultOcrModel));
    dto.setTlProvider(getSettingValue("tlProvider", defaultTlProvider));
    dto.setTlModel(getSettingValue("tlModel", defaultTlModel));
    dto.setQaProvider(getSettingValue("qaProvider", defaultQaProvider));
    dto.setQaLlmModel(getSettingValue("qaLlmModel", defaultQaLlmModel));
    dto.setQaVlmModel(getSettingValue("qaVlmModel", defaultQaVlmModel));

    return dto;
  }

  @Transactional
  public SystemSettingsDto updateSettings(SystemSettingsDto dto) {
    saveSetting("ocrProvider", dto.getOcrProvider());
    saveSetting("ocrModel", dto.getOcrModel());
    saveSetting("tlProvider", dto.getTlProvider());
    saveSetting("tlModel", dto.getTlModel());
    saveSetting("qaProvider", dto.getQaProvider());
    saveSetting("qaLlmModel", dto.getQaLlmModel());
    saveSetting("qaVlmModel", dto.getQaVlmModel());

    return getSettings();
  }

  public String getSettingValue(String key, String defaultValue) {
    return systemSettingsRepository.findById(key)
        .map(SystemSetting::getSettingValue)
        .orElse(defaultValue);
  }

  private void saveSetting(String key, String value) {
    if (value == null) return;
    SystemSetting setting = systemSettingsRepository.findById(key)
        .orElse(new SystemSetting(key, value, null));
    setting.setSettingValue(value);
    systemSettingsRepository.save(setting);
  }

  private List<String> parseList(String commaSeparated) {
    if (commaSeparated == null || commaSeparated.trim().isEmpty()) {
      return List.of();
    }
    return Arrays.stream(commaSeparated.split(","))
        .map(String::trim)
        .filter(s -> !s.isEmpty())
        .collect(Collectors.toList());
  }
}
