package com.manga.library.dto;

import java.util.List;
import java.util.Map;

public record SystemSettingsDto(
  List<String> ocrVlmModelList,
  List<String> tlLlmModelList,
  List<String> qaLlmModelList,
  List<String> qaVlmModelList,
  String routingStrategy,
  String ocrProvider,
  String ocrModel,
  String tlProvider,
  String tlModel,
  String qaProvider,
  String qaLlmModel,
  String qaVlmModel,
  boolean disableLocalOcr,
  String localOcrModel,
  boolean disableLocalLlm,
  String qaMode,
  Boolean useFallbackModels,
  List<String> activeProviders,
  List<String> activeOcrProviders,
  Map<String, Map<String, List<ModelEntryDto>>> providerModelsMap
) {
}
