package com.manga.library.dto;

import java.util.List;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SystemSettingsDto {
  private List<String> ocrVlmModelList;
  private List<String> tlLlmModelList;
  private List<String> qaLlmModelList;
  private List<String> qaVlmModelList;

  private String ocrProvider;
  private String ocrModel;
  private String tlProvider;
  private String tlModel;
  private String qaProvider;
  private String qaLlmModel;
  private String qaVlmModel;

  private boolean disableLocalOcr;
  private String localOcrModel;
}
