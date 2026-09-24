//! JobCoordinatorService flow tests that the endpoint suites cannot reach directly:
//! QA retry-budget exhaustion, hybrid-QA visibility sweep and the reader-mode
//! short-circuit (JobCoordinatorServiceTest additions from the Phase-4 matrix).
//!
//! Requires REAL Postgres + Valkey.

use std::sync::Arc;
use uuid::Uuid;

use manga_backend::config::{DatabaseConfig, MinioConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::redis_service::RedisService;
use manga_backend::state::AppState;

const SECRET: &str = "test-secret-long-enough-for-hmac-signing-1234567890";

fn db_config_from_env() -> Option<DatabaseConfig> {
    let url = std::env::var("SPRING_DATASOURCE_URL").ok()?;
    let rest = url.strip_prefix("jdbc:postgresql://")?;
    let (hostport, name) = rest.split_once('/')?;
    let (host, port) = match hostport.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()?),
        None => (hostport.to_string(), 5432),
    };
    Some(DatabaseConfig {
        host,
        port,
        name: name.to_string(),
        user: std::env::var("SPRING_DATASOURCE_USERNAME").unwrap_or_else(|_| "postgres".into()),
        password: std::env::var("SPRING_DATASOURCE_PASSWORD").unwrap_or_default(),
    })
}

async fn app() -> Option<(sqlx::PgPool, Arc<RedisService>, AppState)> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let addr = std::env::var("REDIS_TEST_ADDR").ok()?;
    let (host, port) = addr.split_once(':')?;
    let redis = Arc::new(
        RedisService::connect(host, port.parse().expect("numeric port"))
            .await
            .expect("redis connect"),
    );
    let minio = MinioConfig {
        endpoint: std::env::var("MINIO_TEST_ENDPOINT")
            .unwrap_or_else(|_| "http://localhost:9000".into()),
        external_url: None,
        access_key: Some("minioadmin".into()),
        secret_key: Some("minioadmin".into()),
    };
    let config = manga_backend::config::Config {
        context_path: "/tlhub".into(),
        port: 0,
        development: true,
        database: DatabaseConfig {
            host: "localhost".into(),
            port: 5432,
            name: "test".into(),
            user: "postgres".into(),
            password: "pw".into(),
        },
        jwt_secret: None,
        internal_api_token: None,
        jwt_expiration_ms: 3_600_000,
        minio: minio.clone(),
        redis: manga_backend::config::RedisConfig {
            host: "localhost".into(),
            port: 6379,
        },
    };
    let state = AppState::new(
        config,
        pool.clone(),
        JwtUtils::new(SECRET.into(), 3_600_000),
        MinioService::new(&minio),
        Some(redis.clone()),
    );
    Some((pool, redis, state))
}

/// Seeds series → chapter → page → image; series languages configurable.
async fn seed_pipeline(
    pool: &sqlx::PgPool,
    source_language: Option<&str>,
    target_language: Option<&str>,
) -> (Uuid, Uuid, Uuid, Uuid) {
    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language, source_language, target_language) \
         VALUES ($1, now(), now(), 'Coordinator E2E', 'rightToLeft', $2, $3, $4)",
    )
    .bind(series_id)
    .bind(source_language.unwrap_or("ja"))
    .bind(source_language)
    .bind(target_language)
    .execute(pool)
    .await
    .expect("series");

    let chapter_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id) \
         VALUES ($1, 1, now(), now(), TRUE, $2)",
    )
    .bind(chapter_id)
    .bind(series_id)
    .execute(pool)
    .await
    .expect("chapter");

    let image_id = Uuid::new_v4();
    // A real-looking SHA-256: `prepare_hybrid_qa` ends by snapshotting the page scene, and the
    // scene builder refuses an image whose hash is not 64 hex digits.
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'coord.png', 'originals/coord.png', $2, 64, 64)",
    )
    .bind(image_id)
    .bind(format!("{:0>64}", image_id.simple().to_string()))
    .execute(pool)
    .await
    .expect("image");

    let page_id = Uuid::new_v4();
    sqlx::query("INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, 1, $2, $3)")
        .bind(page_id)
        .bind(chapter_id)
        .bind(image_id)
        .execute(pool)
        .await
        .expect("page");

    (series_id, chapter_id, page_id, image_id)
}

/// Seed the PROCESSING job row a stage callback reports on, and return its identity.
///
/// Callbacks are fenced on `(jobId, attempt, input_generation, lease_token)` now, so a test that
/// calls a handler directly has to speak for a real attempt exactly as the internal route does.
/// The lease token is the job id: unique per row, and readable in a failure message.
async fn seed_stage_job(
    pool: &sqlx::PgPool,
    job_type: &str,
    image_id: Uuid,
    page_id: Option<Uuid>,
) -> (String, manga_backend::jobs::coordinator::CallbackIdentity) {
    let job_id = format!("{job_type}-{}", Uuid::new_v4());
    let input_generation: i32 = match page_id {
        Some(page_id) => sqlx::query_scalar("SELECT input_generation FROM pages WHERE id = $1")
            .bind(page_id)
            .fetch_one(pool)
            .await
            .unwrap_or(0),
        None => 0,
    };
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, page_id, attempt, max_attempts, \
           input_generation, lease_token, started_at, created_at, updated_at) \
         VALUES ($1,$2,'PROCESSING',$3,$4,1,3,$5,$1,now(),now(),now())",
    )
    .bind(&job_id)
    .bind(job_type)
    .bind(image_id)
    .bind(page_id)
    .bind(input_generation)
    .execute(pool)
    .await
    .expect("stage job");
    let identity = manga_backend::jobs::coordinator::CallbackIdentity {
        job_id: job_id.clone(),
        attempt: 1,
        input_generation,
        lease_token: job_id.clone(),
    };
    (job_id, identity)
}

