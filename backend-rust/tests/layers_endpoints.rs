//! End-to-end tests for the layer routes against REAL Postgres, porting
//! LayerControllerTest behavior: layer/element CRUD status codes, fractional zOrder
//! coercion (Jackson Number.intValue parity), element-update edit history + parent
//! metadata bump, Java defaults on element create, and ADMIN/TRANSLATOR-vs-viewer gating.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use uuid::Uuid;

use manga_backend::config::{DatabaseConfig, MinioConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
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

async fn app() -> Option<(Router, sqlx::PgPool, JwtUtils)> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let minio = MinioConfig {
        endpoint: "http://localhost:9000".into(),
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
    let jwt = JwtUtils::new(SECRET.into(), 3_600_000);
    let state = AppState::new(
        config,
        pool.clone(),
        jwt.clone(),
        MinioService::new(&minio),
        None,
    );
    Some((manga_backend::routes::build_router(state), pool, jwt))
}

async fn probe_user(pool: &sqlx::PgPool, jwt: &JwtUtils, role: &str) -> String {
    let email = format!("__layers-e2e-{role}-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Probe', $1, 'x', $2)",
    )
    .bind(&email)
    .bind(role)
    .execute(pool)
    .await
    .expect("probe user insert");
    jwt.generate_token(&email).expect("token")
}

/// Seeds series → chapter → page → image and clears leftovers first.
async fn seed_page(pool: &sqlx::PgPool) -> (Uuid, Uuid) {
    sqlx::query("DELETE FROM series WHERE title LIKE '__layers-e2e-%'")
        .execute(pool)
        .await
        .expect("pre-cleanup");
    let _ = sqlx::query("DELETE FROM users WHERE email LIKE '__layers-e2e-%'")
        .execute(pool)
        .await;

    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language) \
         VALUES ($1, now(), now(), '__layers-e2e-series__', 'rightToLeft', 'ja')",
    )
    .bind(series_id)
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
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'probe.png', 'originals/probe.png', 'hash-layers', 64, 64)",
    )
    .bind(image_id)
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

    (page_id, image_id)
}

async fn cleanup(pool: &sqlx::PgPool) {
    sqlx::query("DELETE FROM series WHERE title LIKE '__layers-e2e-%'")
        .execute(pool)
        .await
        .expect("cleanup series");
    let _ = sqlx::query("DELETE FROM users WHERE email LIKE '__layers-e2e-%'")
        .execute(pool)
        .await;
}

async fn send(
    app: Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    json: Option<String>,
) -> (StatusCode, String, String) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    if json.is_some() {
        builder = builder.header("Content-Type", "application/json");
    }
    let response = app
        .oneshot(builder.body(Body::from(json.unwrap_or_default())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        content_type,
        String::from_utf8_lossy(&bytes).to_string(),
    )
}

