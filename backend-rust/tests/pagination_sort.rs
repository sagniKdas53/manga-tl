//! AUDIT-T4: pagination and sort, proved against a REAL Postgres.
//!
//! Successor to `AUDIT-T3`, which named `@WebMvcTest` classes the Rust rewrite deleted. The gap
//! it described came back with the new handlers: `list_pages`, `list_chapters` and `list_series`
//! all build their `ORDER BY` and `LIMIT/OFFSET` by string interpolation into a `format!`, and
//! `series_endpoints.rs` only ever covered the series one. The two list endpoints the reader
//! actually walks -- chapters and pages -- had nothing.
//!
//! String interpolation is *not* the defect here, and this file does not pretend otherwise: the
//! direction is a literal, the column comes off a whitelist, and the sizes are clamped `i64`s.
//! What was unproven is that the whole thing composes -- that a window is the window it claims to
//! be, that the clamp survives the round trip, and that the arithmetic around it holds at the
//! edges. Those are the assertions below.
//!
//! Seeds through SQL rather than the upload endpoint on purpose: uploads need MinIO, and nothing
//! here is about image storage.

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
/// Distinct from every other binary's namespace: these tests sweep by prefix, and a shared
/// prefix would let one binary delete another's fixtures mid-run under `cargo test`.
const NS: &str = "__pagesort-e2e";

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

fn minio_config() -> MinioConfig {
    MinioConfig {
        endpoint: "http://localhost:9000".into(),
        external_url: None,
        access_key: Some("minioadmin".into()),
        secret_key: Some("minioadmin".into()),
    }
}

async fn app() -> Option<(Router, sqlx::PgPool, JwtUtils)> {
    let database = db_config_from_env()?;
    let pool = db::connect(&database).await.ok()?;
    let config = manga_backend::config::Config {
        context_path: "/tlhub".into(),
        port: 0,
        development: true,
        database,
        jwt_secret: None,
        internal_api_token: None,
        jwt_expiration_ms: 3_600_000,
        minio: minio_config(),
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
        MinioService::new(&minio_config()),
        None,
    );
    Some((manga_backend::routes::build_router(state), pool, jwt))
}

