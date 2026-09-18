//! Strict `page-scene/v1` validation and database-write mapping.
//!
//! This module deliberately validates a standalone JSON value. Route wiring belongs to B05;
//! callers receive a fully validated immutable snapshot plus normalized owner/asset references.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::{NewPageSceneAsset, NewPageSceneOwner, NewPageSceneSnapshot, PageRenderJob};

pub const CONTRACT_VERSION: &str = "page-scene/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSceneError(pub String);

impl fmt::Display for PageSceneError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PageSceneError {}

#[derive(Debug, Clone)]
pub struct ValidatedPageScene {
    pub contract_version: String,
    pub scene_kind: String,
    pub source_page_id: String,
    pub revision: i32,
    pub source_sha256: String,
    pub logical_scene_sha256: String,
    pub document: Value,
    pub owners: Vec<NewPageSceneOwner>,
    pub assets: Vec<NewPageSceneAsset>,
}

impl ValidatedPageScene {
    /// Binds a validated opaque contract page ID to the UUID selected by the API/database layer.
    /// B05 must require `source_page_id == page_id.to_string()` before persisting a route request.
    pub fn snapshot_for_page(&self, page_id: Uuid) -> NewPageSceneSnapshot {
        NewPageSceneSnapshot {
            page_id,
            revision: self.revision,
            contract_version: self.contract_version.clone(),
            source_sha256: self.source_sha256.clone(),
            logical_scene_sha256: self.logical_scene_sha256.clone(),
            scene_json: self.document.clone(),
        }
    }
}

/// Returns the immutable logical scene for the page's current revision.
/// A newer revision without a snapshot is deliberately not renderable yet.
pub async fn current_snapshot(
    pool: &PgPool,
    page_id: Uuid,
) -> Result<Option<crate::models::PageSceneSnapshot>, sqlx::Error> {
    sqlx::query_as(
        "SELECT snapshot.* FROM page_scene_snapshots snapshot \
         JOIN pages page ON page.id = snapshot.page_id \
         WHERE snapshot.page_id = $1 AND snapshot.revision = page.scene_revision",
    )
    .bind(page_id)
    .fetch_optional(pool)
    .await
}

/// The only render result a reader may call current for the page's current immutable scene.
#[derive(Debug)]
pub enum CurrentRenderArtifact {
    Ready(Box<PageRenderJob>),
    Pending { revision: i32 },
    Failed { revision: i32 },
}

/// Resolves the current page scene to either its exact completed artifact or an explicit
/// non-ready state. A previous revision's pointer is intentionally never a fallback.
pub async fn current_render_artifact(
    pool: &PgPool,
    page_id: Uuid,
) -> Result<CurrentRenderArtifact, sqlx::Error> {
    let revision: i32 = sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_one(pool)
        .await?;
    let Some(snapshot) = current_snapshot(pool, page_id).await? else {
        return Ok(CurrentRenderArtifact::Pending { revision });
    };

    let artifact: Option<PageRenderJob> = sqlx::query_as(
        "SELECT render.* \
         FROM pages page \
         JOIN page_scene_snapshots snapshot \
           ON snapshot.page_id = page.id AND snapshot.revision = page.scene_revision \
         JOIN page_render_jobs render ON render.job_id = page.current_render_job_id \
         WHERE page.id = $1 \
           AND render.page_revision = page.scene_revision \
           AND render.logical_scene_sha256 = snapshot.logical_scene_sha256 \
           AND render.status = 'succeeded' \
           AND render.rendered_png_storage_path IS NOT NULL",
    )
    .bind(page_id)
    .fetch_optional(pool)
    .await?;
    if let Some(artifact) = artifact {
        return Ok(CurrentRenderArtifact::Ready(Box::new(artifact)));
    }

    let latest_status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM page_render_jobs \
         WHERE page_id = $1 AND page_revision = $2 AND logical_scene_sha256 = $3 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(page_id)
    .bind(snapshot.revision)
    .bind(&snapshot.logical_scene_sha256)
    .fetch_optional(pool)
    .await?;
    if latest_status.as_deref() == Some("failed") {
        Ok(CurrentRenderArtifact::Failed { revision })
    } else {
        Ok(CurrentRenderArtifact::Pending { revision })
    }
}

