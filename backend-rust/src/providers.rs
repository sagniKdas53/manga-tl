//! ProviderConfigCache port — the worker publishes its model catalog to the Redis key
//! `system:providers:config`; this cache mirrors it in memory and answers
//! "is provider X able to run task Y with model Z?" for pipeline resolution.
//!
//! Semantics that matter (all Java parity):
//!   * an EMPTY cache is permissive: `is_valid_provider_model` returns true so a
//!     deployment whose worker has not published yet keeps working;
//!   * providers/models containing "[ORPHANED]" are never valid;
//!   * task keys are the catalog's own (`ocr`, `tl`, `qaLLM`, `qaVLM`) — NOT the
//!     pipeline stage names (AUDIT-P1).

use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Debug, Clone)]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub free: bool,
    pub pricing: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default)]
pub struct ProviderData {
    pub display_name: String,
    pub p_type: String,
    pub free_tier: bool,
    pub priority: i32,
    pub models: HashMap<String, Vec<ModelEntry>>,
    pub defaults: HashMap<String, String>,
    pub capabilities: Vec<String>,
}

/// A model ID typed in by the owner rather than picked from the worker-published catalog: a
/// stealth or brand-new model worth trying before it is curated. Valid for exactly its provider
/// and task, and kept apart from `inner` so a catalog reload does not drop it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CustomModel {
    pub provider: String,
    pub task: String,
    pub id: String,
}

/// The catalog's task keys a custom model may be registered for.
pub const CUSTOM_MODEL_TASKS: &[&str] = &["ocr", "tl", "qaLLM", "qaVLM"];

impl CustomModel {
    /// Trimmed, provider lowercased; `None` for a blank or orphan-marked ID, an unknown task, or
    /// the local provider (its models are det+rec pairs baked into the worker image).
    pub fn normalized(&self) -> Option<CustomModel> {
        let provider = self.provider.trim().to_lowercase();
        let task = CUSTOM_MODEL_TASKS
            .iter()
            .find(|t| t.eq_ignore_ascii_case(self.task.trim()))?;
        let id = self.id.trim();
        if provider.is_empty() || provider == "local" || id.is_empty() || id.contains("[ORPHANED]")
        {
            return None;
        }
        Some(CustomModel {
            provider,
            task: (*task).to_string(),
            id: id.to_string(),
        })
    }

    fn matches(&self, provider: &str, task: &str, id: &str) -> bool {
        self.provider == provider.trim().to_lowercase()
            && self.task == task
            && self.id.eq_ignore_ascii_case(id.trim())
    }
}

/// Normalizes a list and drops duplicates, keeping the first spelling.
pub fn normalize_custom_models(models: &[CustomModel]) -> Vec<CustomModel> {
    let mut out: Vec<CustomModel> = Vec::new();
    for model in models.iter().filter_map(CustomModel::normalized) {
        if !out
            .iter()
            .any(|m| m.matches(&model.provider, &model.task, &model.id))
        {
            out.push(model);
        }
    }
    out
}

#[derive(Default)]
pub struct ProviderConfigCache {
    inner: RwLock<HashMap<String, ProviderData>>,
    custom: RwLock<Vec<CustomModel>>,
}