async fn send(app: Router, uri: &str, token: &str) -> (StatusCode, String) {
    let request = Request::builder()
        .method("GET")
        .uri(uri)
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

fn envelope(body: &str) -> serde_json::Value {
    serde_json::from_str(body).unwrap_or_else(|e| panic!("not a paged envelope ({e}): {body}"))
}

/// The `content` array's `pageNumber`s, in the order the endpoint returned them.
fn page_numbers(body: &str) -> Vec<i64> {
    envelope(body)["content"]
        .as_array()
        .unwrap_or_else(|| panic!("no content array: {body}"))
        .iter()
        .map(|p| p["pageNumber"].as_i64().expect("pageNumber"))
        .collect()
}

/// The `content` array's `chapterNumber`s, in the order the endpoint returned them.
fn chapter_numbers(body: &str) -> Vec<f64> {
    envelope(body)["content"]
        .as_array()
        .unwrap_or_else(|| panic!("no content array: {body}"))
        .iter()
        .map(|c| c["chapterNumber"].as_f64().expect("chapterNumber"))
        .collect()
}

/// Everything this file creates is named `{NS} {label}` or `{NS}-{label}-…`, and cleanup is
/// scoped to one label rather than to `NS`. `cargo test` runs a binary's tests on parallel
/// threads against one shared database, so a sweep of the whole namespace would delete a sibling
/// test's fixtures out from under it — `series_endpoints.rs` carries a comment about being bitten
/// by exactly that across two binaries.
async fn cleanup(pool: &sqlx::PgPool, label: &str) {
    let series_like = format!("{NS} {label}");
    let asset_like = format!("{NS}-{label}-%");
    let user_like = format!("{NS}-{label}-%");
    // Order matters: pages reference images and chapters, chapters reference series.
    let _ = sqlx::query(
        "DELETE FROM pages WHERE chapter_id IN \
           (SELECT c.id FROM chapters c JOIN series s ON s.id = c.series_id WHERE s.title = $1)",
    )
    .bind(&series_like)
    .execute(pool)
    .await;
    let _ = sqlx::query("DELETE FROM images WHERE filename LIKE $1")
        .bind(&asset_like)
        .execute(pool)
        .await;
    let _ = sqlx::query(
        "DELETE FROM chapters WHERE series_id IN (SELECT id FROM series WHERE title = $1)",
    )
    .bind(&series_like)
    .execute(pool)
    .await;
    let _ = sqlx::query("DELETE FROM series WHERE title = $1")
        .bind(&series_like)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM users WHERE email LIKE $1")
        .bind(&user_like)
        .execute(pool)
        .await;
}

async fn probe_token(pool: &sqlx::PgPool, jwt: &JwtUtils, label: &str) -> String {
    let email = format!("{NS}-{label}-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'PageSort Probe', $1, 'x', 'viewer')",
    )
    .bind(&email)
    .execute(pool)
    .await
    .expect("probe user");
    jwt.generate_token(&email).expect("token")
}

/// One series, one chapter, `count` pages numbered 1..=count. Returns the chapter id.
///
/// Rows are inserted in a *shuffled* order so that "sorted by page number" cannot be satisfied by
/// accident: a handler that dropped its `ORDER BY` entirely would return insertion order, which
/// is what Postgres tends to hand back for a small unindexed scan, and would pass a test that
/// seeded 1,2,3,4,5 in that order.
async fn seed_chapter(pool: &sqlx::PgPool, label: &str, count: i32) -> Uuid {
    let series_id: Uuid = sqlx::query_scalar(
        "INSERT INTO series (id, created_at, updated_at, title, original_language, \
                             reading_direction) \
         VALUES (uuid_generate_v4(), now(), now(), $1, 'ja', 'rightToLeft') RETURNING id",
    )
    .bind(format!("{NS} {label}"))
    .fetch_one(pool)
    .await
    .expect("series");

    let chapter_id: Uuid = sqlx::query_scalar(
        "INSERT INTO chapters (id, created_at, updated_at, chapter_number, series_id, \
                               use_context_memory) \
         VALUES (uuid_generate_v4(), now(), now(), 1, $1, false) RETURNING id",
    )
    .bind(series_id)
    .fetch_one(pool)
    .await
    .expect("chapter");

    let mut order: Vec<i32> = (1..=count).collect();
    order.reverse();
    if order.len() > 2 {
        order.swap(0, 2);
    }
    for n in order {
        let image_id: Uuid = sqlx::query_scalar(
            "INSERT INTO images (id, created_at, filename, storage_path) \
             VALUES (uuid_generate_v4(), now(), $1, $2) RETURNING id",
        )
        .bind(format!("{NS}-{label}-p{n}.png"))
        .bind(format!("{NS}/{label}/p{n}.png"))
        .fetch_one(pool)
        .await
        .expect("image");
        sqlx::query(
            "INSERT INTO pages (id, page_number, chapter_id, image_id) \
             VALUES (uuid_generate_v4(), $1, $2, $3)",
        )
        .bind(n)
        .bind(chapter_id)
        .bind(image_id)
        .execute(pool)
        .await
        .expect("page");
    }
    chapter_id
}

/// One series with `count` chapters, numbered 1..=count, again inserted out of order.
async fn seed_series_of_chapters(pool: &sqlx::PgPool, label: &str, count: i32) -> Uuid {
    let series_id: Uuid = sqlx::query_scalar(
        "INSERT INTO series (id, created_at, updated_at, title, original_language, \
                             reading_direction) \
         VALUES (uuid_generate_v4(), now(), now(), $1, 'ja', 'rightToLeft') RETURNING id",
    )
    .bind(format!("{NS} {label}"))
    .fetch_one(pool)
    .await
    .expect("series");
    let mut order: Vec<i32> = (1..=count).collect();
    order.reverse();
    for n in order {
        sqlx::query(
            "INSERT INTO chapters (id, created_at, updated_at, chapter_number, series_id, \
                                   use_context_memory) \
             VALUES (uuid_generate_v4(), now(), now(), $1, $2, false)",
        )
        .bind(f64::from(n))
        .bind(series_id)
        .execute(pool)
        .await
        .expect("chapter");
    }
    series_id
}

macro_rules! fixture {
    () => {
        match app().await {
            Some(v) => v,
            None => {
                eprintln!("skipping: SPRING_DATASOURCE_URL not set");
                return;
            }
        }
    };
}

#[tokio::test]
async fn pages_come_back_in_page_order_and_sort_dir_reverses_them() {
    let (app, pool, jwt) = fixture!();
    cleanup(&pool, "order").await;
    let token = probe_token(&pool, &jwt, "order").await;
    let chapter = seed_chapter(&pool, "order", 5).await;

    let (status, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?size=100"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        page_numbers(&body),
        vec![1, 2, 3, 4, 5],
        "ascending is the default, and it is a real sort -- the rows were inserted shuffled"
    );

    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?size=100&sortDir=desc"),
        &token,
    )
    .await;
    assert_eq!(
        page_numbers(&body),
        vec![5, 4, 3, 2, 1],
        "sortDir=desc reverses it"
    );

    cleanup(&pool, "order").await;
}

