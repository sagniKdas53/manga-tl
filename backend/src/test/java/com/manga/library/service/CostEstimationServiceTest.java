package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.redis.core.ListOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.test.util.ReflectionTestUtils;

@ExtendWith(MockitoExtension.class)
public class CostEstimationServiceTest {

  @Mock private StringRedisTemplate redisTemplate;
  @Mock private ValueOperations<String, String> valueOperations;
  @Mock private ListOperations<String, String> listOperations;
  @Mock private HttpClient httpClient;
  @Mock private HttpResponse<String> httpResponse;

  private final ObjectMapper objectMapper = new ObjectMapper();
  private CostEstimationService costEstimationService;

  @TempDir Path tempDir;

  @BeforeEach
  public void setUp() {
    costEstimationService = new CostEstimationService(redisTemplate, objectMapper);
    ReflectionTestUtils.setField(
        costEstimationService, "costCachePath", tempDir.resolve("costs.json").toString());
    ReflectionTestUtils.setField(
        costEstimationService, "openrouterModelsUrl", "https://openrouter.ai/api/v1/models");
    ReflectionTestUtils.setField(costEstimationService, "httpClient", httpClient);
  }

  @Test
  public void testEstimateCost_NullOrEmptyModel() {
    assertNull(costEstimationService.estimateCost(null, 100, 100, "gemini"));
    assertNull(costEstimationService.estimateCost("", 100, 100, "gemini"));
    assertNull(costEstimationService.estimateCost("   ", 100, 100, "gemini"));
  }

  @Test
  public void testEstimateCost_OllamaOrLocalOrFree() {
    when(redisTemplate.opsForList()).thenReturn(listOperations);

    // Ollama
    Double costOllama =
        costEstimationService.estimateCost("google/gemini-2.5-flash", 100, 100, "ollama");
    assertNotNull(costOllama);
    assertEquals(0.0, costOllama);

    // Local
    Double costLocal =
        costEstimationService.estimateCost("google/gemini-2.5-flash", 100, 100, "local");
    assertNotNull(costLocal);
    assertEquals(0.0, costLocal);

    // Free model
    Double costFree =
        costEstimationService.estimateCost("google/gemini-flash:free", 100, 100, "openrouter");
    assertNotNull(costFree);
    assertEquals(0.0, costFree);

    verify(listOperations, times(3)).rightPush(eq("job_costs"), anyString());
  }

  @Test
  public void testEstimateCost_FromRedisCache() {
    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    when(redisTemplate.opsForList()).thenReturn(listOperations);
    when(valueOperations.get("model_cost:google/gemini-3.1-flash-lite"))
        .thenReturn("{\"prompt\": 0.00000025, \"completion\": 0.00000150}");

    Double cost =
        costEstimationService.estimateCost(
            "google/gemini-3.1-flash-lite", 1000, 2000, "openrouter");
    assertNotNull(cost);
    // 1000 * 0.00000025 + 2000 * 0.00000150 = 0.00025 + 0.003 = 0.00325
    assertEquals(0.00325, cost, 0.000001);
  }

  @Test
  public void testEstimateCost_FromFileCache() throws Exception {
    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    when(redisTemplate.opsForList()).thenReturn(listOperations);

    // Mock Redis empty
    when(valueOperations.get(anyString())).thenReturn(null);

    // Create file cache
    Path cacheFile = tempDir.resolve("costs.json");
    String cacheContent =
        "{\"google/gemini-3.1-flash-lite\":{\"prompt\":0.00000025,\"completion\":0.00000150}}";
    Files.writeString(cacheFile, cacheContent);

    Double cost =
        costEstimationService.estimateCost(
            "google/gemini-3.1-flash-lite", 1000, 2000, "openrouter");
    assertNotNull(cost);
    assertEquals(0.00325, cost, 0.000001);

    // Verify written to Redis
    verify(valueOperations).set(eq("model_cost:google/gemini-3.1-flash-lite"), anyString());
  }

  @Test
  public void testEstimateCost_GeminiFallback() {
    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    when(redisTemplate.opsForList()).thenReturn(listOperations);
    when(valueOperations.get(anyString())).thenReturn(null);

    // Gemini provider fallback: prompt=0.075, completion=0.30 per million
    Double cost =
        costEstimationService.estimateCost("google/gemini-2.5-flash", 1000000, 1000000, "gemini");
    assertNotNull(cost);
    assertEquals(0.375, cost, 0.000001);
  }