impl ProviderConfigCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuilds the cache from the worker-published Redis blob. A missing/empty key
    /// leaves the current map untouched but CLEARED semantics differ from Java here:
    /// Java replaces only after a successful parse, keeping stale data on parse errors.
    /// We mirror that — parse into a new map first, then swap.
    pub async fn reload(&self, redis: &crate::redis_service::RedisService) {
        let json = match redis.get("system:providers:config").await {
            Ok(Some(json)) if !json.trim().is_empty() => json,
            Ok(_) => {
                tracing::info!(
                    "Redis key system:providers:config empty or not found. ProviderConfigCache idle."
                );
                return;
            }
            Err(err) => {
                tracing::warn!("Failed to read system:providers:config: {err}");
                return;
            }
        };

        let parsed = Self::parse(&json);
        match parsed {
            Some(map) => {
                let count = map.len();
                *self.inner.write().expect("provider cache poisoned") = map;
                tracing::info!("Reloaded ProviderConfigCache from Redis with {count} providers.");
            }
            None => {
                tracing::warn!("Failed to reload ProviderConfigCache from Redis (unparsable blob)")
            }
        }
    }

    fn parse(json: &str) -> Option<HashMap<String, ProviderData>> {
        let root: serde_json::Value = serde_json::from_str(json).ok()?;
        let providers = root.get("providers")?.as_object()?;
        let mut map = HashMap::new();

        for (p_name, p_node) in providers {
            let mut data = ProviderData {
                display_name: p_node
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .unwrap_or(p_name)
                    .to_string(),
                p_type: p_node
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("openai-compatible")
                    .to_string(),
                free_tier: p_node
                    .get("freeTier")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                priority: p_node
                    .get("priority")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(99) as i32,
                ..Default::default()
            };

            if let Some(models) = p_node.get("models").and_then(|v| v.as_object()) {
                for (task, list) in models {
                    let Some(entries) = list.as_array() else {
                        continue;
                    };
                    let parsed: Vec<ModelEntry> = entries
                        .iter()
                        .filter_map(|m| {
                            // Java does m.get("id").asText() unconditionally — a missing id
                            // becomes "null" there; treat it as absent instead.
                            let id = m.get("id")?.as_str()?.to_string();
                            Some(ModelEntry {
                                name: m
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&id)
                                    .to_string(),
                                free: m.get("free").and_then(|v| v.as_bool()).unwrap_or(false),
                                pricing: m.get("pricing").filter(|v| v.is_object()).cloned(),
                                id,
                            })
                        })
                        .collect();
                    data.models.insert(task.clone(), parsed);
                }
            }

            if let Some(defaults) = p_node.get("defaults").and_then(|v| v.as_object()) {
                for (key, value) in defaults {
                    if !value.is_null()
                        && let Some(text) = value.as_str()
                    {
                        data.defaults.insert(key.clone(), text.to_string());
                    }
                }
            }

            if let Some(caps) = p_node.get("capabilities").and_then(|v| v.as_array()) {
                data.capabilities = caps
                    .iter()
                    .filter_map(|c| c.as_str().map(str::to_string))
                    .collect();
            }

            map.insert(p_name.clone(), data);
        }
        Some(map)
    }

    fn snapshot(&self) -> HashMap<String, ProviderData> {
        self.inner.read().expect("provider cache poisoned").clone()
    }

    /// Replaces the owner's custom model IDs (System Settings `customModels`).
    pub fn set_custom_models(&self, models: Vec<CustomModel>) {
        *self.custom.write().expect("provider cache poisoned") = normalize_custom_models(&models);
    }

    pub fn custom_models(&self) -> Vec<CustomModel> {
        self.custom.read().expect("provider cache poisoned").clone()
    }

    fn is_custom_model(&self, provider: &str, model: &str, task: &str) -> bool {
        self.custom
            .read()
            .expect("provider cache poisoned")
            .iter()
            .any(|m| m.matches(provider, task, model))
    }

    /// Providers offering `task`, sorted by priority ascending.
    pub fn get_providers_for_task(&self, task: &str) -> Vec<String> {
        let map = self.snapshot();
        if map.is_empty() {
            return Vec::new();
        }
        let mut entries: Vec<(String, i32)> = map
            .iter()
            .filter(|(_, d)| d.models.contains_key(task))
            .map(|(k, d)| (k.clone(), d.priority))
            .collect();
        entries.sort_by_key(|(_, priority)| *priority);
        entries.into_iter().map(|(name, _)| name).collect()
    }

    /// The provider's own default model for a task, or None when it declares none.
    pub fn get_default_model(&self, provider: &str, task: &str) -> Option<String> {
        let map = self.snapshot();
        let key = provider.trim().to_lowercase();
        map.get(&key)?.defaults.get(task).cloned()
    }

    /// {provider: {task: [{id,name,free,pricing?}]}} in the shape SystemSettingsDto exposes.
    pub fn get_provider_models_map(&self) -> serde_json::Value {
        let map = self.snapshot();
        let mut out = serde_json::Map::new();
        for (name, data) in map {
            let mut tasks = serde_json::Map::new();
            for (task, models) in &data.models {
                tasks.insert(
                    task.clone(),
                    serde_json::to_value(
                        models
                            .iter()
                            .map(|m| {
                                let mut entry = serde_json::json!({
                                    "id": m.id,
                                    "name": m.name,
                                    "free": m.free
                                });
                                if let Some(pricing) = &m.pricing {
                                    entry["pricing"] = pricing.clone();
                                }
                                entry
                            })
                            .collect::<Vec<_>>(),
                    )
                    .unwrap_or_default(),
                );
            }
            out.insert(name, serde_json::Value::Object(tasks));
        }
        // Custom IDs join their provider's list for the task, flagged, after the curated ones.
        // A provider the catalog does not publish gets none: nothing could run them.
        for custom in self.custom_models() {
            let Some(serde_json::Value::Object(tasks)) = out.get_mut(&custom.provider) else {
                continue;
            };
            let list = tasks
                .entry(custom.task.clone())
                .or_insert_with(|| serde_json::Value::Array(Vec::new()));
            let Some(list) = list.as_array_mut() else {
                continue;
            };
            let listed = list.iter().any(|m| {
                m.get("id")
                    .and_then(|v| v.as_str())
                    .is_some_and(|id| id.eq_ignore_ascii_case(&custom.id))
            });
            if !listed {
                list.push(serde_json::json!({
                    "id": custom.id,
                    "name": custom.id,
                    "free": custom.id.ends_with(":free"),
                    "custom": true
                }));
            }
        }
        serde_json::Value::Object(out)
    }

    pub fn is_valid_provider_model(&self, provider: &str, model: &str, task: &str) -> bool {
        let map = self.snapshot();
        if map.is_empty() {
            // Cache not loaded yet: don't fail validation.
            return true;
        }
        if provider.trim().is_empty() || provider.contains("[ORPHANED]") {
            return false;
        }
        let key = provider.trim().to_lowercase();
        let Some(data) = map.get(&key) else {
            return false;
        };
        if model.trim().is_empty() || model.contains("[ORPHANED]") {
            // Provider valid; the model will resolve to its default anyway.
            return true;
        }
        if self.is_custom_model(&key, model, task) {
            return true;
        }
        data.models
            .get(task)
            .map(|list| list.iter().any(|m| m.id.eq_ignore_ascii_case(model.trim())))
            .unwrap_or(false)
    }

    pub fn is_free_tier(&self, provider: &str) -> bool {
        let key = provider.trim().to_lowercase();
        self.snapshot()
            .get(&key)
            .map(|d| d.free_tier)
            .unwrap_or(false)
    }

    pub fn is_model_free(&self, provider: &str, model: &str) -> bool {
        if model.contains(":free") {
            return true;
        }
        let key = provider.trim().to_lowercase();
        let snapshot = self.snapshot();
        let Some(data) = snapshot.get(&key) else {
            return false;
        };
        data.models
            .values()
            .flatten()
            .any(|m| m.id.eq_ignore_ascii_case(model.trim()) && m.free)
    }
}