#[tokio::test]
async fn layer_and_element_lifecycle_with_gating() {
    let Some((app, pool, jwt)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };
    let (page_id, image_id) = seed_page(&pool).await;
    let translator = probe_user(&pool, &jwt, "translator").await;
    let viewer = probe_user(&pool, &jwt, "viewer").await;

    // --- unauthenticated mutating request is the security 403 Boot shape ---
    let (status, ctype, _) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers"),
        None,
        Some(r#"{"type":"translation"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        ctype, "application/json",
        "security denial, not problem+json"
    );

    // --- viewer is denied inside the controller with problem+json ---
    let (status, ctype, body) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers"),
        Some(&viewer),
        Some(r#"{"type":"translation"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(ctype, "application/problem+json");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["detail"],
        "You do not have permission to perform this action"
    );

    // --- create page layer: fractional zOrder coerces like Jackson (2.5 -> 2) ---
    let (status, _, body) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers"),
        Some(&translator),
        Some(
            r#"{"type":"translation","zOrder":2.5,"metadataJson":{"foo":"bar"},"targetLanguage":"en"}"#
                .into(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let layer: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(layer["zOrder"], 2, "fractional zOrder coerces like Jackson");
    assert_eq!(layer["visible"], true);
    assert_eq!(layer["metadataJson"]["foo"], "bar");
    let layer_id = layer["id"].as_str().unwrap().to_string();

    // --- create via the IMAGE path resolves the image's first page ---
    let (status, _, body) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/images/{image_id}/layers"),
        Some(&translator),
        Some(r#"{"type":"ocr","zOrder":1}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ocr_layer: serde_json::Value = serde_json::from_str(&body).unwrap();

    // --- create layer for unknown page -> 404 problem+json ---
    let (status, ctype, _) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/pages/{}/layers", Uuid::new_v4()),
        Some(&translator),
        Some(r#"{"type":"translation"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(ctype, "application/problem+json");

    // --- PUT /api/layers/{id}: fractional zOrder + visible=false ---
    let (status, _, _) = send(
        app.clone(),
        "PUT",
        &format!("/tlhub/api/layers/{layer_id}"),
        Some(&translator),
        Some(r#"{"zOrder":3.5,"visible":false}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let z: i32 = sqlx::query_scalar("SELECT z_order FROM layers WHERE id = $1")
        .bind(Uuid::parse_str(&layer_id).unwrap())
        .fetch_one(&pool)
        .await
        .expect("layer row");
    assert_eq!(z, 3, "update also coerces fractionals");
    let visible: bool = sqlx::query_scalar("SELECT visible FROM layers WHERE id = $1")
        .bind(Uuid::parse_str(&layer_id).unwrap())
        .fetch_one(&pool)
        .await
        .expect("layer row");
    assert!(!visible);
    // PUT on unknown id -> plain 404.
    let (status, _, _) = send(
        app.clone(),
        "PUT",
        &format!("/tlhub/api/layers/{}", Uuid::new_v4()),
        Some(&translator),
        Some(r#"{"zOrder":1}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // --- element create applies the Java defaults ---
    let (status, _, body) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/layers/{layer_id}/elements"),
        Some(&translator),
        Some(r#"{"text":"hello"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let element: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(element["text"], "hello");
    assert_eq!(element["font"], "Comic Neue", "Java default font");
    assert_eq!(element["fontStyle"], "normal");
    assert_eq!(element["fontWeight"], "normal");
    assert_eq!(element["size"], 16.0);
    assert_eq!(element["maxWidth"], 150);
    assert_eq!(element["maxHeight"], 80);
    assert_eq!(element["x"], 100.0);
    assert_eq!(element["y"], 100.0);
    assert_eq!(element["boxShape"], "rectangular");
    assert_eq!(element["autoSize"], false);
    assert_eq!(element["wordWrap"], false);
    assert_eq!(element["visible"], true);
    assert_eq!(element["overflow"], false);
    assert_eq!(element["isManuallyEdited"], false);
    let element_id = element["id"].as_str().unwrap().to_string();

    // --- create element under unknown layer -> plain 404 ---
    let (status, _, _) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/layers/{}/elements", Uuid::new_v4()),
        Some(&translator),
        Some(r#"{"text":"x"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // --- element update writes history + bumps parent layer metadata ---
    let (status, _, body) = send(
        app.clone(),
        "PUT",
        &format!("/tlhub/api/layer-elements/{element_id}"),
        Some(&translator),
        Some(r#"{"text":"new text"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let updated: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(updated["text"], "new text");
    assert_eq!(updated["isManuallyEdited"], true);

    let history_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM layer_edit_history WHERE layer_element_id = $1")
            .bind(Uuid::parse_str(&element_id).unwrap())
            .fetch_one(&pool)
            .await
            .expect("history count");
    assert_eq!(
        history_count, 1,
        "changed state records exactly one history row"
    );

    let meta_bumped: bool =
        sqlx::query_scalar("SELECT metadata_json ? 'last_modified' FROM layers WHERE id = $1")
            .bind(Uuid::parse_str(&layer_id).unwrap())
            .fetch_one(&pool)
            .await
            .expect("metadata check");
    assert!(meta_bumped, "parent layer metadata gains last_modified");

    // --- no-change update records NO extra history ---
    let (status, _, _) = send(
        app.clone(),
        "PUT",
        &format!("/tlhub/api/layer-elements/{element_id}"),
        Some(&translator),
        Some(r#"{"text":"new text"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let history_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM layer_edit_history WHERE layer_element_id = $1")
            .bind(Uuid::parse_str(&element_id).unwrap())
            .fetch_one(&pool)
            .await
            .expect("history count");
    assert_eq!(history_count, 1, "identical state must not add history");

    // --- history endpoint lists newest first; viewer denied ---
    let (status, _, _) = send(
        app.clone(),
        "GET",
        &format!("/tlhub/api/layer-elements/{element_id}/history"),
        Some(&translator),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, ctype, _) = send(
        app.clone(),
        "GET",
        &format!("/tlhub/api/layer-elements/{element_id}/history"),
        Some(&viewer),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(ctype, "application/problem+json");

    // --- element 404s ---
    let (status, _, _) = send(
        app.clone(),
        "PUT",
        &format!("/tlhub/api/layer-elements/{}", Uuid::new_v4()),
        Some(&translator),
        Some("{}".into()),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // --- delete element then layer ---
    let (status, _, _) = send(
        app.clone(),
        "DELETE",
        &format!("/tlhub/api/layer-elements/{element_id}"),
        Some(&translator),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layer_elements WHERE id = $1")
        .bind(Uuid::parse_str(&element_id).unwrap())
        .fetch_one(&pool)
        .await
        .expect("element gone");
    assert_eq!(gone, 0);

    let (status, _, _) = send(
        app.clone(),
        "DELETE",
        &format!("/tlhub/api/layers/{layer_id}"),
        Some(&translator),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = send(
        app.clone(),
        "DELETE",
        &format!("/tlhub/api/layers/{}", Uuid::new_v4()),
        Some(&translator),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // ocr layer still present until its page goes away with cleanup.
    let _ = ocr_layer;
    cleanup(&pool).await;
}

/// Codex, third pass. The overlay hides the element it replaces so the two do not composite, but
/// that flag lives on the element rather than on the overlay — so toggling the overlay off, or
/// deleting it to get back to the previous reading, left the bubble blank instead of reverting it.
/// The original was still in the database and still unreachable, which defeats keeping it at all.
#[tokio::test]
async fn hiding_or_deleting_a_redo_overlay_gives_the_original_back() {
    let Some((app, pool, jwt)) = app().await else {
        return;
    };
    // Deliberately not seed_page/probe_user: both key off '__layers-e2e-%' and wipe it on entry,
    // so sharing them with the other test in this file means whichever seeds second deletes the
    // other's user out from under it. This fixture is named so nothing else claims it.
    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language) \
         VALUES ($1, now(), now(), '__layers-redo-overlay-series__', 'rightToLeft', 'ja')",
    )
    .bind(series_id)
    .execute(&pool)
    .await
    .expect("series");
    let chapter_id = Uuid::new_v4();
    sqlx::query("INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id) VALUES ($1, 1, now(), now(), TRUE, $2)")
        .bind(chapter_id)
        .bind(series_id)
        .execute(&pool)
        .await
        .expect("chapter");
    let image_id = Uuid::new_v4();
    sqlx::query("INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) VALUES ($1, now(), 'probe.png', 'originals/redo-overlay.png', $2, 64, 64)")
        .bind(image_id)
        .bind(format!("hash-redo-{image_id}"))
        .execute(&pool)
        .await
        .expect("image");
    let page_id = Uuid::new_v4();
    sqlx::query("INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, 1, $2, $3)")
        .bind(page_id)
        .bind(chapter_id)
        .bind(image_id)
        .execute(&pool)
        .await
        .expect("page");

    let email = format!("__layers-redo-overlay-{}@example.invalid", Uuid::new_v4());
    sqlx::query("INSERT INTO users (id, created_at, display_name, email, password_hash, role) VALUES (uuid_generate_v4(), now(), 'Probe', $1, 'x', 'EDITOR')")
        .bind(&email)
        .execute(&pool)
        .await
        .expect("user");
    let token = jwt.generate_token(&email).expect("token");

    let region_id = Uuid::new_v4();
    sqlx::query("INSERT INTO ocr_regions (id, text, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, page_id) VALUES ($1,'あんなに','ja',10,20,100,50,$2)")
        .bind(region_id)
        .bind(page_id)
        .execute(&pool)
        .await
        .expect("region");

    // The reading that is on screen…
    let base_layer = Uuid::new_v4();
    let base_element = Uuid::new_v4();
    sqlx::query("INSERT INTO layers (id, type, visible, z_order, metadata_json, page_id, created_at) VALUES ($1,'translation',TRUE,0,$2,$3,now())")
        .bind(base_layer)
        .bind(serde_json::json!({"layer_name": "Translation"}))
        .bind(page_id)
        .execute(&pool)
        .await
        .expect("base layer");
    sqlx::query("INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) VALUES ($1,'original',10,20,100,50,TRUE,$2,$3)")
        .bind(base_element)
        .bind(base_layer)
        .bind(region_id)
        .execute(&pool)
        .await
        .expect("base element");

    // …and the overlay that replaced it, recording what it hid.
    let overlay = Uuid::new_v4();
    sqlx::query("INSERT INTO layers (id, type, visible, z_order, metadata_json, page_id, created_at) VALUES ($1,'translation',TRUE,1,$2,$3,now())")
        .bind(overlay)
        .bind(serde_json::json!({
            "layer_name": "Translation (region redo)",
            "overlay": true,
            "region_id": region_id.to_string(),
            "superseded_elements": [base_element.to_string()],
        }))
        .bind(page_id)
        .execute(&pool)
        .await
        .expect("overlay layer");
    sqlx::query("INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) VALUES ($1,'redone',10,20,100,50,TRUE,$2,$3)")
        .bind(Uuid::new_v4())
        .bind(overlay)
        .bind(region_id)
        .execute(&pool)
        .await
        .expect("overlay element");
    sqlx::query("UPDATE layer_elements SET visible = FALSE WHERE id = $1")
        .bind(base_element)
        .execute(&pool)
        .await
        .expect("hide base");

    let base_visible = |pool: sqlx::PgPool| async move {
        sqlx::query_scalar::<_, Option<bool>>("SELECT visible FROM layer_elements WHERE id = $1")
            .bind(base_element)
            .fetch_one(&pool)
            .await
            .unwrap()
    };

    // Toggle the overlay off — the original comes back.
    let (status, _, _) = send(
        app.clone(),
        "PUT",
        &format!("/tlhub/api/layers/{overlay}"),
        Some(&token),
        Some(serde_json::json!({"visible": false}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        base_visible(pool.clone()).await,
        Some(true),
        "hiding the overlay must restore what it replaced, not blank the bubble"
    );

    // Toggle it back on — the original steps aside again so the two never composite.
    let (status, _, _) = send(
        app.clone(),
        "PUT",
        &format!("/tlhub/api/layers/{overlay}"),
        Some(&token),
        Some(serde_json::json!({"visible": true}).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(base_visible(pool.clone()).await, Some(false));

    // Delete the overlay — same again, and this time permanently.
    let (status, _, _) = send(
        app.clone(),
        "DELETE",
        &format!("/tlhub/api/layers/{overlay}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        base_visible(pool.clone()).await,
        Some(true),
        "deleting the overlay must leave the previous reading showing"
    );

    sqlx::query("DELETE FROM series WHERE id = $1")
        .bind(series_id)
        .execute(&pool)
        .await
        .expect("cleanup series");
    sqlx::query("DELETE FROM users WHERE email = $1")
        .bind(&email)
        .execute(&pool)
        .await
        .expect("cleanup user");
}
