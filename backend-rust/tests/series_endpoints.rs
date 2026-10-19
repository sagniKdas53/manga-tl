//! End-to-end tests for /api/series CRUD against a REAL Postgres, mirroring the Java
//! wire contract: language fallbacks, 409 duplicates, resolved model slots, pagination,
//! ADMIN-only series deletion, cover recalculation.

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
        self_hosted_admin: false,
        minio: MinioConfig {
            endpoint: "http://localhost:9000".into(),
            external_url: None,
            access_key: Some("minioadmin".into()),
            secret_key: Some("minioadmin".into()),
        },
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
        MinioService::new(&MinioConfig {
            endpoint: "http://localhost:9000".into(),
            external_url: None,
            access_key: Some("minioadmin".into()),
            secret_key: Some("minioadmin".into()),
        }),
        None,
    );
    Some((manga_backend::routes::build_router(state), pool, jwt))
}

/// Creates a throwaway user directly (bypassing register's admin rules) and returns a token.
/// Removes probe users AND any series they own (FK fkit9xuhijj1sr30xihwikew938 blocks
/// user deletion otherwise — e.g. after a previous run died mid-test).
async fn cleanup(pool: &sqlx::PgPool) {
    sqlx::query(
        "DELETE FROM series WHERE created_by IN (SELECT id FROM users WHERE email LIKE '__series-e2e-%')",
    )
    .execute(pool)
    .await
    .expect("cleanup series");
    sqlx::query("DELETE FROM users WHERE email LIKE '__series-e2e-%'")
        .execute(pool)
        .await
        .expect("cleanup users");
}

async fn probe_user(pool: &sqlx::PgPool, jwt: &JwtUtils, role: &str) -> String {
    let email = format!("__series-e2e-{role}-{}@example.invalid", Uuid::new_v4());
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

async fn send(
    app: Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    json: Option<String>,
) -> axum::http::Response<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    if json.is_some() {
        builder = builder.header("Content-Type", "application/json");
    }
    app.oneshot(builder.body(Body::from(json.unwrap_or_default())).unwrap())
        .await
        .unwrap()
}