/// Shared authorization gate for every automatic replacement artifact. A policy authorizes
/// neither cleanup nor text unless its effective action is `replace`; automatic text is never
/// allowed to carry an empty or whitespace-only replacement.
fn validate_replacement_request<'a>(
    policy_by_owner: &HashMap<String, String>,
    owner_ids: impl IntoIterator<Item = &'a str>,
    automatic_text: Option<&str>,
) -> Result<(), PageSceneError> {
    let mut has_owner = false;
    for owner_id in owner_ids {
        has_owner = true;
        if policy_by_owner.get(owner_id).map(String::as_str) != Some("replace") {
            return Err(error(
                "automatic replacement requires effective replace policy",
            ));
        }
    }
    if !has_owner {
        return Err(error("automatic replacement requires at least one owner"));
    }
    if automatic_text.is_some_and(|text| text.trim().is_empty()) {
        return Err(error("automatic replacement text must be non-empty"));
    }
    Ok(())
}

pub fn validate_page_scene(document: Value) -> Result<ValidatedPageScene, PageSceneError> {
    reject_non_finite(&document)?;
    let root = object(&document, "scene")?;
    exact_keys(
        root,
        &[
            "contract_version",
            "scene_kind",
            "page",
            "provenance",
            "fragments",
            "owners",
            "policies",
            "assets",
            "cleanup_artifacts",
            "objects",
            "resolved_layout",
        ],
        &[
            "contract_version",
            "scene_kind",
            "page",
            "provenance",
            "fragments",
            "owners",
            "policies",
            "assets",
            "cleanup_artifacts",
            "objects",
        ],
    )?;
    let contract_version = string(root, "contract_version")?;
    if contract_version != CONTRACT_VERSION {
        return Err(error("unsupported contract_version"));
    }
    let scene_kind = string(root, "scene_kind")?;
    if scene_kind != "logical" && scene_kind != "resolved" {
        return Err(error("scene_kind must be logical or resolved"));
    }
    if scene_kind == "logical" && root.contains_key("resolved_layout") {
        return Err(error("logical scene cannot contain resolved_layout"));
    }
    if scene_kind == "resolved" && !root.contains_key("resolved_layout") {
        return Err(error("resolved scene requires resolved_layout"));
    }

    let page = object(required(root, "page")?, "page")?;
    let source_page_id = string(page, "page_id")?.to_owned();
    let revision = integer(page, "revision")?;
    if revision < 0 {
        return Err(error("page revision must be non-negative"));
    }
    let source = object(required(page, "source")?, "page.source")?;
    let source_sha256 = sha256(string(source, "sha256")?, "page.source.sha256")?.to_owned();

    let fragments = array(required(root, "fragments")?, "fragments")?;
    let owners = array(required(root, "owners")?, "owners")?;
    let policies = array(required(root, "policies")?, "policies")?;
    let assets = array(required(root, "assets")?, "assets")?;
    let cleanups = array(required(root, "cleanup_artifacts")?, "cleanup_artifacts")?;
    let objects = array(required(root, "objects")?, "objects")?;

    let fragment_ids = ids(fragments, "fragment_id", "fragment")?;
    let mut owner_ids = HashSet::new();
    let mut owner_fragments = HashSet::new();
    for owner in owners {
        let owner = object(owner, "owner")?;
        let owner_id = string(owner, "owner_id")?.to_owned();
        if !owner_ids.insert(owner_id.clone()) {
            return Err(error("duplicate owner_id"));
        }
        for fragment_id in array(required(owner, "fragment_ids")?, "owner.fragment_ids")? {
            let fragment_id = string_value(fragment_id, "owner.fragment_ids[]")?;
            if !fragment_ids.contains(fragment_id)
                || !owner_fragments.insert(fragment_id.to_owned())
            {
                return Err(error("every fragment must have exactly one owner"));
            }
        }
    }
    if owner_fragments.len() != fragment_ids.len() {
        return Err(error("every fragment must have exactly one owner"));
    }

    let mut policy_by_owner = HashMap::new();
    let mut owner_rows = Vec::with_capacity(policies.len());
    for policy in policies {
        let policy = object(policy, "policy")?;
        let owner_id = string(policy, "owner_id")?.to_owned();
        if !owner_ids.contains(&owner_id) || policy_by_owner.contains_key(&owner_id) {
            return Err(error("every owner must have exactly one policy"));
        }
        let policy_action = action(string(policy, "action")?)?.to_owned();
        let override_action = match policy.get("user_override") {
            Some(Value::Null) | None => None,
            Some(value) => Some(action(string_value(value, "policy.user_override")?)?.to_owned()),
        };
        policy_by_owner.insert(
            owner_id.clone(),
            override_action
                .clone()
                .unwrap_or_else(|| policy_action.clone()),
        );
        owner_rows.push(NewPageSceneOwner {
            owner_id,
            policy_kind: string(policy, "kind")?.to_owned(),
            policy_action,
            policy_override: override_action,
        });
    }
    if policy_by_owner.len() != owner_ids.len() {
        return Err(error("every owner must have exactly one policy"));
    }

    let mut asset_kinds = HashMap::new();
    let mut asset_rows = Vec::with_capacity(assets.len());
    for asset in assets {
        let asset = object(asset, "asset")?;
        let asset_id = string(asset, "asset_id")?.to_owned();
        let asset_kind = string(asset, "kind")?.to_owned();
        if asset_kinds
            .insert(asset_id.clone(), asset_kind.clone())
            .is_some()
        {
            return Err(error("duplicate asset_id"));
        }
        asset_rows.push(NewPageSceneAsset {
            asset_id,
            asset_kind,
            asset_sha256: sha256(string(asset, "sha256")?, "asset.sha256")?.to_owned(),
            byte_length: integer(asset, "byte_length")? as i64,
            mime_type: string(asset, "mime_type")?.to_owned(),
            storage_path: None,
        });
    }

    let mut cleanup_owners = HashMap::new();
    for cleanup in cleanups {
        let cleanup = object(cleanup, "cleanup artifact")?;
        let cleanup_id = string(cleanup, "cleanup_id")?.to_owned();
        if cleanup_owners.contains_key(&cleanup_id) {
            return Err(error("duplicate cleanup_id"));
        }
        if sha256(string(cleanup, "source_sha256")?, "cleanup.source_sha256")? != source_sha256 {
            return Err(error("cleanup source hash does not match page source"));
        }
        if asset_kinds.get(string(cleanup, "mask_asset_id")?) != Some(&"glyph_mask".to_owned())
            || asset_kinds.get(string(cleanup, "patch_asset_id")?)
                != Some(&"cleanup_patch".to_owned())
        {
            return Err(error(
                "cleanup assets must be existing glyph_mask and cleanup_patch",
            ));
        }
        let cleanup_owner_ids = array(required(cleanup, "owner_ids")?, "cleanup.owner_ids")?
            .iter()
            .map(|value| string_value(value, "cleanup.owner_ids[]").map(str::to_owned))
            .collect::<Result<HashSet<_>, _>>()?;
        validate_replacement_request(
            &policy_by_owner,
            cleanup_owner_ids.iter().map(String::as_str),
            None,
        )?;
        cleanup_owners.insert(cleanup_id, cleanup_owner_ids);
    }

    let mut object_ids = HashSet::new();
    for item in objects {
        let item = object(item, "editable object")?;
        let object_id = string(item, "object_id")?.to_owned();
        if !object_ids.insert(object_id) {
            return Err(error("duplicate object_id"));
        }
        let kind = string(item, "kind")?;
        if kind != "manual_cleanup" {
            let transform = object(required(item, "transform")?, "object.transform")?;
            for field in ["x", "y", "width", "height", "rotation_degrees"] {
                let value = required(transform, field)?
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| error(&format!("object.transform.{field} must be finite")))?;
                if (field == "width" || field == "height") && value <= 0.0 {
                    return Err(error("object transform width and height must be positive"));
                }
            }
        }
        if kind != "automatic_text" {
            continue;
        }
        let owner_id = string(item, "owner_id")?;
        validate_replacement_request(
            &policy_by_owner,
            std::iter::once(owner_id),
            Some(string(item, "text")?),
        )?;
        for cleanup_id in array(required(item, "cleanup_ids")?, "object.cleanup_ids")? {
            let cleanup_id = string_value(cleanup_id, "object.cleanup_ids[]")?;
            if !cleanup_owners
                .get(cleanup_id)
                .is_some_and(|owners| owners.contains(owner_id))
            {
                return Err(error("automatic text must reference its owner's cleanup"));
            }
        }
    }

    let logical_scene_sha256 = logical_scene_digest(&document)?;
    if scene_kind == "resolved" {
        let layout = object(required(root, "resolved_layout")?, "resolved_layout")?;
        if sha256(
            string(layout, "logical_scene_sha256")?,
            "resolved_layout.logical_scene_sha256",
        )? != logical_scene_sha256
        {
            return Err(error("resolved layout logical scene digest does not match"));
        }
    }

    Ok(ValidatedPageScene {
        contract_version: contract_version.to_owned(),
        scene_kind: scene_kind.to_owned(),
        source_page_id,
        revision,
        source_sha256,
        logical_scene_sha256,
        document,
        owners: owner_rows,
        assets: asset_rows,
    })
}