// ---------------------------------------------------------------------------
// ProviderConfigCacheTest port — pure parse/query, no redis needed.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact catalog blob Java's test seeds into system:providers:config.
    const CATALOG_JSON: &str = r#"{
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
    }"#;

    fn cache_from(json: &str) -> ProviderConfigCache {
        let cache = ProviderConfigCache::new();
        let map = ProviderConfigCache::parse(json).expect("catalog fixture must parse");
        *cache.inner.write().expect("test cache poisoned") = map;
        cache
    }

    #[test]
    fn reload_with_valid_json_orders_by_priority() {
        let cache = cache_from(CATALOG_JSON);
        assert_eq!(
            cache.get_providers_for_task("tl"),
            vec!["openrouter".to_string(), "gemini".to_string()],
            "priority ascending: openrouter(1) then gemini(2)"
        );
    }

    #[test]
    fn model_validation_is_exact_and_orphan_aware() {
        let cache = cache_from(CATALOG_JSON);
        assert!(cache.is_valid_provider_model("openrouter", "deepseek/deepseek-v4-pro", "tl"));
        assert!(!cache.is_valid_provider_model("openrouter", "invalid-model", "tl"));
        // Provider name matching is exact — "[ORPHANED]" markers are never valid.
        assert!(!cache.is_valid_provider_model(
            "openrouter [ORPHANED]",
            "deepseek/deepseek-v4-pro",
            "tl"
        ));
    }

    #[test]
    fn a_custom_model_is_valid_for_its_provider_and_task_only_and_survives_a_reload() {
        let cache = cache_from(CATALOG_JSON);
        cache.set_custom_models(vec![
            CustomModel {
                provider: " OpenRouter ".into(),
                task: "tl".into(),
                id: " stealth/space-bunny-alpha ".into(),
            },
            // Dropped: local models are baked into the worker, and blank or orphaned IDs.
            CustomModel {
                provider: "local".into(),
                task: "ocr".into(),
                id: "x".into(),
            },
            CustomModel {
                provider: "openrouter".into(),
                task: "qaLLM".into(),
                id: "  ".into(),
            },
            CustomModel {
                provider: "openrouter".into(),
                task: "tl".into(),
                id: "Stealth/Space-Bunny-Alpha".into(),
            },
        ]);
        assert_eq!(
            cache.custom_models().len(),
            1,
            "normalized and deduplicated"
        );
        assert!(cache.is_valid_provider_model("openrouter", "stealth/space-bunny-alpha", "tl"));
        assert!(!cache.is_valid_provider_model("openrouter", "stealth/space-bunny-alpha", "qaLLM"));
        assert!(!cache.is_valid_provider_model("gemini", "stealth/space-bunny-alpha", "tl"));

        let tl = cache.get_provider_models_map()["openrouter"]["tl"].clone();
        let entry = tl
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "stealth/space-bunny-alpha")
            .expect("custom entry listed");
        assert_eq!(entry["custom"], true);

        // A catalog reload replaces `inner` only.
        *cache.inner.write().unwrap() = ProviderConfigCache::parse(CATALOG_JSON).unwrap();
        assert!(cache.is_valid_provider_model("openrouter", "stealth/space-bunny-alpha", "tl"));
    }

    #[test]
    fn free_tier_and_model_free_flags() {
        let cache = cache_from(CATALOG_JSON);
        assert!(cache.is_free_tier("gemini"));
        assert!(!cache.is_free_tier("openrouter"));
        assert!(cache.is_model_free("openrouter", "google/gemini-2.5-flash:free"));
        assert!(!cache.is_model_free("openrouter", "deepseek/deepseek-v4-pro"));
    }

    #[test]
    fn provider_models_map_contains_every_published_provider() {
        let cache = cache_from(CATALOG_JSON);
        let map = cache.get_provider_models_map();
        assert!(map.get("openrouter").is_some());
        assert!(map.get("gemini").is_some());
        assert_eq!(
            cache.get_default_model("openrouter", "tl").as_deref(),
            Some("deepseek/deepseek-v4-pro")
        );
    }

    #[test]
    fn provider_models_map_preserves_optional_pricing() {
        let cache = cache_from(
            r#"{
              "providers": {
                "openrouter": {
                  "models": {
                    "tl": [{
                      "id": "priced/model",
                      "name": "Priced model",
                      "free": false,
                      "pricing": {
                        "currency": "USD",
                        "promptPerMillion": 0.25,
                        "completionPerMillion": 1.5,
                        "source": "openrouter"
                      }
                    }]
                  }
                }
              }
            }"#,
        );

        let map = cache.get_provider_models_map();
        let pricing = &map["openrouter"]["tl"][0]["pricing"];
        assert_eq!(pricing["promptPerMillion"], 0.25);
        assert_eq!(pricing["completionPerMillion"], 1.5);
    }

    /// An empty cache does not fail validation (Java parity: deployments whose worker
    /// has not published yet keep working).
    #[test]
    fn empty_cache_is_permissive_and_lists_nothing() {
        let cache = ProviderConfigCache::new();
        assert!(cache.get_providers_for_task("tl").is_empty());
        assert!(cache.is_valid_provider_model("openrouter", "some-model", "tl"));
    }

    /// A garbage blob must not replace a previously loaded catalog (parse-then-swap).
    #[test]
    fn unparsable_blob_keeps_the_previous_catalog() {
        let cache = cache_from(CATALOG_JSON);
        assert!(ProviderConfigCache::parse("not-json{").is_none());
        // Simulate reload()'s refusal to swap on parse failure: snapshot unchanged.
        assert_eq!(
            cache.get_providers_for_task("tl").len(),
            2,
            "stale data survives a bad publish"
        );
    }
}
