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
@SuppressWarnings("null")
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

  @Value("${DISABLE_LOCAL_OCR:false}")
  private boolean disableLocalOcr;

  @Value("${PADDLEOCR_REC_MODEL:PP-OCRv6_medium_rec}")
  private String paddleOcrRecModel;

  @Value("${DISABLE_LOCAL_LLM:false}")
  private boolean disableLocalLlm;

  @Value("${QA_MODE:auto}")
  private String qaMode;

  @Value("${OPENAI_API_KEY:}")
  private String openaiApiKey;

  @Value("${ANTHROPIC_API_KEY:}")
  private String anthropicApiKey;

  @Value("${LOCAL_LLM_PROVIDER:ollama}")
  private String localLlmProvider;

  public SystemSettingsDto getSettings() {
    SystemSettingsDto dto = new SystemSettingsDto();

    dto.setOcrVlmModelList(parseList(ocrVlmModelList));
    dto.setTlLlmModelList(parseList(tlLlmModelList));
    dto.setQaLlmModelList(parseList(qaLlmModelList));
    dto.setQaVlmModelList(parseList(qaVlmModelList));

    String actOcrModel = defaultOcrModel;
    if ((actOcrModel == null || actOcrModel.isEmpty()) && !dto.getOcrVlmModelList().isEmpty())
      actOcrModel = dto.getOcrVlmModelList().get(0);

    String actTlModel = defaultTlModel;
    if ((actTlModel == null || actTlModel.isEmpty()) && !dto.getTlLlmModelList().isEmpty())
      actTlModel = dto.getTlLlmModelList().get(0);

    String actQaLlmModel = defaultQaLlmModel;
    if ((actQaLlmModel == null || actQaLlmModel.isEmpty()) && !dto.getQaLlmModelList().isEmpty())
      actQaLlmModel = dto.getQaLlmModelList().get(0);

    String actQaVlmModel = defaultQaVlmModel;
    if ((actQaVlmModel == null || actQaVlmModel.isEmpty()) && !dto.getQaVlmModelList().isEmpty())
      actQaVlmModel = dto.getQaVlmModelList().get(0);

    dto.setOcrProvider(getSettingValue("ocrProvider", defaultOcrProvider));
    dto.setOcrModel(getSettingValue("ocrModel", actOcrModel));
    dto.setTlProvider(getSettingValue("tlProvider", defaultTlProvider));
    dto.setTlModel(getSettingValue("tlModel", actTlModel));
    dto.setQaProvider(getSettingValue("qaProvider", defaultQaProvider));
    dto.setQaLlmModel(getSettingValue("qaLlmModel", actQaLlmModel));
    dto.setQaVlmModel(getSettingValue("qaVlmModel", actQaVlmModel));

    dto.setDisableLocalOcr(disableLocalOcr);
    dto.setLocalOcrModel(paddleOcrRecModel);

    dto.setDisableLocalLlm(disableLocalLlm);
    dto.setQaMode(getSettingValue("qaMode", qaMode));

    List<String> activeProviders = new java.util.ArrayList<>();
    activeProviders.add("openrouter");
    activeProviders.add("gemini");
    activeProviders.add("nvidia");
    if (openaiApiKey != null && !openaiApiKey.trim().isEmpty()) {
      activeProviders.add("openai");
    }
    if (anthropicApiKey != null && !anthropicApiKey.trim().isEmpty()) {
      activeProviders.add("anthropic");
    }
    if (!disableLocalLlm) {
      String localProv =
          (localLlmProvider != null) ? localLlmProvider.trim().toLowerCase() : "ollama";
      if ("ollama".equals(localProv)) {
        activeProviders.add("ollama");
      } else if ("lmstudio".equals(localProv)) {
        activeProviders.add("lmstudio");
      } else {
        activeProviders.add("ollama");
        activeProviders.add("lmstudio");
      }
    }
    dto.setActiveProviders(activeProviders);

    List<String> activeOcrProviders = new java.util.ArrayList<>();
    if (!disableLocalOcr) {
      activeOcrProviders.add("local");
    }
    activeOcrProviders.add("openrouter");
    activeOcrProviders.add("gemini");
    activeOcrProviders.add("nvidia");
    if (!disableLocalLlm) {
      String localProv =
          (localLlmProvider != null) ? localLlmProvider.trim().toLowerCase() : "ollama";
      if ("ollama".equals(localProv)) {
        activeOcrProviders.add("ollama");
      } else if ("lmstudio".equals(localProv)) {
        activeOcrProviders.add("lmstudio");
      } else {
        activeOcrProviders.add("ollama");
        activeOcrProviders.add("lmstudio");
      }
    }
    dto.setActiveOcrProviders(activeOcrProviders);

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
    return systemSettingsRepository
        .findById(key)
        .map(SystemSetting::getSettingValue)
        .orElse(defaultValue);
  }

  private void saveSetting(String key, String value) {
    if (value == null) return;
    SystemSetting setting =
        systemSettingsRepository.findById(key).orElse(new SystemSetting(key, value, null));
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