  @Test
  public void testEstimateCost_OpenRouterFallback() throws Exception {
    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    when(redisTemplate.opsForList()).thenReturn(listOperations);
    when(valueOperations.get(anyString())).thenReturn(null);

    // OpenRouter fallback: prompt=0.30, completion=2.50 per million
    // Mock the HTTP call for dynamic updates that occurs in fallback
    when(httpClient.send(any(HttpRequest.class), org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(httpResponse);
    when(httpResponse.statusCode()).thenReturn(200);
    when(httpResponse.body())
        .thenReturn(
            "{\"data\":[{\"id\":\"google/gemini-2.5-flash\",\"pricing\":{\"prompt\":0.00000030,\"completion\":0.00000250}}]}");

    Double cost =
        costEstimationService.estimateCost(
            "google/gemini-2.5-flash", 1000000, 1000000, "openrouter");
    assertNotNull(cost);
    assertEquals(2.80, cost, 0.000001);
  }

  @Test
  public void testUpdateModelCosts_Success() throws Exception {
    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    when(httpClient.send(any(HttpRequest.class), org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(httpResponse);
    when(httpResponse.statusCode()).thenReturn(200);
    when(httpResponse.body())
        .thenReturn(
            "{\"data\":[{\"id\":\"google/gemini-3.1-flash-lite\",\"pricing\":{\"prompt\":0.00000025,\"completion\":0.00000150}}]}");

    costEstimationService.updateModelCosts(List.of("google/gemini-3.1-flash-lite"));

    verify(valueOperations).set(eq("model_cost:google/gemini-3.1-flash-lite"), contains("1.5E-6"));

    // Verify file cache updated
    File file = new File(tempDir.resolve("costs.json").toString());
    assertTrue(file.exists());
    Map<?, ?> map = objectMapper.readValue(file, Map.class);
    assertTrue(map.containsKey("google/gemini-3.1-flash-lite"));
  }

  @Test
  public void testUpdateModelCosts_HttpError() throws Exception {
    when(httpClient.send(any(HttpRequest.class), org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(httpResponse);
    when(httpResponse.statusCode()).thenReturn(500);

    // Should not throw or crash, just log/handle
    assertDoesNotThrow(
        () -> costEstimationService.updateModelCosts(List.of("google/gemini-3.1-flash-lite")));
  }

  @Test
  public void testEstimateCost_Disabled() {
    System.setProperty("DISABLE_COST_CALCULATION", "true");
    try {
      when(redisTemplate.opsForList()).thenReturn(listOperations);
      Double cost =
          costEstimationService.estimateCost("google/gemini-2.5-flash", 1000000, 1000000, "gemini");
      assertNull(cost);
      verify(listOperations).rightPush(eq("job_costs"), contains("null"));
    } finally {
      System.clearProperty("DISABLE_COST_CALCULATION");
    }
  }

  @Test
  public void testEstimateCost_RedisGetException() {
    when(redisTemplate.opsForValue()).thenThrow(new RuntimeException("Redis down"));
    when(redisTemplate.opsForList()).thenReturn(listOperations);

    // Should fall back to Gemini fallback even if Redis throws
    Double cost =
        costEstimationService.estimateCost("google/gemini-2.5-flash", 1000000, 1000000, "gemini");
    assertNotNull(cost);
    assertEquals(0.375, cost, 0.000001);
  }

  @Test
  public void testEstimateCost_FileCacheException() {
    // If cache file path is invalid or causes security exception
    ReflectionTestUtils.setField(costEstimationService, "costCachePath", "\u0000invalid-path");
    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    when(redisTemplate.opsForList()).thenReturn(listOperations);
    when(valueOperations.get(anyString())).thenReturn(null);

    Double cost =
        costEstimationService.estimateCost("google/gemini-2.5-flash", 1000000, 1000000, "gemini");
    assertNotNull(cost);
    assertEquals(0.375, cost, 0.000001);
  }

  @Test
  public void testUpdateModelCosts_HttpClientException() throws Exception {
    when(httpClient.send(any(HttpRequest.class), org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenThrow(new java.io.IOException("Network timeout"));

    // Should handle exception gracefully
    assertDoesNotThrow(
        () -> costEstimationService.updateModelCosts(List.of("google/gemini-3.1-flash-lite")));
  }

  @Test
  public void testUpdateCaches_RedisException() throws Exception {
    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    // Throw exception when trying to save to Redis inside updateCaches
    doThrow(new RuntimeException("Redis write fail"))
        .when(valueOperations)
        .set(anyString(), anyString());

    when(httpClient.send(any(HttpRequest.class), org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(httpResponse);
    when(httpResponse.statusCode()).thenReturn(200);
    when(httpResponse.body())
        .thenReturn(
            "{\"data\":[{\"id\":\"google/gemini-3.1-flash-lite\",\"pricing\":{\"prompt\":0.00000025,\"completion\":0.00000150}}]}");

    // File writing should still complete successfully
    assertDoesNotThrow(
        () -> costEstimationService.updateModelCosts(List.of("google/gemini-3.1-flash-lite")));

    File file = new File(tempDir.resolve("costs.json").toString());
    assertTrue(file.exists());
  }

  @Test
  public void testUpdateCaches_FileExists() throws Exception {
    when(redisTemplate.opsForValue()).thenReturn(valueOperations);
    when(httpClient.send(any(HttpRequest.class), org.mockito.ArgumentMatchers.<HttpResponse.BodyHandler<String>>any()))
        .thenReturn(httpResponse);
    when(httpResponse.statusCode()).thenReturn(200);
    when(httpResponse.body())
        .thenReturn(
            "{\"data\":[{\"id\":\"google/gemini-3.1-flash-lite\",\"pricing\":{\"prompt\":0.00000025,\"completion\":0.00000150}}]}");

    Path cacheFile = tempDir.resolve("costs.json");
    String cacheContent = "{\"old-model\":{\"prompt\":0.1,\"completion\":0.2}}";
    Files.writeString(cacheFile, cacheContent);

    costEstimationService.updateModelCosts(List.of("google/gemini-3.1-flash-lite"));

    File file = new File(cacheFile.toString());
    assertTrue(file.exists());
    Map<?, ?> map = objectMapper.readValue(file, Map.class);
    assertTrue(map.containsKey("old-model"));
    assertTrue(map.containsKey("google/gemini-3.1-flash-lite"));
  }

  @Test
  public void testSaveJobCost_Exception() {
    when(redisTemplate.opsForList()).thenThrow(new RuntimeException("Redis error"));
    assertDoesNotThrow(
        () -> costEstimationService.estimateCost("google/gemini-2.5-flash", 10, 10, "ollama"));
  }

  @SuppressWarnings("unchecked")
  private <T> T mockGeneric(Class<?> clazz) {
      return (T) org.mockito.Mockito.mock(clazz);
  }

  @SuppressWarnings("unchecked")
  private <T> T anyGeneric(Class<?> clazz) {
      return (T) org.mockito.ArgumentMatchers.any(clazz);
  }
}