pub fn logical_scene_digest(document: &Value) -> Result<String, PageSceneError> {
    let mut logical = document.clone();
    let root = logical
        .as_object_mut()
        .ok_or_else(|| error("scene must be an object"))?;
    root.insert("scene_kind".to_owned(), Value::String("logical".to_owned()));
    root.remove("resolved_layout");
    let canonical = canonical_json(&logical)?;
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn canonical_json(value: &Value) -> Result<String, PageSceneError> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.to_string()),
        Value::Number(number) => {
            let float = number
                .as_f64()
                .ok_or_else(|| error("number is not finite"))?;
            if float.is_finite() {
                Ok(number.to_string())
            } else {
                Err(error("number is not finite"))
            }
        }
        Value::Array(values) => values
            .iter()
            .map(canonical_json)
            .collect::<Result<Vec<_>, _>>()
            .map(|values| format!("[{}]", values.join(","))),
        Value::Object(values) => values
            .iter()
            .collect::<BTreeMap<_, _>>()
            .into_iter()
            .map(|(key, value)| {
                Ok(format!(
                    "{}:{}",
                    Value::String(key.clone()),
                    canonical_json(value)?
                ))
            })
            .collect::<Result<Vec<_>, PageSceneError>>()
            .map(|values| format!("{{{}}}", values.join(","))),
    }
}

