import re

filepath = "/home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/service/SystemSettingsService.java"
with open(filepath, "r") as f:
    content = f.read()

# Let's just manually replace the entire getSettings and updateSettings block
# using string manipulation.

start_marker = "public SystemSettingsDto getSettings() {"
end_marker = "  public String getSettingValue(String key, String defaultValue) {"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

new_methods = """public SystemSettingsDto getSettings() {
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

"""

new_content = content[:start_idx] + new_methods + content[end_idx:]

with open(filepath, "w") as f:
    f.write(new_content)
