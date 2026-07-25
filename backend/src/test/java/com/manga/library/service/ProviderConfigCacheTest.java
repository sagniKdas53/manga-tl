package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.dto.ModelEntryDto;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

@ExtendWith(MockitoExtension.class)
@SuppressWarnings("null")
public class ProviderConfigCacheTest {

  @Mock private StringRedisTemplate redisTemplate;
  @Mock private ValueOperations<String, String> valueOperations;

  private ObjectMapper objectMapper = new ObjectMapper();
  private ProviderConfigCache providerConfigCache;

  @BeforeEach
  public void setUp() {
    providerConfigCache = new ProviderConfigCache(redisTemplate, objectMapper);
  }

  @Test
  public void testReload_WithValidJson() {
    String mockJson =
        """
        {
          "version": 1,
          "providers": {
            "openrouter": {
              "displayName": "OpenRouter",
              "type": "openai-compatible",
              "freeTier": false,
              "priority": 1,
              "models": {
                "tl": [
                  {"id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro", "free": false},
                  {"id": "google/gemini-2.5-flash:free", "name": "Gemini Free", "free": true}
                ]
              },
              "defaults": {"tl": "deepseek/deepseek-v4-pro"},
              "capabilities": ["tl"]
            },
            "gemini": {
              "displayName": "Google AI Studio",
              "freeTier": true,
              "priority": 2,
              "models": {
                "tl": [{"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "free": false}]
              },
              "capabilities": ["tl"]
            }
          }
        }
        """;

    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    when(valueOperations.get("system:providers:config")).thenReturn(mockJson);

    providerConfigCache.reload();

    List<String> tlProviders = providerConfigCache.getProvidersForTask("tl");
    assertEquals(2, tlProviders.size());
    assertEquals("openrouter", tlProviders.get(0));
    assertEquals("gemini", tlProviders.get(1));

    assertTrue(
        providerConfigCache.isValidProviderModel("openrouter", "deepseek/deepseek-v4-pro", "tl"));
    assertFalse(providerConfigCache.isValidProviderModel("openrouter", "invalid-model", "tl"));
    assertFalse(
        providerConfigCache.isValidProviderModel(
            "openrouter [ORPHANED]", "deepseek/deepseek-v4-pro", "tl"));

    assertTrue(providerConfigCache.isFreeTier("gemini"));
    assertFalse(providerConfigCache.isFreeTier("openrouter"));

    assertTrue(providerConfigCache.isModelFree("openrouter", "google/gemini-2.5-flash:free"));
    assertFalse(providerConfigCache.isModelFree("openrouter", "deepseek/deepseek-v4-pro"));

    Map<String, Map<String, List<ModelEntryDto>>> modelMap =
        providerConfigCache.getProviderModelsMap();
    assertNotNull(modelMap);
    assertTrue(modelMap.containsKey("openrouter"));
  }

  @Test
  public void testReload_WithEmptyRedisKey() {
    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    when(valueOperations.get("system:providers:config")).thenReturn(null);

    providerConfigCache.reload();

    List<String> providers = providerConfigCache.getProvidersForTask("tl");
    assertTrue(providers.isEmpty());
    // Empty cache does not fail validation
    assertTrue(providerConfigCache.isValidProviderModel("openrouter", "some-model", "tl"));
  }
}