fn reject_non_finite(value: &Value) -> Result<(), PageSceneError> {
    match value {
        Value::Number(number) if number.as_f64().is_none_or(|number| !number.is_finite()) => {
            Err(error("non-finite number"))
        }
        Value::Array(values) => values.iter().try_for_each(reject_non_finite),
        Value::Object(values) => values.values().try_for_each(reject_non_finite),
        _ => Ok(()),
    }
}

fn ids(items: &[Value], field: &str, label: &str) -> Result<HashSet<String>, PageSceneError> {
    let mut ids = HashSet::new();
    for item in items {
        let id = string(object(item, label)?, field)?.to_owned();
        if !ids.insert(id) {
            return Err(error(&format!("duplicate {label} id")));
        }
    }
    Ok(ids)
}

fn exact_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    required: &[&str],
) -> Result<(), PageSceneError> {
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(error("scene has missing or unknown fields"));
    }
    Ok(())
}
fn required<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a Value, PageSceneError> {
    object
        .get(key)
        .ok_or_else(|| error(&format!("missing {key}")))
}
fn object<'a>(
    value: &'a Value,
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>, PageSceneError> {
    value
        .as_object()
        .ok_or_else(|| error(&format!("{label} must be an object")))
}
fn array<'a>(value: &'a Value, label: &str) -> Result<&'a Vec<Value>, PageSceneError> {
    value
        .as_array()
        .ok_or_else(|| error(&format!("{label} must be an array")))
}
fn string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, PageSceneError> {
    string_value(required(object, key)?, key)
}
fn string_value<'a>(value: &'a Value, label: &str) -> Result<&'a str, PageSceneError> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error(&format!("{label} must be a non-empty string")))
}
fn integer(object: &serde_json::Map<String, Value>, key: &str) -> Result<i32, PageSceneError> {
    required(object, key)?
        .as_i64()
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| error(&format!("{key} must be an integer")))
}
fn sha256<'a>(value: &'a str, label: &str) -> Result<&'a str, PageSceneError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(value)
    } else {
        Err(error(&format!("{label} must be a lowercase SHA-256")))
    }
}
fn action(value: &str) -> Result<&str, PageSceneError> {
    match value {
        "preserve" | "explain" | "replace" | "review" => Ok(value),
        _ => Err(error("unknown policy action")),
    }
}
fn error(message: &str) -> PageSceneError {
    PageSceneError(message.to_owned())
}
