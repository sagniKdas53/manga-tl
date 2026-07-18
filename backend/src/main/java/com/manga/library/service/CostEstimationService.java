package com.manga.library.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
@Slf4j
@SuppressWarnings("null")
public class CostEstimationService {

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;

  @Value("${cost.cache-path:costs.json}")
  private String costCachePath;

  @Value("${cost.openrouter-models-url:https://openrouter.ai/api/v1/models}")
  private String openrouterModelsUrl;

  private final HttpClient httpClient =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

  public Double estimateCost(
      String model, int promptTokens, int completionTokens, String provider) {
    if (model == null || model.trim().isEmpty()) {
      return null;
    }

    // Bypass if DISABLE_COST_CALCULATION is set to true
    String disableFlag = System.getProperty("DISABLE_COST_CALCULATION");
    if (disableFlag == null) {
      disableFlag = System.getenv("DISABLE_COST_CALCULATION");
    }
    if ("true".equalsIgnoreCase(disableFlag)) {
      saveJobCost(null);
      return null;
    }

    // Free or local models are zero-cost
    if ("ollama".equalsIgnoreCase(provider)
        || "local".equalsIgnoreCase(provider)
        || model.contains(":free")) {
      saveJobCost(0.0);
      return 0.0;
    }

    // Get pricing from cache (Redis, File, or fetch)
    Map<String, Double> rates = getModelRates(model, provider);
    if (rates == null) {
      saveJobCost(null);
      return null;
    }

    double promptPrice = rates.getOrDefault("prompt", 0.0);
    double completionPrice = rates.getOrDefault("completion", 0.0);

    double cost = (promptTokens * promptPrice) + (completionTokens * completionPrice);
    saveJobCost(cost);
    return cost;
  }

  private void saveJobCost(Double cost) {
    try {
      Map<String, Object> jobCost = new HashMap<>();
      jobCost.put("estimated_cost", cost);
      redisTemplate.opsForList().rightPush("job_costs", objectMapper.writeValueAsString(jobCost));
    } catch (Exception e) {
      log.debug("Failed to record job cost to Redis", e);
    }
  }

  private Map<String, Double> getModelRates(String model, String provider) {
    // 1. Try Redis first
    String redisKey = "model_cost:" + model;
    try {
      String cachedCost = redisTemplate.opsForValue().get(redisKey);
      if (cachedCost != null) {
        JsonNode node = objectMapper.readTree(cachedCost);
        return Map.of(
            "prompt", node.get("prompt").asDouble(),
            "completion", node.get("completion").asDouble());
      }
    } catch (Exception e) {
      log.debug("Redis cache read failed for {}", model, e);
    }

    // 2. Try Local File Cache
    try {
      File file = new File(costCachePath);
      if (file.exists()) {
        JsonNode rootNode = objectMapper.readTree(file);
        if (rootNode.has(model)) {
          JsonNode modelNode = rootNode.get(model);
          Map<String, Double> rates =
              Map.of(
                  "prompt", modelNode.get("prompt").asDouble(),
                  "completion", modelNode.get("completion").asDouble());
          // Cache in Redis for fast access
          cacheInRedis(model, rates.get("prompt"), rates.get("completion"));
          return rates;
        }
      }
    } catch (Exception e) {
      log.debug("File cache read failed", e);
    }

    // 3. Fallbacks
    if ("gemini".equalsIgnoreCase(provider)) {
      // Fallback cost: prompt=0.075, completion=0.30 per million
      Map<String, Double> rates =
          Map.of(
              "prompt", 0.075 / 1_000_000.0,
              "completion", 0.30 / 1_000_000.0);
      cacheInRedis(model, rates.get("prompt"), rates.get("completion"));
      return rates;
    }

    if ("openrouter".equalsIgnoreCase(provider)) {
      // Fallback cost: prompt=0.30, completion=2.50 per million
      Map<String, Double> rates =
          Map.of(
              "prompt", 0.30 / 1_000_000.0,
              "completion", 2.50 / 1_000_000.0);
      // Attempt dynamic update in background/sync when hitting fallback
      updateModelCosts(List.of(model));
      return rates;
    }

    return null;
  }

  public void updateModelCosts(List<String> models) {
    try {
      HttpRequest request =
          HttpRequest.newBuilder().uri(URI.create(openrouterModelsUrl)).GET().build();

      HttpResponse<String> response =
          httpClient.send(request, HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() == 200) {
        JsonNode root = objectMapper.readTree(response.body());
        JsonNode dataNode = root.get("data");
        if (dataNode != null && dataNode.isArray()) {
          Map<String, Map<String, Double>> newCosts = new HashMap<>();
          for (JsonNode mNode : dataNode) {
            String modelId = mNode.get("id").asText();
            if (models.contains(modelId)) {
              JsonNode pricing = mNode.get("pricing");
              if (pricing != null) {
                double prompt = pricing.get("prompt").asDouble();
                double completion = pricing.get("completion").asDouble();
                newCosts.put(modelId, Map.of("prompt", prompt, "completion", completion));
              }
            }
          }

          if (!newCosts.isEmpty()) {
            updateCaches(newCosts);
          }
        }
      }
    } catch (Exception e) {
      log.warn("Failed to fetch dynamic model pricing from OpenRouter API", e);
    }
  }

  private void updateCaches(Map<String, Map<String, Double>> newCosts) {
    // Cache in Redis and update File
    File file = new File(costCachePath);
    ObjectNode rootNode = objectMapper.createObjectNode();
    try {
      if (file.exists()) {
        JsonNode existing = objectMapper.readTree(file);
        if (existing.isObject()) {
          rootNode.setAll((ObjectNode) existing);
        }
      }

      for (Map.Entry<String, Map<String, Double>> entry : newCosts.entrySet()) {
        String model = entry.getKey();
        double prompt = entry.getValue().get("prompt");
        double completion = entry.getValue().get("completion");

        cacheInRedis(model, prompt, completion);

        ObjectNode modelNode = objectMapper.createObjectNode();
        modelNode.put("prompt", prompt);
        modelNode.put("completion", completion);
        modelNode.put("timestamp", System.currentTimeMillis() / 1000.0);
        rootNode.set(model, modelNode);
      }

      objectMapper.writeValue(file, rootNode);
    } catch (Exception e) {
      log.warn("Failed to update cache files/Redis", e);
    }
  }

  private void cacheInRedis(String model, double prompt, double completion) {
    try {
      String redisKey = "model_cost:" + model;
      Map<String, Double> costData = Map.of("prompt", prompt, "completion", completion);
      redisTemplate.opsForValue().set(redisKey, objectMapper.writeValueAsString(costData));
    } catch (Exception e) {
      log.debug("Redis cache write failed for {}", model, e);
    }
  }
}