#[tokio::test]
async fn a_page_window_is_the_window_it_claims_to_be() {
    let (app, pool, jwt) = fixture!();
    cleanup(&pool, "window").await;
    let token = probe_token(&pool, &jwt, "window").await;
    let chapter = seed_chapter(&pool, "window", 5).await;

    // The composition that AUDIT-T3 was originally filed about: LIMIT, OFFSET and ORDER BY have
    // to agree. Page 1 of size 2, sorted ascending, is pages 3 and 4 -- not "some two pages".
    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?page=1&size=2"),
        &token,
    )
    .await;
    assert_eq!(page_numbers(&body), vec![3, 4], "second window, ascending");
    let env = envelope(&body);
    assert_eq!(env["page"], 1);
    assert_eq!(env["size"], 2);
    assert_eq!(env["totalElements"], 5);
    assert_eq!(env["totalPages"], 3, "5 elements at 2 per page is 3 pages");

    // The same window sorted the other way is the *mirror*, not the same rows reordered.
    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?page=1&size=2&sortDir=desc"),
        &token,
    )
    .await;
    assert_eq!(
        page_numbers(&body),
        vec![3, 2],
        "OFFSET is applied to the sorted set, not before it"
    );

    // The tail is short, and asking past the tail is empty rather than an error.
    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?page=2&size=2"),
        &token,
    )
    .await;
    assert_eq!(
        page_numbers(&body),
        vec![5],
        "last window holds the remainder"
    );
    let (status, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?page=9&size=2"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        page_numbers(&body).is_empty(),
        "past the end is empty, not 500"
    );
    assert_eq!(
        envelope(&body)["totalElements"],
        5,
        "and the count still reports the whole set"
    );

    cleanup(&pool, "window").await;
}

#[tokio::test]
async fn an_oversized_size_is_clamped_and_says_so() {
    let (app, pool, jwt) = fixture!();
    cleanup(&pool, "clamp").await;
    let token = probe_token(&pool, &jwt, "clamp").await;
    let chapter = seed_chapter(&pool, "clamp", 3).await;

    // AUDIT-B11 parity: `?size=2000` was the unbounded-pagination bypass. The clamp is asserted
    // through the wire envelope, not the helper, because the envelope is what a client trusts --
    // reporting `size: 2000` while returning 100 rows would be its own bug.
    let (status, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?size=2000"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(envelope(&body)["size"], 100, "clamped to MAX_PAGE_SIZE");

    // And the floor: a nonsense size is not allowed to become LIMIT 0 or a negative LIMIT.
    for size in ["0", "-5"] {
        let (status, body) = send(
            app.clone(),
            &format!("/tlhub/api/chapters/{chapter}/pages?size={size}"),
            &token,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "size={size}: {body}");
        assert_eq!(envelope(&body)["size"], 1, "size={size} clamps up to 1");
        assert_eq!(page_numbers(&body).len(), 1, "size={size} returns one row");
    }

    // A negative page is not allowed to become a negative OFFSET.
    let (status, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?page=-3&size=2"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        page_numbers(&body),
        vec![1, 2],
        "negative page clamps to the first"
    );

    cleanup(&pool, "clamp").await;
}

#[tokio::test]
async fn a_page_index_that_would_overflow_the_offset_is_still_answered() {
    let (app, pool, jwt) = fixture!();
    cleanup(&pool, "overflow").await;
    let token = probe_token(&pool, &jwt, "overflow").await;
    let chapter = seed_chapter(&pool, "overflow", 3).await;

    // `OFFSET` is built as `page * size`. Both are i64 and only `page` is bounded below, so
    // `?page=9223372036854775807&size=100` overflows: a debug build panics into the catch-panic
    // layer and answers 500, and a release build wraps to a *negative* offset, which Postgres
    // rejects -- and the handler's `unwrap_or_default()` turns that rejection into an empty list
    // sitting next to an honest `totalElements`, which is worse than an error because it looks
    // like an answer.
    let (status, body) = send(
        app.clone(),
        &format!(
            "/tlhub/api/chapters/{chapter}/pages?page={}&size=100",
            i64::MAX
        ),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "must not 500: {body}");
    assert!(
        page_numbers(&body).is_empty(),
        "a page index past the end holds nothing"
    );
    assert_eq!(
        envelope(&body)["totalElements"],
        3,
        "and the total is still the truth"
    );

    cleanup(&pool, "overflow").await;
}

#[tokio::test]
async fn sort_dir_is_read_the_way_a_client_might_spell_it() {
    let (app, pool, jwt) = fixture!();
    cleanup(&pool, "casing").await;
    let token = probe_token(&pool, &jwt, "casing").await;
    let chapter = seed_chapter(&pool, "casing", 4).await;

    // Spring's `Sort.Direction.fromString` is case-insensitive, so `?sortDir=DESC` sorted
    // descending under the Java backend. The Rust port matched `Some("desc")` exactly, which
    // silently returned *ascending* for the same URL -- the worst shape of parity break, because
    // it answers 200 with plausible-looking data.
    for spelling in ["desc", "DESC", "Desc"] {
        let (status, body) = send(
            app.clone(),
            &format!("/tlhub/api/chapters/{chapter}/pages?size=100&sortDir={spelling}"),
            &token,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            page_numbers(&body),
            vec![4, 3, 2, 1],
            "sortDir={spelling} must sort descending"
        );
    }

    // Anything that is not a direction falls back to the endpoint's default rather than erroring.
    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?size=100&sortDir=sideways"),
        &token,
    )
    .await;
    assert_eq!(
        page_numbers(&body),
        vec![1, 2, 3, 4],
        "garbage falls back to asc"
    );

    cleanup(&pool, "casing").await;
}