/// Bind a QA job to the page's current scene and a render artifact, the way the render callback
/// does, and return the accounting fields a worker sends back for a complete verdict set.
async fn bind_qa(
    pool: &sqlx::PgPool,
    qa_job: &str,
    image_id: Uuid,
    page_id: Uuid,
    targets: &[Uuid],
) -> serde_json::Value {
    let revision: i32 = sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .expect("revision");
    sqlx::query(
        "INSERT INTO page_scene_snapshots \
         (page_id, revision, contract_version, source_sha256, logical_scene_sha256, scene_json) \
         VALUES ($1, $2, 'page-scene/v1', repeat('a', 64), lpad($2::text, 64, 'd'), '{}'::jsonb) \
         ON CONFLICT DO NOTHING",
    )
    .bind(page_id)
    .bind(revision)
    .execute(pool)
    .await
    .expect("snapshot");
    let digest: String = sqlx::query_scalar(
        "SELECT logical_scene_sha256 FROM page_scene_snapshots WHERE page_id=$1 AND revision=$2",
    )
    .bind(page_id)
    .bind(revision)
    .fetch_one(pool)
    .await
    .expect("digest");
    let png = "e".repeat(64);
    let artifact = serde_json::json!({
        "storagePath": format!("rendered/{image_id}/jobs/render-bound/attempts/1/{png}.png"),
        "sha256": png, "byteLength": 10, "contentType": "image/png",
    });
    sqlx::query("UPDATE jobs SET payload = $2 WHERE id = $1")
        .bind(qa_job)
        .bind(
            serde_json::json!({
                "renderArtifact": artifact, "pageRevision": revision, "logicalSceneSha256": digest,
            })
            .to_string(),
        )
        .execute(pool)
        .await
        .expect("bind QA job");
    serde_json::json!({
        "qaTargetIds": targets.iter().map(Uuid::to_string).collect::<Vec<_>>(),
        "qaResponseIntegrity": {"complete": true, "errors": []},
        "judgedArtifact": {
            "artifact": artifact, "pageRevision": revision, "logicalSceneSha256": digest,
        },
    })
}

async fn cleanup_series(pool: &sqlx::PgPool, series_id: Uuid) {
    let _ = sqlx::query(
        "DELETE FROM layer_elements WHERE layer_id IN (SELECT l.id FROM layers l JOIN pages p ON p.id=l.page_id WHERE p.chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM layers WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM conversation_regions WHERE conversation_id IN (SELECT id FROM conversations WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1)))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM conversations WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM ocr_regions WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM panels WHERE image_id IN (SELECT image_id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM job_costs WHERE image_id IN (SELECT image_id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM jobs WHERE image_id IN (SELECT image_id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1)",
    )
    .bind(series_id)
    .execute(pool)
    .await;
    let _ = sqlx::query("DELETE FROM chapters WHERE series_id=$1")
        .bind(series_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM series WHERE id=$1")
        .bind(series_id)
        .execute(pool)
        .await;
}

#[tokio::test]
async fn callback_claim_does_not_consume_another_images_job() {
    let Some((pool, _redis, _state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, _page_id, current_image) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;
    let other_image = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'other.png', 'originals/other.png', $2, 64, 64)",
    )
    .bind(other_image)
    .bind(format!("hash-other-{other_image}"))
    .execute(&pool)
    .await
    .expect("other image");
    let job_id = format!("redo-other-{other_image}");
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, attempt, max_attempts, lease_token, \
           started_at, created_at, updated_at) \
         VALUES ($1,'region-redo-tl','PROCESSING',$2,1,3,$1,now(),now(),now())",
    )
    .bind(&job_id)
    .bind(other_image)
    .execute(&pool)
    .await
    .expect("job");

    // Before R3 a mismatched image made the claim fail *open* — it returned "apply anyway", on
    // the reasoning that a lost race must never discard a genuine result. Under the attempt fence
    // that is the wrong default: a caller that cannot prove which attempt it is has no business
    // writing one's results, and the worker's own bounded retry is what recovers a genuine result.
    let identity = manga_backend::jobs::coordinator::CallbackIdentity {
        job_id: job_id.clone(),
        attempt: 1,
        input_generation: 0,
        lease_token: job_id.clone(),
    };
    let mut tx = pool.begin().await.expect("transaction");
    assert_eq!(
        manga_backend::jobs::coordinator::CALLBACK_IDENTITY
            .scope(
                identity.clone(),
                manga_backend::jobs::coordinator::claim_callback_tx(
                    &mut tx,
                    Some(&job_id),
                    current_image,
                    "region-redo-tl",
                ),
            )
            .await
            .expect("mismatched claim"),
        manga_backend::jobs::coordinator::ClaimOutcome::NotCurrent,
        "a callback naming another image's job must be refused, not applied"
    );
    tx.commit().await.expect("commit mismatch");
    let claimed: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT callback_applied_at FROM jobs WHERE id = $1")
            .bind(&job_id)
            .fetch_one(&pool)
            .await
            .expect("claim state");
    assert!(
        claimed.is_none(),
        "another image's job must remain unclaimed"
    );

    let mut tx = pool.begin().await.expect("transaction");
    assert_eq!(
        manga_backend::jobs::coordinator::CALLBACK_IDENTITY
            .scope(
                identity,
                manga_backend::jobs::coordinator::claim_callback_tx(
                    &mut tx,
                    Some(&job_id),
                    other_image,
                    "region-redo-tl",
                ),
            )
            .await
            .expect("matching claim"),
        manga_backend::jobs::coordinator::ClaimOutcome::Claimed
    );
    tx.commit().await.expect("commit claim");
    let claimed: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT callback_applied_at FROM jobs WHERE id = $1")
            .bind(&job_id)
            .fetch_one(&pool)
            .await
            .expect("claim state");
    assert!(
        claimed.is_some(),
        "the owning image must still be able to claim its job"
    );

    sqlx::query("DELETE FROM jobs WHERE id = $1")
        .bind(&job_id)
        .execute(&pool)
        .await
        .expect("delete job");
    sqlx::query("DELETE FROM images WHERE id = $1")
        .bind(other_image)
        .execute(&pool)
        .await
        .expect("delete image");
    cleanup_series(&pool, series_id).await;
}