async fn body_string(response: axum::http::Response<Body>) -> (StatusCode, String, String) {
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
async fn series_and_chapter_crud_lifecycle() {
    let Some((app, pool, jwt)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };
    cleanup(&pool).await; // clear leftovers from any earlier crashed run
    let viewer_token = probe_user(&pool, &jwt, "viewer").await;
    let admin_token = probe_user(&pool, &jwt, "admin").await;

    // --- create: language fallbacks ja/en, inherit cleaned to NULL ---
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/series",
            Some(&viewer_token),
            Some(
                r#"{"title":"Rust Probe Series","sourceLanguage":"inherit","readingDirection":"rightToLeft"}"#
                    .into(),
            ),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let created: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(created["originalLanguage"], "ja", "orig lang fallback");
    assert_eq!(created["targetLanguage"], "en", "target lang fallback");
    assert_eq!(created["resolvedUseFallbackModels"], true);
    assert!(created["id"].as_str().is_some());
    let series_id = created["id"].as_str().unwrap().to_string();

    // --- unauthenticated create is the security 403 shape ---
    let (status, ctype, _) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/series",
            None,
            Some("{}".into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Security denials come from Boot error attributes -> application/json (verified live),
    // unlike @PreAuthorize denials inside controllers which are problem+json.
    assert_eq!(ctype, "application/json");

    // --- create WITHOUT readingDirection panics on the NOT NULL column; Java's catch-all
    // turns that into the generic 500 problem+json, and our CatchPanicLayer matches it.
    let (status, ctype, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/series",
            Some(&viewer_token),
            Some(r#"{"title":"Missing Dir"}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(ctype, "application/problem+json");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["detail"],
        "An unexpected internal error occurred"
    );

    // --- chapter create: defaults + global-source resolution ---
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            &format!("/tlhub/api/series/{series_id}/chapters"),
            Some(&viewer_token),
            Some(r#"{"chapterNumber":1,"title":"Chapter One"}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ch1: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(ch1["chapterNumber"], 1.0);
    assert_eq!(ch1["pageCount"], 0);
    assert_eq!(ch1["useContextMemory"], true, "create default true");
    assert_eq!(ch1["resolvedOcr"]["source"], "global");
    assert_eq!(ch1["resolvedQa"]["mode"], ch1["resolvedQa"]["mode"]); // shape present

    // --- duplicate number -> exact 409 JSON message ---
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            &format!("/tlhub/api/series/{series_id}/chapters"),
            Some(&viewer_token),
            Some(r#"{"chapterNumber":1}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("already exists in this series")
    );

    // --- second chapter; list ordering asc by number ---
    let _ = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/series/{series_id}/chapters"),
        Some(&viewer_token),
        Some(r#"{"chapterNumber":2.5}"#.into()),
    )
    .await;
    let (_, _, body) = body_string(
        send(
            app.clone(),
            "GET",
            &format!("/tlhub/api/series/{series_id}/chapters?page=0&size=15"),
            Some(&viewer_token),
            None,
        )
        .await,
    )
    .await;
    let list: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(list["totalElements"], 2);
    assert_eq!(list["totalPages"], 1);
    assert_eq!(list["content"].as_array().unwrap()[0]["chapterNumber"], 1.0);

    // --- update renumber conflict excluding self ---
    let ch1_id = ch1["id"].as_str().unwrap();
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "PUT",
            &format!("/tlhub/api/series/chapters/{ch1_id}"),
            Some(&viewer_token),
            Some(r#"{"chapterNumber":2.5}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    // --- PUT /me-style no-op guard is auth-specific; here: series rename ---
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "PUT",
            &format!("/tlhub/api/series/{series_id}"),
            Some(&viewer_token),
            Some(
                r#"{"title":"Renamed Probe","targetLanguage":"inherit","readingDirection":"rightToLeft"}"#
                    .into(),
            ),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["title"],
        "Renamed Probe"
    );

    // --- deleteSeries as viewer -> AccessDenied problem+json ---
    let (status, ctype, body) = body_string(
        send(
            app.clone(),
            "DELETE",
            &format!("/tlhub/api/series/{series_id}"),
            Some(&viewer_token),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(ctype, "application/problem+json");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["detail"],
        "You do not have permission to perform this action"
    );

    // --- admin deletes; cascade removes chapters ---
    let (status, _, _) = body_string(
        send(
            app.clone(),
            "DELETE",
            &format!("/tlhub/api/series/{series_id}"),
            Some(&admin_token),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chapters WHERE id = $1")
        .bind(
            ch1["id"]
                .as_str()
                .unwrap()
                .parse::<uuid::Uuid>()
                .expect("uuid"),
        )
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    assert_eq!(remaining, 0, "chapters must cascade with their series");

    cleanup(&pool).await;
}

/// SeriesControllerTest addition: pagination/sort whitelists — sortBy accepts only the
/// allowed columns (anything else falls back), sortDir steers asc/desc.
#[tokio::test]
async fn series_list_pagination_and_sort_whitelist() {
    let Some((app, pool, jwt)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };
    // Distinct namespace: the sibling test in this binary sweeps __series-e2e-% at
    // its start/end, which would delete this test's user mid-run when parallel.
    const NS: &str = "__seriessort-e2e";
    sqlx::query("DELETE FROM series WHERE title LIKE 'SortProbe %'")
        .execute(&pool)
        .await
        .expect("pre-clean series");
    let _ = sqlx::query("DELETE FROM users WHERE email LIKE $1 || '%'")
        .bind(NS)
        .execute(&pool)
        .await;
    let email = format!("{NS}-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Probe', $1, 'x', 'viewer')",
    )
    .bind(&email)
    .execute(&pool)
    .await
    .expect("probe user");
    let token = jwt.generate_token(&email).expect("token");

    // Create three probe series with titles whose alphabetical order differs from
    // creation order.
    for title in ["SortProbe Charlie", "SortProbe Alpha", "SortProbe Bravo"] {
        let (status, _, body) = body_string(
            send(
                app.clone(),
                "POST",
                "/tlhub/api/series",
                Some(&token),
                Some(format!(
                    r#"{{"title":"{title}","readingDirection":"rightToLeft"}}"#
                )),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let titles_of = |body: String| -> Vec<String> {
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["title"].as_str().unwrap().to_string())
            .collect()
    };

    // Shared live database: other users own series too, so scope every assertion to
    // the probe titles' RELATIVE order instead of absolute windows.
    let probe_titles = |body: &str| -> Vec<String> {
        titles_of(body.to_string())
            .into_iter()
            .filter(|t| t.starts_with("SortProbe "))
            .collect()
    };

    // The series sort whitelist is exactly {createdAt, updatedAt} (Java
    // SERIES_SORT_FIELDS); alphabetical title sorting is NOT offered.
    let (_, _, body) = body_string(
        send(
            app.clone(),
            "GET",
            "/tlhub/api/series?size=100&sortBy=createdAt&sortDir=asc",
            Some(&token),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(
        probe_titles(&body),
        ["SortProbe Charlie", "SortProbe Alpha", "SortProbe Bravo"],
        "creation order asc"
    );

    let (_, _, body) = body_string(
        send(
            app.clone(),
            "GET",
            "/tlhub/api/series?size=100&sortBy=createdAt&sortDir=desc",
            Some(&token),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(
        probe_titles(&body),
        ["SortProbe Bravo", "SortProbe Alpha", "SortProbe Charlie"],
        "desc flips the creation order"
    );

    // Non-whitelisted column silently falls back to updatedAt — no error, no leak.
    let (_, _, body) = body_string(
        send(
            app.clone(),
            "GET",
            "/tlhub/api/series?size=100&sortBy=DROP_TABLE_series",
            Some(&token),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(
        probe_titles(&body).len(),
        3,
        "fallback still lists everything"
    );

    // Pagination math still verifiable through the envelope shape.
    let (_, _, paged) = body_string(
        send(
            app.clone(),
            "GET",
            "/tlhub/api/series?page=1&size=2&sortBy=title&sortDir=asc",
            Some(&token),
            None,
        )
        .await,
    )
    .await;
    let envelope: serde_json::Value = serde_json::from_str(&paged).unwrap();
    assert_eq!(envelope["size"], 2);
    assert_eq!(envelope["page"], 1, "second window");
    assert!(envelope["totalElements"].as_i64().unwrap() >= 3);

    // Scoped cleanup (see NS above).
    sqlx::query(
        "DELETE FROM series WHERE created_by IN (SELECT id FROM users WHERE email LIKE '__seriessort-e2e%')",
    )
    .execute(&pool)
    .await
    .expect("series cleanup");
    sqlx::query("DELETE FROM users WHERE email LIKE '__seriessort-e2e%'")
        .execute(&pool)
        .await
        .expect("user cleanup");
}

/// #226: a one-shot is a series of kind `oneshot` holding exactly one chapter. Creating one
/// makes both in one call; a second chapter is refused; `?kind=` filters the library list;
/// deleting the chapter removes the one-shot, while a regular series keeps living.
#[tokio::test]
async fn oneshot_create_one_chapter_rule_and_kind_filter() {
    let Some((app, pool, jwt)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };
    // Its own probe prefix: cleanup() removes every `__series-e2e-` user and their series, and
    // the CRUD test runs it beside this one.
    oneshot_cleanup(&pool).await;
    let email = format!("__oneshot-e2e-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Probe', $1, 'x', 'translator')",
    )
    .bind(&email)
    .execute(&pool)
    .await
    .expect("probe user insert");
    let token = jwt.generate_token(&email).expect("token");

    let (status, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/series/oneshots",
            Some(&token),
            Some(
                r#"{"title":"  Probe One-shot ","sourceLanguage":"zh","qaMode":"off","useContextMemory":false}"#
                    .into(),
            ),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let created: serde_json::Value = serde_json::from_str(&body).unwrap();
    let series = &created["series"];
    let chapter = &created["chapter"];
    assert_eq!(series["kind"], "oneshot");
    assert_eq!(series["title"], "Probe One-shot");
    assert_eq!(series["originalLanguage"], "zh");
    assert_eq!(series["targetLanguage"], "en", "target lang fallback");
    assert_eq!(series["readingDirection"], "rtl", "direction fallback");
    assert_eq!(series["oneshotChapterId"], chapter["id"]);
    assert_eq!(chapter["seriesId"], series["id"]);
    assert_eq!(chapter["chapterNumber"], 1.0);
    assert_eq!(chapter["title"], "Probe One-shot");
    assert_eq!(chapter["qaMode"], "off", "overrides go on the chapter");
    assert_eq!(chapter["useContextMemory"], false);
    assert!(series["qaMode"].is_null());
    let oneshot_id = series["id"].as_str().unwrap().to_string();
    let chapter_id = chapter["id"].as_str().unwrap().to_string();

    // GET returns the chapter id too.
    let (_, _, body) = body_string(
        send(
            app.clone(),
            "GET",
            &format!("/tlhub/api/series/{oneshot_id}"),
            Some(&token),
            None,
        )
        .await,
    )
    .await;
    let fetched: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(fetched["oneshotChapterId"], chapter_id.as_str());

    // A blank title is refused.
    let (status, _, _) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/series/oneshots",
            Some(&token),
            Some(r#"{"title":"   "}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A second chapter is refused by create.
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            &format!("/tlhub/api/series/{oneshot_id}/chapters"),
            Some(&token),
            Some(r#"{"chapterNumber":2}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["message"],
        "A one-shot holds one chapter. Move it into a series first."
    );

    // A regular series beside it, with two chapters.
    let (_, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/series",
            Some(&token),
            Some(r#"{"title":"Probe Regular","readingDirection":"rtl"}"#.into()),
        )
        .await,
    )
    .await;
    let regular: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(regular["kind"], "series");
    assert!(regular["oneshotChapterId"].is_null());
    let regular_id = regular["id"].as_str().unwrap().to_string();
    let mut regular_chapters = Vec::new();
    for number in [1, 2] {
        let (status, _, body) = body_string(
            send(
                app.clone(),
                "POST",
                &format!("/tlhub/api/series/{regular_id}/chapters"),
                Some(&token),
                Some(format!(r#"{{"chapterNumber":{number}}}"#)),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let chapter: serde_json::Value = serde_json::from_str(&body).unwrap();
        regular_chapters.push(chapter["id"].as_str().unwrap().to_string());
    }

    // ?kind= narrows the list and its count; anything else lists both.
    let listed = |kind: &'static str| {
        let app = app.clone();
        let token = token.clone();
        async move {
            let (status, _, body) = body_string(
                send(
                    app,
                    "GET",
                    &format!("/tlhub/api/series?size=100{kind}"),
                    Some(&token),
                    None,
                )
                .await,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let page: serde_json::Value = serde_json::from_str(&body).unwrap();
            let ids: Vec<String> = page["content"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["id"].as_str().unwrap().to_string())
                .collect();
            let kinds: Vec<String> = page["content"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["kind"].as_str().unwrap().to_string())
                .collect();
            (ids, kinds, page["totalElements"].as_i64().unwrap())
        }
    };
    let (ids, kinds, total) = listed("&kind=oneshot").await;
    assert!(ids.contains(&oneshot_id) && !ids.contains(&regular_id));
    assert!(kinds.iter().all(|k| k == "oneshot"));
    assert_eq!(total, ids.len() as i64, "the count is filtered too");
    let (ids, kinds, _) = listed("&kind=series").await;
    assert!(ids.contains(&regular_id) && !ids.contains(&oneshot_id));
    assert!(kinds.iter().all(|k| k == "series"));
    for all in ["", "&kind=volume"] {
        let (ids, _, _) = listed(all).await;
        assert!(ids.contains(&regular_id) && ids.contains(&oneshot_id));
    }

    // Deleting a regular series' chapters never deletes the series.
    for chapter in &regular_chapters {
        let response = send(
            app.clone(),
            "DELETE",
            &format!("/tlhub/api/series/chapters/{chapter}"),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    let response = send(
        app.clone(),
        "GET",
        &format!("/tlhub/api/series/{regular_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK, "an empty series stays");

    // Deleting a one-shot's chapter removes the one-shot.
    let response = send(
        app.clone(),
        "DELETE",
        &format!("/tlhub/api/series/chapters/{chapter_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = send(
        app.clone(),
        "GET",
        &format!("/tlhub/api/series/{oneshot_id}"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    oneshot_cleanup(&pool).await;
}

async fn oneshot_cleanup(pool: &sqlx::PgPool) {
    sqlx::query(
        "DELETE FROM series WHERE created_by IN (SELECT id FROM users WHERE email LIKE '__oneshot-e2e-%')",
    )
    .execute(pool)
    .await
    .expect("cleanup one-shot series");
    sqlx::query("DELETE FROM users WHERE email LIKE '__oneshot-e2e-%'")
        .execute(pool)
        .await
        .expect("cleanup one-shot users");
}

/// #226: the upgrade script is safe to run again on a database that already has the column.
#[tokio::test]
async fn oneshot_upgrade_script_reruns() {
    let Some((_, pool, _)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };
    let script = include_str!("../../database/migrations/2026-10-19-oneshot-series-kind.sql");
    for run in 1..=2 {
        sqlx::raw_sql(script)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("upgrade script run {run}: {e}"));
    }
    let checks: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pg_constraint WHERE conname = 'series_kind_check'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(checks, 1);
}

/// A probe user of its own prefix, for tests that run beside the CRUD test (see `cleanup()`).
async fn move_probe(pool: &sqlx::PgPool, jwt: &JwtUtils) -> String {
    let email = format!("__move-e2e-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Probe', $1, 'x', 'translator')",
    )
    .bind(&email)
    .execute(pool)
    .await
    .expect("probe user insert");
    jwt.generate_token(&email).expect("token")
}

async fn move_cleanup(pool: &sqlx::PgPool) {
    sqlx::query(
        "DELETE FROM series WHERE created_by IN (SELECT id FROM users WHERE email LIKE '__move-e2e-%')",
    )
    .execute(pool)
    .await
    .expect("cleanup move series");
    sqlx::query("DELETE FROM images WHERE filename = '__move-e2e-cover.png'")
        .execute(pool)
        .await
        .expect("cleanup move images");
    sqlx::query("DELETE FROM users WHERE email LIKE '__move-e2e-%'")
        .execute(pool)
        .await
        .expect("cleanup move users");
}

async fn json_of(response: axum::http::Response<Body>) -> (StatusCode, serde_json::Value) {
    let (status, _, body) = body_string(response).await;
    (
        status,
        serde_json::from_str(&body).unwrap_or(serde_json::Value::Null),
    )
}

/// #226 / #218: moving chapters series -> series, series -> one-shot and one-shot -> series, with
/// covers and counts right on both sides, the emptied one-shot gone, clashes answered with the next
/// free number, and `keepSettings` pinning what the move would change.
#[tokio::test]
async fn chapter_moves_between_series_and_oneshots() {
    let Some((app, pool, jwt)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };
    move_cleanup(&pool).await;
    let token = move_probe(&pool, &jwt).await;
    let post = |uri: String, body: String| {
        let app = app.clone();
        let token = token.clone();
        async move { json_of(send(app, "POST", &uri, Some(&token), Some(body)).await).await }
    };
    let get = |uri: String| {
        let app = app.clone();
        let token = token.clone();
        async move { json_of(send(app, "GET", &uri, Some(&token), None).await).await }
    };

    // Series A (tlModel old/tl, ko, ltr) with chapters 1 and 2; series B (tlModel new/tl) with 1.
    let (_, a) = post(
        "/tlhub/api/series".into(),
        r#"{"title":"Move A","sourceLanguage":"ko","readingDirection":"ltr","tlModel":"old/tl"}"#
            .into(),
    )
    .await;
    let (_, b) = post(
        "/tlhub/api/series".into(),
        r#"{"title":"Move B","readingDirection":"rtl","tlModel":"new/tl"}"#.into(),
    )
    .await;
    let a_id = a["id"].as_str().unwrap().to_string();
    let b_id = b["id"].as_str().unwrap().to_string();
    let mut a_chapters = Vec::new();
    for (number, title) in [(1, "First"), (2, "Second")] {
        let (status, c) = post(
            format!("/tlhub/api/series/{a_id}/chapters"),
            format!(r#"{{"chapterNumber":{number},"title":"{title}"}}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        a_chapters.push(c["id"].as_str().unwrap().to_string());
    }
    let (_, b1) = post(
        format!("/tlhub/api/series/{b_id}/chapters"),
        r#"{"chapterNumber":1}"#.into(),
    )
    .await;

    // Chapter 2 of A carries a cover, so A's cover is its; after the move it must be B's.
    let cover = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash) \
         VALUES ($1, now(), '__move-e2e-cover.png', 'originals/x.png', $2)",
    )
    .bind(cover)
    .bind(format!("{:064x}", cover.as_u128()))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE chapters SET cover_image_id = $1 WHERE id = $2::uuid")
        .bind(cover)
        .bind(&a_chapters[1])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE series SET cover_image_id = $1 WHERE id = $2::uuid")
        .bind(cover)
        .bind(&a_id)
        .execute(&pool)
        .await
        .unwrap();

    let move_uri = |chapter: &str| format!("/tlhub/api/series/chapters/{chapter}/move");

    // Bad bodies.
    for body in [
        r#"{}"#.to_string(),
        format!(r#"{{"seriesId":"{b_id}","oneshot":true}}"#),
    ] {
        let (status, _) = post(move_uri(&a_chapters[1]), body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, _) = post(
        move_uri(&a_chapters[1]),
        format!(r#"{{"seriesId":"{a_id}"}}"#),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "already in that series");

    // A clash on chapter number answers 409 with the next free number in B.
    let (status, clash) = post(
        move_uri(&a_chapters[0]),
        format!(r#"{{"seriesId":"{b_id}"}}"#),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(clash["nextFreeNumber"], 2.0);

    // Series -> series, without keepSettings: the chapter inherits B's model.
    let (status, moved) = post(
        move_uri(&a_chapters[1]),
        format!(r#"{{"seriesId":"{b_id}","chapterNumber":5}}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved["chapter"]["seriesId"], b_id.as_str());
    assert_eq!(moved["chapter"]["chapterNumber"], 5.0);
    assert!(moved["chapter"]["tlModel"].is_null());
    assert_eq!(moved["chapter"]["resolvedTranslation"]["model"], "new/tl");
    assert!(moved["removedSeriesId"].is_null());
    assert!(
        moved["series"]["coverImageUrl"]
            .as_str()
            .unwrap()
            .contains(&cover.to_string()),
        "B takes the moved chapter's cover"
    );
    let (_, a_now) = get(format!("/tlhub/api/series/{a_id}")).await;
    assert!(a_now["coverImageUrl"].is_null(), "A's cover left with it");
    let (_, a_list) = get(format!("/tlhub/api/series/{a_id}/chapters")).await;
    assert_eq!(a_list["totalElements"], 1);
    let (_, b_list) = get(format!("/tlhub/api/series/{b_id}/chapters")).await;
    assert_eq!(b_list["totalElements"], 2);

    // Series -> one-shot, with keepSettings: A's model is pinned (the one-shot sets none); the
    // one-shot takes A's languages and direction and the chapter's title.
    let (status, out) = post(
        move_uri(&a_chapters[0]),
        r#"{"oneshot":true,"keepSettings":true}"#.into(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let oneshot = &out["series"];
    assert_eq!(oneshot["kind"], "oneshot");
    assert_eq!(oneshot["title"], "First");
    assert_eq!(oneshot["originalLanguage"], "ko");
    assert_eq!(oneshot["readingDirection"], "ltr");
    assert_eq!(oneshot["oneshotChapterId"], a_chapters[0].as_str());
    assert_eq!(out["chapter"]["chapterNumber"], 1.0);
    assert_eq!(out["chapter"]["tlModel"], "old/tl", "keepSettings pins it");
    let oneshot_id = oneshot["id"].as_str().unwrap().to_string();
    let (_, a_list) = get(format!("/tlhub/api/series/{a_id}/chapters")).await;
    assert_eq!(a_list["totalElements"], 0);
    let (status, _) = get(format!("/tlhub/api/series/{a_id}")).await;
    assert_eq!(status, StatusCode::OK, "an emptied regular series stays");

    // A one-shot that has its chapter can't take another.
    let (status, _) = post(
        move_uri(b1["id"].as_str().unwrap()),
        format!(r#"{{"seriesId":"{oneshot_id}"}}"#),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // One-shot -> series: the emptied one-shot is deleted.
    let (status, back) = post(
        move_uri(&a_chapters[0]),
        format!(r#"{{"seriesId":"{a_id}","chapterNumber":1}}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!(back["removedSeriesId"], oneshot_id.as_str());
    let (status, _) = get(format!("/tlhub/api/series/{oneshot_id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        back["chapter"]["tlModel"], "old/tl",
        "a pinned value stays pinned"
    );

    move_cleanup(&pool).await;
}
