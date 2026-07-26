package com.manga.library.service;

import com.manga.library.dto.SystemSettingsDto;
import com.manga.library.model.SystemSetting;
import com.manga.library.repository.ChapterRepository;
import com.manga.library.repository.SeriesRepository;
import com.manga.library.repository.SystemSettingsRepository;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class SystemSettingsService {

  private final SystemSettingsRepository systemSettingsRepository;
  private final ProviderConfigCache providerConfigCache;
  private final SeriesRepository seriesRepository;
  private final ChapterRepository chapterRepository;

  public SystemSettingsService(
      SystemSettingsRepository systemSettingsRepository,
      ProviderConfigCache providerConfigCache,
      SeriesRepository seriesRepository,
      ChapterRepository chapterRepository) {
    this.systemSettingsRepository = systemSettingsRepository;
    this.providerConfigCache = providerConfigCache;
    this.seriesRepository = seriesRepository;
    this.chapterRepository = chapterRepository;
  }

  @org.springframework.beans.factory.annotation.Value("${OCR_MODEL_PROVIDER:openrouter}")
  private String defaultOcrProvider;

  @org.springframework.beans.factory.annotation.Value("${OCR_VLM_MODEL:}")
  private String defaultOcrModel;

  @org.springframework.beans.factory.annotation.Value("${OCR_VLM_MODEL_LIST:}")
  private String ocrVlmModelList;

  @org.springframework.beans.factory.annotation.Value("${TL_MODEL_PROVIDER:openrouter}")
  private String defaultTlProvider;

  @org.springframework.beans.factory.annotation.Value("${TL_LLM_MODEL:}")
  private String defaultTlModel;

  @org.springframework.beans.factory.annotation.Value("${TL_LLM_MODEL_LIST:}")
  private String tlLlmModelList;

  @org.springframework.beans.factory.annotation.Value("${QA_MODEL_PROVIDER:openrouter}")
  private String defaultQaProvider;

  @org.springframework.beans.factory.annotation.Value("${QA_LLM_MODEL:}")
  private String defaultQaLlmModel;

  @org.springframework.beans.factory.annotation.Value("${QA_VLM_MODEL:}")
  private String defaultQaVlmModel;

  @org.springframework.beans.factory.annotation.Value("${QA_LLM_MODEL_LIST:}")
  private String qaLlmModelList;

  @org.springframework.beans.factory.annotation.Value("${QA_VLM_MODEL_LIST:}")
  private String qaVlmModelList;

  @org.springframework.beans.factory.annotation.Value("${DISABLE_LOCAL_OCR:false}")
  private boolean disableLocalOcr;

  @org.springframework.beans.factory.annotation.Value("${PADDLEOCR_REC_MODEL:PP-OCRv6_medium_rec}")
  private String paddleOcrRecModel;

  @org.springframework.beans.factory.annotation.Value("${DISABLE_LOCAL_LLM:false}")
  private boolean disableLocalLlm;

  @org.springframework.beans.factory.annotation.Value("${QA_MODE:auto}")
  private String qaMode;

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

    List<String> activeProviders = providerConfigCache.getProvidersForTask("tl");

    List<String> activeOcrProviders = new java.util.ArrayList<>();
    if (!disableLocalOcr) {
      activeOcrProviders.add("local");
    }
    List<String> cachedOcr = providerConfigCache.getProvidersForTask("ocr");
    activeOcrProviders.addAll(cachedOcr);

    var providerModelsMap = providerConfigCache.getProviderModelsMap();

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
        activeOcrProviders,
        providerModelsMap);
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
            .orElseGet(
                () -> {
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

  public Map<String, Object> validateOverrides() {
    List<Map<String, Object>> orphaned = new java.util.ArrayList<>();
    if (seriesRepository != null) {
      for (com.manga.library.model.Series s : seriesRepository.findAll()) {
        checkOverride(
            orphaned,
            "SERIES",
            s.getId(),
            s.getTitle(),
            "tlModel",
            s.getTlModel(),
            s.getTlProvider(),
            "tl");
        checkOverride(
            orphaned,
            "SERIES",
            s.getId(),
            s.getTitle(),
            "ocrModel",
            s.getOcrModel(),
            s.getOcrProvider(),
            "ocr");
        checkOverride(
            orphaned,
            "SERIES",
            s.getId(),
            s.getTitle(),
            "qaLlmModel",
            s.getQaLlmModel(),
            s.getQaProvider(),
            "qaLLM");
        checkOverride(
            orphaned,
            "SERIES",
            s.getId(),
            s.getTitle(),
            "qaVlmModel",
            s.getQaVlmModel(),
            s.getQaProvider(),
            "qaVLM");
      }
    }
    if (chapterRepository != null) {
      for (com.manga.library.model.Chapter c : chapterRepository.findAll()) {
        String name = c.getTitle() != null ? c.getTitle() : "Chapter " + c.getChapterNumber();
        checkOverride(
            orphaned,
            "CHAPTER",
            c.getId(),
            name,
            "tlModel",
            c.getTlModel(),
            c.getTlProvider(),
            "tl");
        checkOverride(
            orphaned,
            "CHAPTER",
            c.getId(),
            name,
            "ocrModel",
            c.getOcrModel(),
            c.getOcrProvider(),
            "ocr");
        checkOverride(
            orphaned,
            "CHAPTER",
            c.getId(),
            name,
            "qaLlmModel",
            c.getQaLlmModel(),
            c.getQaProvider(),
            "qaLLM");
        checkOverride(
            orphaned,
            "CHAPTER",
            c.getId(),
            name,
            "qaVlmModel",
            c.getQaVlmModel(),
            c.getQaProvider(),
            "qaVLM");
      }
    }
    return Map.of("orphaned", orphaned);
  }

  private void checkOverride(
      List<Map<String, Object>> orphaned,
      String entityType,
      java.util.UUID entityId,
      String entityName,
      String field,
      String modelVal,
      String providerVal,
      String task) {
    if (modelVal != null
        && !modelVal.trim().isEmpty()
        && !modelVal.equals("inherit")
        && !modelVal.equals("default")) {
      String prov =
          providerVal != null && !providerVal.trim().isEmpty()
              ? providerVal
              : getSettingValue("tlProvider", "openrouter");
      if (providerConfigCache != null
          && !providerConfigCache.isValidProviderModel(prov, modelVal, task)) {
        Map<String, Object> entry = new java.util.HashMap<>();
        entry.put("entityType", entityType);
        entry.put("entityId", entityId != null ? entityId.toString() : "");
        entry.put("entityName", entityName);
        entry.put("field", field);
        entry.put("value", modelVal);
        entry.put("status", "DEPRECATED");
        orphaned.add(entry);
      }
    }
  }
}
