package com.manga.library.service;

import com.manga.library.dto.SystemSettingsDto;
import com.manga.library.model.SystemSetting;
import com.manga.library.repository.SystemSettingsRepository;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SystemSettingsService {

  private final SystemSettingsRepository systemSettingsRepository;
  public SystemSettingsService(SystemSettingsRepository systemSettingsRepository) {
    this.systemSettingsRepository = systemSettingsRepository;
  }


  private String defaultOcrProvider;

  private String defaultOcrModel;

  private String ocrVlmModelList;

  private String defaultTlProvider;

  private String defaultTlModel;

  private String tlLlmModelList;

  private String defaultQaProvider;

  private String defaultQaLlmModel;

  private String defaultQaVlmModel;

  private String qaLlmModelList;

  private String qaVlmModelList;

  private boolean disableLocalOcr;

  private String paddleOcrRecModel;

  private boolean disableLocalLlm;

  private String qaMode;

  private String openaiApiKey;

  private String anthropicApiKey;

  private String localLlmProvider;

  public SystemSettingsDto getSettings() {
    List<String> parsedOcrVlmModelList = parseList(ocrVlmModelList);
    List<String> parsedTlLlmModelList = parseList(tlLlmModelList);
    List<String> parsedQaLlmModelList = parseList(qaLlmModelList);
    List<String> parsedQaVlmModelList = parseList(qaVlmModelList);

    String actOcrModel = defaultOcrModel;
    if ((actOcrModel == null || actOcrModel.isEmpty()) && !parsedOcrVlmModelList.isEmpty())
      actOcrModel = parsedOcrVlmModelList.get(0);

    String actTlModel = defaultTlModel;
    if ((actTlModel == null || actTlModel.isEmpty()) && !parsedTlLlmModelList.isEmpty())
      actTlModel = parsedTlLlmModelList.get(0);

    String actQaLlmModel = defaultQaLlmModel;
    if ((actQaLlmModel == null || actQaLlmModel.isEmpty()) && !parsedQaLlmModelList.isEmpty())
      actQaLlmModel = parsedQaLlmModelList.get(0);

    String actQaVlmModel = defaultQaVlmModel;
    if ((actQaVlmModel == null || actQaVlmModel.isEmpty()) && !parsedQaVlmModelList.isEmpty())
      actQaVlmModel = parsedQaVlmModelList.get(0);

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

    return new SystemSettingsDto(
      parsedOcrVlmModelList,
      parsedTlLlmModelList,
      parsedQaLlmModelList,
      parsedQaVlmModelList,
      getSettingValue("routingStrategy", "lowest-cost"),
      getSettingValue("ocrProvider", defaultOcrProvider),
      getSettingValue("ocrModel", actOcrModel),
      getSettingValue("tlProvider", defaultTlProvider),
      getSettingValue("tlModel", actTlModel),
      getSettingValue("qaProvider", defaultQaProvider),
      getSettingValue("qaLlmModel", actQaLlmModel),
      getSettingValue("qaVlmModel", actQaVlmModel),
      disableLocalOcr,
      paddleOcrRecModel,
      disableLocalLlm,
      getSettingValue("qaMode", qaMode),
      Boolean.parseBoolean(getSettingValue("useFallbackModels", "true")),
      activeProviders,
      activeOcrProviders
    );
  }

  @Transactional
  public SystemSettingsDto updateSettings(SystemSettingsDto dto) {
    saveSetting("ocrProvider", dto.ocrProvider());
    saveSetting("ocrModel", dto.ocrModel());
    saveSetting("tlProvider", dto.tlProvider());
    saveSetting("tlModel", dto.tlModel());
    saveSetting("qaProvider", dto.qaProvider());
    saveSetting("qaLlmModel", dto.qaLlmModel());
    saveSetting("qaVlmModel", dto.qaVlmModel());
    saveSetting("routingStrategy", dto.routingStrategy());
    if (dto.useFallbackModels() != null) {
      saveSetting("useFallbackModels", String.valueOf(dto.useFallbackModels()));
    }

    return getSettings();
  }

  public String getSettingValue(String key, String defaultValue) {
    return systemSettingsRepository
        .findById(Objects.requireNonNull(key))
        .map(setting -> Objects.requireNonNull(setting).getSettingValue())
        .orElse(defaultValue);
  }

  private void saveSetting(String key, String value) {
    if (value == null) return;
    SystemSetting setting =
        systemSettingsRepository
            .findById(Objects.requireNonNull(key))
            .orElseGet(() -> {
              SystemSetting s = new SystemSetting();
              s.setSettingKey(key);
              return s;
            });
    setting.setSettingValue(value);
    systemSettingsRepository.save(Objects.requireNonNull(setting));
  }

  private List<String> parseList(String commaSeparated) {
    if (commaSeparated == null || commaSeparated.trim().isEmpty()) {
      return List.of();
    }
    return Arrays.stream(commaSeparated.split(","))
        .map(value -> Objects.requireNonNull(value).trim())
        .filter(s -> !s.isEmpty())
        .collect(Collectors.toList());
  }
}
