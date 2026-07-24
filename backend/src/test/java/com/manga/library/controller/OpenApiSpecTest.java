package com.manga.library.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.TestcontainersConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("integration")
@Import(TestcontainersConfig.class)
public class OpenApiSpecTest {

  @Autowired private MockMvc mockMvc;

  @Autowired private ObjectMapper objectMapper;

  @Test
  void openApiSpec_isAccessible_andContainsAllCorePaths() throws Exception {
    MvcResult result = mockMvc.perform(get("/v3/api-docs")).andExpect(status().isOk()).andReturn();

    String jsonContent = result.getResponse().getContentAsString();
    JsonNode root = objectMapper.readTree(jsonContent);

    assertThat(root.has("openapi")).isTrue();
    assertThat(root.has("paths")).isTrue();

    JsonNode paths = root.get("paths");
    assertThat(paths.has("/api/series")).isTrue();
    assertThat(paths.has("/api/series/{seriesId}")).isTrue();
    assertThat(paths.has("/api/series/{seriesId}/chapters")).isTrue();
    assertThat(paths.has("/api/pages/{pageId}")).isTrue();
    assertThat(paths.has("/api/jobs")).isTrue();
    assertThat(paths.has("/api/settings")).isTrue();
  }
}