async fn insert_translation_version(
    pool: &sqlx::PgPool,
    page_id: Uuid,
    region_id: Uuid,
    z_order: i32,
    text: &str,
    element_visible: bool,
    predecessor: Option<Uuid>,
) -> (Uuid, Uuid) {
    let layer_id = Uuid::new_v4();
    let element_id = Uuid::new_v4();
    let metadata = match predecessor {
        Some(predecessor) => serde_json::json!({
            "layer_name": format!("redo {z_order}"),
            "overlay": true,
            "region_id": region_id.to_string(),
            "superseded_elements": [predecessor.to_string()],
        }),
        None => serde_json::json!({"layer_name": "Translation"}),
    };
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1,'translation','en',TRUE,$2,$3,$4,now())",
    )
    .bind(layer_id)
    .bind(z_order)
    .bind(metadata)
    .bind(page_id)
    .execute(pool)
    .await
    .expect("translation layer");
    sqlx::query(
        "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) \
         VALUES ($1,$2,10,20,100,50,$3,$4,$5)",
    )
    .bind(element_id)
    .bind(text)
    .bind(element_visible)
    .bind(layer_id)
    .bind(region_id)
    .execute(pool)
    .await
    .expect("translation element");
    (layer_id, element_id)
}

#[tokio::test]
async fn full_translation_pass_restores_overlay_predecessors() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;
    let region_id: Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, text, translated_text, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, page_id) \
         VALUES (uuid_generate_v4(),'原文','base','ja',10,20,100,50,$1) RETURNING id",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("region");
    let (base_layer, base_element) =
        insert_translation_version(&pool, page_id, region_id, 0, "base", false, None).await;
    let (first_overlay, first_overlay_element) = insert_translation_version(
        &pool,
        page_id,
        region_id,
        1,
        "redo A",
        false,
        Some(base_element),
    )
    .await;
    let (second_overlay, second_overlay_element) = insert_translation_version(
        &pool,
        page_id,
        region_id,
        2,
        "redo B",
        true,
        Some(first_overlay_element),
    )
    .await;

    let (tl_job, tl_identity) = seed_stage_job(&pool, "translation", image_id, Some(page_id)).await;
    manga_backend::jobs::coordinator::CALLBACK_IDENTITY
        .scope(
            tl_identity,
            manga_backend::jobs::coordinator::handle_translation_callback(
                &state,
                Some(&tl_job),
                image_id,
                &[serde_json::json!({
                    "regionId": region_id.to_string(),
                    "pageId": page_id.to_string(),
                    "translatedText": "fresh pass",
                    "translationFailed": false,
                })],
                None,
            ),
        )
        .await
        .expect("translation callback");

    let old_layer_visibility: Vec<(Uuid, Option<bool>)> =
        sqlx::query_as("SELECT id, visible FROM layers WHERE id = ANY($1) ORDER BY id")
            .bind([base_layer, first_overlay, second_overlay])
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        old_layer_visibility
            .iter()
            .all(|(_, visible)| *visible == Some(false))
    );
    let old_element_visibility: Vec<(Uuid, Option<bool>)> =
        sqlx::query_as("SELECT id, visible FROM layer_elements WHERE id = ANY($1) ORDER BY id")
            .bind([base_element, first_overlay_element, second_overlay_element])
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(old_element_visibility.contains(&(base_element, Some(true))));
    assert!(old_element_visibility.contains(&(first_overlay_element, Some(true))));
    assert!(old_element_visibility.contains(&(second_overlay_element, Some(true))));

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn qa_direct_fix_edits_only_the_rendered_overlay() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;
    let region_id: Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, text, translated_text, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, page_id) \
         VALUES (uuid_generate_v4(),'原文','base','ja',10,20,100,50,$1) RETURNING id",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("region");
    let (_base_layer, base_element) =
        insert_translation_version(&pool, page_id, region_id, 0, "base", false, None).await;
    let (_first_layer, first_element) = insert_translation_version(
        &pool,
        page_id,
        region_id,
        1,
        "redo A",
        false,
        Some(base_element),
    )
    .await;
    let (_second_layer, second_element) = insert_translation_version(
        &pool,
        page_id,
        region_id,
        2,
        "redo B",
        true,
        Some(first_element),
    )
    .await;

    let result = serde_json::json!({
        "regionId": region_id.to_string(),
        "qaStatus": "direct_fix",
        "qaScore": 0.9,
        "directFix": {"correctedText": "normal QA fixed"},
    });
    let (qa_job, qa_identity) = seed_stage_job(&pool, "qa", image_id, Some(page_id)).await;
    let accounting = bind_qa(&pool, &qa_job, image_id, page_id, &[region_id]).await;
    manga_backend::jobs::coordinator::CALLBACK_IDENTITY
        .scope(
            qa_identity,
            manga_backend::jobs::coordinator::handle_qa_callback(
                &state,
                Some(&qa_job),
                image_id,
                Some(page_id),
                std::slice::from_ref(&result),
                None,
                &accounting,
            ),
        )
        .await
        .expect("QA callback");

    let texts = |pool: sqlx::PgPool| async move {
        sqlx::query_as::<_, (Uuid, Option<String>)>(
            "SELECT id, text FROM layer_elements WHERE id = ANY($1) ORDER BY id",
        )
        .bind([base_element, first_element, second_element])
        .fetch_all(&pool)
        .await
        .unwrap()
    };
    let after_normal = texts(pool.clone()).await;
    assert!(after_normal.contains(&(base_element, Some("base".into()))));
    assert!(after_normal.contains(&(first_element, Some("redo A".into()))));
    assert!(after_normal.contains(&(second_element, Some("normal QA fixed".into()))));

    sqlx::query("UPDATE layer_elements SET text='redo B' WHERE id=$1")
        .bind(second_element)
        .execute(&pool)
        .await
        .unwrap();
    let hybrid_result = serde_json::json!({
        "regionId": region_id.to_string(),
        "qaStatus": "direct_fix",
        "qaScore": 0.9,
        "directFix": {"correctedText": "hybrid QA fixed"},
    });
    manga_backend::jobs::coordinator::prepare_hybrid_qa(
        &state,
        image_id,
        Some(page_id),
        &[hybrid_result],
    )
    .await
    .expect("hybrid QA prepare");
    let after_hybrid = texts(pool.clone()).await;
    assert!(after_hybrid.contains(&(base_element, Some("base".into()))));
    assert!(after_hybrid.contains(&(first_element, Some("redo A".into()))));
    assert!(after_hybrid.contains(&(second_element, Some("hybrid QA fixed".into()))));

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn qa_retry_budget_exhaustion_completes_without_retranslate() {
    let Some((pool, redis, state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;

    // Budget already spent: two retries on record.
    redis
        .set(&format!("page:qa:retries:{page_id}"), "2")
        .await
        .expect("seed retry counter");

    // A failed QA verdict WITHOUT manual intervention asks for a retry.
    let (qa_job, qa_identity) = seed_stage_job(&pool, "qa", image_id, Some(page_id)).await;
    let region = Uuid::new_v4();
    let accounting = bind_qa(&pool, &qa_job, image_id, page_id, &[region]).await;
    let result = manga_backend::jobs::coordinator::CALLBACK_IDENTITY
        .scope(
            qa_identity,
            manga_backend::jobs::coordinator::handle_qa_callback(
                &state,
                Some(&qa_job),
                image_id,
                Some(page_id),
                &[serde_json::json!({
                    "regionId": region.to_string(),
                    "qaStatus": "failed",
                    "qaScore": 0.2,
                })],
                None,
                &accounting,
            ),
        )
        .await
        .expect("qa callback handled");

    assert_eq!(
        result, "COMPLETED_WITH_FAILURES",
        "exhausted budget finishes the pipeline without reporting a pass"
    );

    // No retranslation job was enqueued for this image.
    let translations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id=$1 AND type='translation'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .unwrap_or(0);
    assert_eq!(translations, 0, "budget exhausted -> no translation retry");

    // Counter cleared with the pipeline.
    let counter = redis
        .get(&format!("page:qa:retries:{page_id}"))
        .await
        .unwrap();
    assert!(counter.is_none(), "retry counter reset after completion");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn qa_retry_within_budget_retranslates() {
    let Some((pool, redis, state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;

    // Fresh budget (no key): a plain failure must RETRY via translation.
    let (qa_job, qa_identity) = seed_stage_job(&pool, "qa", image_id, Some(page_id)).await;
    let region = Uuid::new_v4();
    let accounting = bind_qa(&pool, &qa_job, image_id, page_id, &[region]).await;
    let result = manga_backend::jobs::coordinator::CALLBACK_IDENTITY
        .scope(
            qa_identity,
            manga_backend::jobs::coordinator::handle_qa_callback(
                &state,
                Some(&qa_job),
                image_id,
                Some(page_id),
                &[serde_json::json!({
                    "regionId": region.to_string(),
                    "qaStatus": "failed",
                    "qaScore": 0.3,
                })],
                None,
                &accounting,
            ),
        )
        .await
        .expect("qa callback handled");
    assert_eq!(result, "RETRIED");

    let translations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id=$1 AND type='translation'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .unwrap_or(0);
    assert_eq!(
        translations, 1,
        "in-budget failure triggers one translation job"
    );
    let counter: String = redis
        .get(&format!("page:qa:retries:{page_id}"))
        .await
        .unwrap()
        .expect("counter incremented");
    assert_eq!(counter, "1", "retry recorded");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn hybrid_prepare_visibility_sweep() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;

    async fn insert_layer(
        pool: &sqlx::PgPool,
        z: i32,
        ltype: &str,
        visible: bool,
        page_id: Uuid,
    ) -> Uuid {
        sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO layers (id, created_at, type, visible, z_order, page_id) \
             VALUES (uuid_generate_v4(), now(), $1, $2, $3, $4) RETURNING id",
        )
        .bind(ltype)
        .bind(visible)
        .bind(z)
        .bind(page_id)
        .fetch_one(pool)
        .await
        .expect("layer insert")
    }
    // Older translation (visible), newest translation (visible), OCR (visible), SFX (hidden).
    let old_tl = insert_layer(&pool, 1, "translation", true, page_id).await;
    let new_tl = insert_layer(&pool, 2, "translation", true, page_id).await;
    let ocr_layer = insert_layer(&pool, 1, "ocr", true, page_id).await;
    let sfx = insert_layer(&pool, 1, "sfx", false, page_id).await;

    // One region so reject_sfx has something to act on.
    let region_id: Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, bbox_x, bbox_y, bbox_w, bbox_h, detected_language, text, page_id) \
         VALUES (uuid_generate_v4(), 0, 0, 10, 10, 'ja', 'hey', $1) RETURNING id",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("region");
    sqlx::query(
        "INSERT INTO layer_elements (id, text, size, font, font_style, font_weight, x, y, auto_size, word_wrap, overflow, visible, is_manually_edited, box_shape, max_width, max_height, rotation, layer_id, region_id) \
         VALUES (uuid_generate_v4(), '', 16.0, 'f', 'normal', 'normal', 0.0, 0.0, FALSE, FALSE, FALSE, TRUE, FALSE, 'rectangular', 10, 10, 0.0, $1, $2)",
    )
    .bind(new_tl)
    .bind(region_id)
    .execute(&pool)
    .await
    .expect("element in new tl");

    manga_backend::jobs::coordinator::prepare_hybrid_qa(&state, image_id, Some(page_id), &[])
        .await
        .expect("hybrid prepare runs");

    let visibility = |id: Uuid| {
        sqlx::query_scalar::<_, bool>("SELECT COALESCE(visible, TRUE) FROM layers WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
    };
    // Newest translation stays visible; older ones become history.
    assert!(
        visibility(new_tl).await.unwrap(),
        "newest translation visible"
    );
    assert!(
        !visibility(old_tl).await.unwrap(),
        "older translation hidden"
    );
    assert!(!visibility(ocr_layer).await.unwrap(), "ocr layer hidden");
    assert!(visibility(sfx).await.unwrap(), "sfx forced visible");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn reader_mode_short_circuits_after_layout() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    // Reader mode == source language equals target language.
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("en"), Some("en")).await;

    let (layout_job, layout_identity) =
        seed_stage_job(&pool, "layout", image_id, Some(page_id)).await;
    manga_backend::jobs::coordinator::CALLBACK_IDENTITY
        .scope(
            layout_identity,
            manga_backend::jobs::coordinator::handle_layout_callback(
                &state,
                Some(&layout_job),
                image_id,
                Some(page_id),
                &serde_json::json!({ "panels": [] }),
            ),
        )
        .await
        .expect("layout callback handled");

    let downstream: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs WHERE image_id=$1 AND type IN ('translation','render','qa')",
    )
    .bind(image_id)
    .fetch_one(&pool)
    .await
    .unwrap_or(0);
    assert_eq!(
        downstream, 0,
        "reader mode must not enqueue translation/render/qa"
    );

    cleanup_series(&pool, series_id).await;
}

/// A region the worker gave up on must not produce a visible element.
///
/// The worker reports it as translationFailed:true with a null translatedText, having already
/// tried the batch, a retry pass and a per-region fallback. The coordinator read that flag onto
/// ocr_regions but created the layer element with a hardcoded visible=TRUE, so the element kept
/// the region's mask_polygon and no text: it erased the artwork and drew nothing back. That is
/// the "empty bubble" — measured on 40 of 123 corpus pages.
#[tokio::test]
async fn failed_translation_does_not_create_a_visible_masking_element() {
    let Some((pool, _redis, state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL / REDIS not set");
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool, None, Some("en")).await;

    async fn region(pool: &sqlx::PgPool, page_id: Uuid, text: &str) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO ocr_regions (id, bbox_x, bbox_y, bbox_w, bbox_h, detected_language, text, \
             mask_polygon, region_type, page_id) \
             VALUES (uuid_generate_v4(), 10, 10, 80, 40, 'ja', $1, '[[10,10],[90,10],[90,50],[10,50]]', 'speech', $2) \
             RETURNING id",
        )
        .bind(text)
        .bind(page_id)
        .fetch_one(pool)
        .await
        .expect("region")
    }
    let ok_region = region(&pool, page_id, "こんにちは").await;
    let failed_region = region(&pool, page_id, "違うんです").await;

    let translations = vec![
        serde_json::json!({
            "regionId": ok_region.to_string(),
            "pageId": page_id.to_string(),
            "translatedText": "Hello",
            "translationFailed": false,
        }),
        serde_json::json!({
            "regionId": failed_region.to_string(),
            "pageId": page_id.to_string(),
            "translatedText": null,
            "translationFailed": true,
        }),
    ];

    let (tl_job, tl_identity) = seed_stage_job(&pool, "translation", image_id, Some(page_id)).await;
    manga_backend::jobs::coordinator::CALLBACK_IDENTITY
        .scope(
            tl_identity,
            manga_backend::jobs::coordinator::handle_translation_callback(
                &state,
                Some(&tl_job),
                image_id,
                &translations,
                None,
            ),
        )
        .await
        .expect("translation callback");

    // mask_polygon is JSONB, so it decodes as Value rather than String.
    async fn element(
        pool: &sqlx::PgPool,
        region_id: Uuid,
    ) -> (bool, Option<String>, Option<serde_json::Value>) {
        sqlx::query_as::<_, (bool, Option<String>, Option<serde_json::Value>)>(
            "SELECT e.visible, e.text, e.mask_polygon FROM layer_elements e \
             JOIN layers l ON l.id = e.layer_id \
             WHERE e.region_id = $1 AND l.type = 'translation' LIMIT 1",
        )
        .bind(region_id)
        .fetch_one(pool)
        .await
        .expect("element")
    }

    let (ok_visible, ok_text, _) = element(&pool, ok_region).await;
    assert!(ok_visible, "a translated region stays visible");
    assert_eq!(ok_text.as_deref(), Some("Hello"));

    let (failed_visible, failed_text, failed_mask) = element(&pool, failed_region).await;
    assert!(
        !failed_visible,
        "a region the worker gave up on must be hidden, or its mask erases the artwork \
         and puts nothing back"
    );
    assert!(failed_text.is_none() || failed_text.as_deref() == Some(""));
    assert!(
        failed_mask.is_some(),
        "the element still carries the mask — visibility is the only thing keeping it off the page"
    );

    cleanup_series(&pool, series_id).await;
}

/// OQ-02 / OQ-01: a verdict set is only applied when it covers exactly what the page displays
/// and judges the page's current scene. Missing, duplicate and unsubmitted-region sets are
/// incomplete; a verdict about an older revision is stale. Neither edits the page or passes it.
#[tokio::test]
async fn qa_rejects_incomplete_and_stale_verdicts() {
    let Some((pool, _redis, state)) = app().await else {
        panic!("coordinator_flows requires SPRING_DATASOURCE_URL and REDIS_TEST_ADDR");
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;
    let mut regions = Vec::new();
    for (z, text) in [(0, "first"), (1, "second")] {
        let region: Uuid = sqlx::query_scalar(
            "INSERT INTO ocr_regions (id, text, translated_text, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, page_id) \
             VALUES (uuid_generate_v4(),'src',$2,'ja',10,20,100,50,$1) RETURNING id",
        )
        .bind(page_id)
        .bind(text)
        .fetch_one(&pool)
        .await
        .expect("region");
        insert_translation_version(&pool, page_id, region, z, text, true, None).await;
        regions.push(region);
    }
    let (r1, r2) = (regions[0], regions[1]);
    let verdict = |id: Uuid, status: &str| {
        serde_json::json!({"regionId": id.to_string(), "qaStatus": status, "qaScore": 0.9,
                           "directFix": {"correctedText": "changed"}})
    };
    let run = |targets: Vec<Uuid>, results: Vec<serde_json::Value>, advance: bool| {
        let pool = pool.clone();
        let state = state.clone();
        async move {
            let (job, identity) = seed_stage_job(&pool, "qa", image_id, Some(page_id)).await;
            let accounting = bind_qa(&pool, &job, image_id, page_id, &targets).await;
            if advance {
                sqlx::query("UPDATE pages SET scene_revision = scene_revision + 1 WHERE id = $1")
                    .bind(page_id)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            manga_backend::jobs::coordinator::CALLBACK_IDENTITY
                .scope(
                    identity,
                    manga_backend::jobs::coordinator::handle_qa_callback(
                        &state,
                        Some(&job),
                        image_id,
                        Some(page_id),
                        &results,
                        None,
                        &accounting,
                    ),
                )
                .await
                .expect("qa callback")
        }
    };
    let untouched = |pool: sqlx::PgPool| async move {
        let statuses: Vec<Option<String>> =
            sqlx::query_scalar("SELECT qa_status FROM ocr_regions WHERE page_id=$1")
                .bind(page_id)
                .fetch_all(&pool)
                .await
                .unwrap();
        let changed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM layer_elements e JOIN layers l ON l.id=e.layer_id \
             WHERE l.page_id=$1 AND e.text='changed'",
        )
        .bind(page_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        statuses.iter().all(Option::is_none) && changed == 0
    };

    // Truncated: one of two submitted regions has no verdict.
    let outcome = run(vec![r1, r2], vec![verdict(r1, "direct_fix")], false).await;
    assert_eq!(outcome, "QA_INCOMPLETE");
    assert!(
        untouched(pool.clone()).await,
        "a partial set applies nothing"
    );
    let qa_status: Option<String> = sqlx::query_scalar(
        "SELECT metadata_json->'qa'->>'status' FROM layers WHERE page_id=$1 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(qa_status.as_deref(), Some("incomplete"));

    // A displayed region was never submitted to QA.
    let outcome = run(vec![r1], vec![verdict(r1, "passed")], false).await;
    assert_eq!(outcome, "QA_INCOMPLETE");

    // Duplicate verdicts for one region.
    let outcome = run(
        vec![r1, r2],
        vec![
            verdict(r1, "passed"),
            verdict(r1, "direct_fix"),
            verdict(r2, "passed"),
        ],
        false,
    )
    .await;
    assert_eq!(outcome, "QA_INCOMPLETE");
    assert!(untouched(pool.clone()).await);

    // Complete, but about a revision the page has moved past.
    let outcome = run(
        vec![r1, r2],
        vec![verdict(r1, "direct_fix"), verdict(r2, "passed")],
        true,
    )
    .await;
    assert_eq!(outcome, "STALE");
    assert!(
        untouched(pool.clone()).await,
        "a stale verdict cannot edit a newer scene"
    );

    // Complete and current: applied.
    let outcome = run(
        vec![r1, r2],
        vec![verdict(r1, "passed"), verdict(r2, "passed")],
        false,
    )
    .await;
    assert_eq!(outcome, "COMPLETED");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn cleanup_review_prevents_a_subset_qa_pass() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, _, page_id, image_id) = seed_pipeline(&pool, Some("ja"), Some("en")).await;
    let uncertain = Uuid::new_v4();
    sqlx::query("INSERT INTO ocr_regions (id, page_id, text, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, qa_status) VALUES ($1,$2,'uncertain','ja',0,0,20,20,'cleanup_review')")
        .bind(uncertain).bind(page_id).execute(&pool).await.unwrap();
    let target = Uuid::new_v4();
    let (job, identity) = seed_stage_job(&pool, "qa", image_id, Some(page_id)).await;
    let accounting = bind_qa(&pool, &job, image_id, page_id, &[target]).await;
    let result = manga_backend::jobs::coordinator::CALLBACK_IDENTITY
        .scope(
            identity,
            manga_backend::jobs::coordinator::handle_qa_callback(
                &state,
                Some(&job),
                image_id,
                Some(page_id),
                &[serde_json::json!({"regionId":target,"qaStatus":"passed","qaScore":1.0})],
                None,
                &accounting,
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        result, "MANUAL_REVIEW",
        "clean translated subset cannot hide uncertain source regions"
    );
    let status: Option<String> =
        sqlx::query_scalar("SELECT qa_status FROM ocr_regions WHERE id=$1")
            .bind(uncertain)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status.as_deref(), Some("cleanup_review"));
    cleanup_series(&pool, series_id).await;
}

async fn insert_region(
    pool: &sqlx::PgPool,
    page_id: Uuid,
    order: i32,
    qa_status: Option<&str>,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, bbox_x, bbox_y, bbox_w, bbox_h, detected_language, text, \
         mask_polygon, region_type, page_id, bubble_reading_order, qa_status) \
         VALUES (uuid_generate_v4(), 10, 10, 20, 20, 'ja', 'テキスト', '[[10,10],[30,10],[30,30],[10,30]]', \
                 'speech', $1, $2, $3) RETURNING id",
    )
    .bind(page_id)
    .bind(order)
    .bind(qa_status)
    .fetch_one(pool)
    .await
    .expect("region")
}

async fn translation_element(
    pool: &sqlx::PgPool,
    region_id: Uuid,
) -> (bool, Option<String>, Option<serde_json::Value>) {
    sqlx::query_as(
        "SELECT COALESCE(e.visible, FALSE), e.text, e.mask_polygon FROM layer_elements e \
         JOIN layers l ON l.id = e.layer_id \
         WHERE e.region_id = $1 AND l.type = 'translation' ORDER BY l.z_order DESC LIMIT 1",
    )
    .bind(region_id)
    .fetch_one(pool)
    .await
    .expect("translation element")
}

/// Uncertain regions (cleanup found no glyphs) are translated but start hidden with no mask, and
/// every OCR region gets a Translation row -- the worker's untranslated ones as hidden rows.
#[tokio::test]
async fn translation_keeps_one_row_per_region_and_hides_uncertain_ones() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, _, page_id, image_id) = seed_pipeline(&pool, Some("ja"), Some("en")).await;
    let normal = insert_region(&pool, page_id, 1, None).await;
    let uncertain = insert_region(&pool, page_id, 2, Some("cleanup_review")).await;
    let rejected = insert_region(&pool, page_id, 3, Some("rejected")).await;

    let translations = vec![
        serde_json::json!({"regionId": normal, "pageId": page_id, "translatedText": "Hello"}),
        serde_json::json!({"regionId": uncertain, "pageId": page_id, "translatedText": "Sign"}),
    ];
    let (job, identity) = seed_stage_job(&pool, "translation", image_id, Some(page_id)).await;
    manga_backend::jobs::coordinator::CALLBACK_IDENTITY
        .scope(
            identity,
            manga_backend::jobs::coordinator::handle_translation_callback(
                &state,
                Some(&job),
                image_id,
                &translations,
                None,
            ),
        )
        .await
        .expect("translation callback");

    let (visible, text, mask) = translation_element(&pool, normal).await;
    assert!(visible && text.as_deref() == Some("Hello") && mask.is_some());
    let (visible, text, mask) = translation_element(&pool, uncertain).await;
    assert!(!visible, "uncertain text waits for QA");
    assert_eq!(text.as_deref(), Some("Sign"));
    assert!(
        mask.is_none(),
        "no plate may be painted where cleanup found no glyphs"
    );
    let (visible, text, _) = translation_element(&pool, rejected).await;
    assert!(
        !visible && text.is_none(),
        "an untranslated region still has its row"
    );

    cleanup_series(&pool, series_id).await;
}

