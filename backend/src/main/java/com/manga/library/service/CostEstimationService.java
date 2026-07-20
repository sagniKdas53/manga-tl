package com.manga.library.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
      redisTemplate
          .opsForList()
          .rightPush(
              Objects.requireNonNull("job_costs"),
              Objects.requireNonNull(objectMapper.writeValueAsString(jobCost)));
    } catch (Exception e) {
      log.debug("Failed to record job cost to Redis", e);
    }
  }

  private final com.manga.library.repository.ModelRateRepository modelRateRepository;

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

    // 2. Try DB
    try {
      com.manga.library.model.ModelRate rate =
          modelRateRepository.findById(Objects.requireNonNull(model)).orElse(null);
      if (rate != null) {
        Map<String, Double> rates =
            Map.of(
                "prompt", rate.getPromptPrice(),
                "completion", rate.getCompletionPrice());
        cacheInRedis(model, rate.getPromptPrice(), rate.getCompletionPrice());
        return rates;
      }
    } catch (Exception e) {
      log.debug("Database read failed for model {}", model, e);
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

  @org.springframework.scheduling.annotation.Scheduled(fixedRate = 3600000) // Sync every hour
  public void scheduledModelCostsSync() {
    log.info("Running scheduled model costs sync...");
    updateModelCosts(null);
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
            if (models == null || models.isEmpty() || models.contains(modelId)) {
              JsonNode pricing = mNode.get("pricing");
              if (pricing != null) {
                double prompt = pricing.has("prompt") ? pricing.get("prompt").asDouble(0.0) : 0.0;
                double completion =
                    pricing.has("completion") ? pricing.get("completion").asDouble(0.0) : 0.0;
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
    try {
      for (Map.Entry<String, Map<String, Double>> entry : newCosts.entrySet()) {
        String model = entry.getKey();
        double prompt = entry.getValue().get("prompt");
        double completion = entry.getValue().get("completion");

        // Update Redis
        cacheInRedis(model, prompt, completion);

        // Update DB
        com.manga.library.model.ModelRate rate =
            modelRateRepository
                .findById(Objects.requireNonNull(model))
                .orElse(new com.manga.library.model.ModelRate());
        rate.setModelId(model);
        if (rate.getProvider() == null) {
          rate.setProvider(model.contains("/") ? model.split("/")[0] : "openrouter");
        }
        rate.setPromptPrice(prompt);
        rate.setCompletionPrice(completion);
        modelRateRepository.save(rate);
      }
    } catch (Exception e) {
      log.warn("Failed to update cache DB/Redis", e);
    }
  }

  private void cacheInRedis(String model, double prompt, double completion) {
    try {
      String redisKey = "model_cost:" + model;
      Map<String, Double> costData = Map.of("prompt", prompt, "completion", completion);
      redisTemplate
          .opsForValue()
          .set(
              Objects.requireNonNull(redisKey),
              Objects.requireNonNull(objectMapper.writeValueAsString(costData)));
    } catch (Exception e) {
      log.debug("Redis cache write failed for {}", model, e);
    }
  }
}