#[tokio::test]
async fn chapters_sort_by_number_and_page_the_same_way() {
    let (app, pool, jwt) = fixture!();
    cleanup(&pool, "chapters").await;
    let token = probe_token(&pool, &jwt, "chapters").await;
    let series = seed_series_of_chapters(&pool, "chapters", 5).await;

    let (status, body) = send(
        app.clone(),
        &format!("/tlhub/api/series/{series}/chapters?size=100"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        chapter_numbers(&body),
        vec![1.0, 2.0, 3.0, 4.0, 5.0],
        "chapters default ascending, and the rows were inserted descending"
    );

    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/series/{series}/chapters?size=100&sortDir=desc"),
        &token,
    )
    .await;
    assert_eq!(chapter_numbers(&body), vec![5.0, 4.0, 3.0, 2.0, 1.0]);

    // Chapter windows compose the same way page windows do -- this is the endpoint the reader's
    // chapter list walks, and it had no coverage at all.
    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/series/{series}/chapters?page=1&size=2"),
        &token,
    )
    .await;
    assert_eq!(chapter_numbers(&body), vec![3.0, 4.0]);
    let env = envelope(&body);
    assert_eq!(env["totalElements"], 5);
    assert_eq!(env["totalPages"], 3);

    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/series/{series}/chapters?size=2000"),
        &token,
    )
    .await;
    assert_eq!(envelope(&body)["size"], 100, "the same clamp applies here");

    cleanup(&pool, "chapters").await;
}

#[tokio::test]
async fn total_pages_is_right_when_the_count_divides_exactly() {
    let (app, pool, jwt) = fixture!();
    cleanup(&pool, "exact").await;
    cleanup(&pool, "emptychapter").await;
    let token = probe_token(&pool, &jwt, "exact").await;
    let chapter = seed_chapter(&pool, "exact", 4).await;

    // `(total + size - 1) / size` is the off-by-one that ceiling division is *for*; the boundary
    // it gets wrong when written the other way is the exact multiple.
    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?page=0&size=2"),
        &token,
    )
    .await;
    assert_eq!(
        envelope(&body)["totalPages"],
        2,
        "4 at 2 per page is 2, not 3"
    );

    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter}/pages?page=0&size=4"),
        &token,
    )
    .await;
    assert_eq!(envelope(&body)["totalPages"], 1);

    // An empty chapter reports zero pages rather than one empty one.
    let empty = seed_chapter(&pool, "emptychapter", 0).await;
    let (_, body) = send(
        app.clone(),
        &format!("/tlhub/api/chapters/{empty}/pages?size=10"),
        &token,
    )
    .await;
    let env = envelope(&body);
    assert_eq!(env["totalElements"], 0);
    assert_eq!(env["totalPages"], 0);

    cleanup(&pool, "exact").await;
    cleanup(&pool, "emptychapter").await;
}