async fn seed_uncertain_page(pool: &sqlx::PgPool) -> (Uuid, Uuid, Uuid, Uuid, Uuid) {
    let (series_id, _, page_id, image_id) = seed_pipeline(pool, Some("ja"), Some("en")).await;
    let shown = insert_region(pool, page_id, 1, None).await;
    let uncertain = insert_region(pool, page_id, 2, Some("cleanup_review")).await;
    let layer_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1, 'translation', 'en', TRUE, 2, '{}'::jsonb, $2, now())",
    )
    .bind(layer_id)
    .bind(page_id)
    .execute(pool)
    .await
    .expect("layer");
    for (region, visible, text) in [(shown, true, "Hello"), (uncertain, false, "Sign")] {
        sqlx::query(
            "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, word_wrap, layer_id, region_id) \
             VALUES (uuid_generate_v4(), $1, 10, 10, 20, 20, $2, TRUE, $3, $4)",
        )
        .bind(text)
        .bind(visible)
        .bind(layer_id)
        .bind(region)
        .execute(pool)
        .await
        .expect("element");
    }
    (series_id, page_id, image_id, shown, uncertain)
}

async fn qa_with_checks(
    pool: &sqlx::PgPool,
    state: &manga_backend::state::AppState,
    image_id: Uuid,
    page_id: Uuid,
    shown: Uuid,
    checks: serde_json::Value,
) -> &'static str {
    let (job, identity) = seed_stage_job(pool, "qa", image_id, Some(page_id)).await;
    let mut accounting = bind_qa(pool, &job, image_id, page_id, &[shown]).await;
    accounting["uncertainChecks"] = checks;
    manga_backend::jobs::coordinator::CALLBACK_IDENTITY
        .scope(
            identity,
            manga_backend::jobs::coordinator::handle_qa_callback(
                state,
                Some(&job),
                image_id,
                Some(page_id),
                &[serde_json::json!({"regionId": shown, "qaStatus": "passed", "qaScore": 1.0})],
                None,
                &accounting,
            ),
        )
        .await
        .expect("qa callback")
}

