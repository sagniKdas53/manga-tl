package com.manga.library.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.dto.ModelEntryDto;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

@Component
public class ProviderConfigCache {
  private static final Logger log = LoggerFactory.getLogger(ProviderConfigCache.class);

  private final StringRedisTemplate redisTemplate;
  private final ObjectMapper objectMapper;

  private volatile Map<String, ProviderData> providerMap = new HashMap<>();

  public ProviderConfigCache(StringRedisTemplate redisTemplate, ObjectMapper objectMapper) {
    this.redisTemplate = redisTemplate;
    this.objectMapper = objectMapper;
  }

  public static class ProviderData {
    public String displayName;
    public String type;
    public boolean freeTier;
    public int priority;
    public Integer rateLimits;
    public Map<String, List<ModelEntryDto>> models = new HashMap<>();
    public Map<String, String> defaults = new HashMap<>();
    public List<String> capabilities = new ArrayList<>();
  }

  @jakarta.annotation.PostConstruct
  public void init() {
    reload();
  }

  public synchronized void reload() {
    try {
      if (redisTemplate == null) return;
      String json = redisTemplate.opsForValue().get("system:providers:config");
      if (json == null || json.trim().isEmpty()) {
        log.info("Redis key system:providers:config empty or not found. ProviderConfigCache idle.");
        return;
      }

      JsonNode root = objectMapper.readTree(json);
      JsonNode providersNode = root.get("providers");
      if (providersNode == null || !providersNode.isObject()) {
        return;
      }

      Map<String, ProviderData> newMap = new HashMap<>();
      Iterator<Map.Entry<String, JsonNode>> fields = providersNode.properties().iterator();
      while (fields.hasNext()) {
        Map.Entry<String, JsonNode> entry = fields.next();
        String pName = entry.getKey();
        JsonNode pNode = entry.getValue();

        ProviderData pData = new ProviderData();
        pData.displayName = pNode.has("displayName") ? pNode.get("displayName").asText() : pName;
        pData.type = pNode.has("type") ? pNode.get("type").asText() : "openai-compatible";
        pData.freeTier = pNode.has("freeTier") && pNode.get("freeTier").asBoolean(false);
        pData.priority = pNode.has("priority") ? pNode.get("priority").asInt(99) : 99;

        if (pNode.has("models") && pNode.get("models").isObject()) {
          Iterator<Map.Entry<String, JsonNode>> mFields = pNode.get("models").properties().iterator();
          while (mFields.hasNext()) {
            Map.Entry<String, JsonNode> mEntry = mFields.next();
            String task = mEntry.getKey();
            JsonNode mList = mEntry.getValue();
            if (mList.isArray()) {
              List<ModelEntryDto> models = new ArrayList<>();
              for (JsonNode m : mList) {
                String id = m.get("id").asText();
                String name = m.has("name") ? m.get("name").asText() : id;
                boolean free = m.has("free") && m.get("free").asBoolean(false);
                models.add(new ModelEntryDto(id, name, free));
              }
              pData.models.put(task, models);
            }
          }
        }

        if (pNode.has("defaults") && pNode.get("defaults").isObject()) {
          Iterator<Map.Entry<String, JsonNode>> dFields =
              pNode.get("defaults").properties().iterator();
          while (dFields.hasNext()) {
            Map.Entry<String, JsonNode> dEntry = dFields.next();
            if (!dEntry.getValue().isNull()) {
              pData.defaults.put(dEntry.getKey(), dEntry.getValue().asText());
            }
          }
        }

        if (pNode.has("capabilities") && pNode.get("capabilities").isArray()) {
          for (JsonNode c : pNode.get("capabilities")) {
            pData.capabilities.add(c.asText());
          }
        }

        newMap.put(pName, pData);
      }

      this.providerMap = newMap;
      log.info("Reloaded ProviderConfigCache from Redis with {} providers.", newMap.size());
    } catch (Exception e) {
      log.warn("Failed to reload ProviderConfigCache from Redis: {}", e.getMessage());
    }
  }

  public List<String> getProvidersForTask(String task) {
    if (providerMap.isEmpty()) return List.of();
    List<Map.Entry<String, ProviderData>> entries = new ArrayList<>(providerMap.entrySet());
    entries.sort(Comparator.comparingInt(e -> e.getValue().priority));

    List<String> result = new ArrayList<>();
    for (Map.Entry<String, ProviderData> entry : entries) {
      String prov = entry.getKey();
      ProviderData data = entry.getValue();
      if (data.models.containsKey(task) && data.models.get(task) != null) {
        result.add(prov);
      }
    }
    return result;
  }

  public Map<String, Map<String, List<ModelEntryDto>>> getProviderModelsMap() {
    Map<String, Map<String, List<ModelEntryDto>>> result = new HashMap<>();
    for (Map.Entry<String, ProviderData> entry : providerMap.entrySet()) {
      result.put(entry.getKey(), entry.getValue().models);
    }
    return result;
  }

  public boolean isValidProviderModel(String provider, String model, String task) {
    if (providerMap.isEmpty()) {
      // If cache hasn't loaded yet from Redis, don't fail validation
      return true;
    }
    if (provider == null || provider.trim().isEmpty()) return false;
    if (provider.contains("[ORPHANED]")) return false;

    ProviderData pData = providerMap.get(provider.toLowerCase().strip());
    if (pData == null) return false;

    if (model == null || model.trim().isEmpty() || model.contains("[ORPHANED]")) {
      return true; // provider is valid, model will resolve to default
    }

    List<ModelEntryDto> modelsForTask = pData.models.get(task);
    if (modelsForTask == null) return false;

    return modelsForTask.stream().anyMatch(m -> m.id().equalsIgnoreCase(model.trim()));
  }

  public boolean isFreeTier(String provider) {
    if (provider == null) return false;
    ProviderData pData = providerMap.get(provider.toLowerCase().strip());
    return pData != null && pData.freeTier;
  }

  public boolean isModelFree(String provider, String model) {
    if (provider == null || model == null) return false;
    if (model.contains(":free")) return true;

    ProviderData pData = providerMap.get(provider.toLowerCase().strip());
    if (pData == null) return false;

    for (List<ModelEntryDto> mList : pData.models.values()) {
      if (mList != null) {
        for (ModelEntryDto m : mList) {
          if (m.id().equalsIgnoreCase(model.trim()) && m.free()) {
            return true;
          }
        }
      }
    }
    return false;
  }
}