/// QA calls the uncertain region a sign: it is rejected and stops holding the page for review.
#[tokio::test]
async fn qa_rejects_uncertain_background_text_without_asking_the_user() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, page_id, image_id, shown, uncertain) = seed_uncertain_page(&pool).await;
    let checks =
        serde_json::json!([{"regionId": uncertain, "kind": "sfx", "reason": "a drawn slurp"}]);
    let outcome = qa_with_checks(&pool, &state, image_id, page_id, shown, checks).await;

    assert_ne!(outcome, "MANUAL_REVIEW");
    let (status, feedback): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT qa_status, qa_feedback FROM ocr_regions WHERE id = $1")
            .bind(uncertain)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status.as_deref(), Some("rejected"));
    assert!(feedback.unwrap_or_default().contains("sound effect"));
    assert!(!translation_element(&pool, uncertain).await.0);
    cleanup_series(&pool, series_id).await;
}

/// QA calls it dialogue: the translation is drawn over the source (no plate) and stays flagged.
#[tokio::test]
async fn qa_shows_uncertain_dialogue_over_the_source_and_keeps_the_flag() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, page_id, image_id, shown, uncertain) = seed_uncertain_page(&pool).await;
    let checks = serde_json::json!([{"regionId": uncertain, "kind": "dialogue", "reason": "speech in a balloon."}]);
    let outcome = qa_with_checks(&pool, &state, image_id, page_id, shown, checks).await;

    assert_eq!(outcome, "MANUAL_REVIEW");
    let status: Option<String> =
        sqlx::query_scalar("SELECT qa_status FROM ocr_regions WHERE id = $1")
            .bind(uncertain)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status.as_deref(), Some("cleanup_review"));
    let (visible, _, mask) = translation_element(&pool, uncertain).await;
    assert!(visible, "QA-confirmed dialogue is drawn");
    assert!(mask.is_none());
    cleanup_series(&pool, series_id).await;
}

/// The Reader's Reject lifts a manual_review that only the rejected region was holding.
#[tokio::test]
async fn rejecting_the_last_flagged_region_lifts_manual_review() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, page_id, image_id, shown, uncertain) = seed_uncertain_page(&pool).await;
    let outcome = qa_with_checks(
        &pool,
        &state,
        image_id,
        page_id,
        shown,
        serde_json::json!([]),
    )
    .await;
    assert_eq!(
        outcome, "MANUAL_REVIEW",
        "an unanswered uncertain region still needs review"
    );

    sqlx::query("UPDATE ocr_regions SET qa_status = 'rejected' WHERE id = $1")
        .bind(uncertain)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    manga_backend::jobs::coordinator::refresh_review_summary(&mut tx, page_id)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let qa: serde_json::Value = sqlx::query_scalar(
        "SELECT metadata_json->'qa' FROM layers WHERE page_id = $1 AND type = 'translation'",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(qa["status"], "passed");
    assert_eq!(qa["cleanup_review"], 0);
    assert_eq!(qa["failed_regions"], serde_json::json!([]));
    cleanup_series(&pool, series_id).await;
}
