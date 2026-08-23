# Migration checkpoints — Java/Spring Boot → Rust/axum

Living checklist for the rewrite on branch `rust-backend`. Tick items only when they are
implemented AND verified (build/clippy/test green, live behavior checked where applicable).
The frozen contract lives in `spec/golden-openapi.json` (71 operations, 26 schemas).

---

# SESSION HANDOFF — read this first after any context loss

## Mission

Replace the Java Spring Boot backend (`backend/`, ~14.3k LOC) with Rust/axum in THIS directory
(`backend-rust/`) on branch `rust-backend`. HTTP contract is FROZEN to the golden spec; worker,
frontend, DB schema, Grafana dashboards must keep working unchanged. Strategy: full rewrite on
a branch, hard cutover at Phase 4.

## Environment facts

- Worktree: `/home/sagnik/Projects/docker-composes/manga-library-rust` (branch `rust-backend`);
  canonical checkout `/home/sagnik/Projects/docker-composes/manga-library` stays on `main`.
- Remotes: `github` = github.com/sagniKdas53/manga-tl.git · `pi5` = ssh://git@pi5.tail9ece4.ts.net:2222/sagnik/manga-library.git
  → **push BOTH** after every commit (`git push github rust-backend && git push pi5 rust-backend`).
- Live stack runs via docker compose on the canonical dir: Postgres (**user is `tladmin`,
  NOT postgres** — see `.env`), Valkey :6379, MinIO (:9000 NOT published to host — tests use a
  throwaway `docker run -p 19000:9000 minio/minio server /data`), backend :8080 under `/tlhub`.
- Secrets: `/home/sagnik/Projects/docker-composes/manga-library/secrets/*.txt`
  (db_password.txt, jwt_secret.txt [64 bytes ⇒ HS512], internal_api_token.txt…).
- Rust stable ≥1.98 via rustup; run `source "$HOME/.cargo/env"` in fresh shells.

## Verify everything before ticking (full gate)

```bash
cd /home/sagnik/Projects/docker-composes/manga-library-rust/backend-rust
DBPW=$(cat ../secrets/db_password.txt)   # NOTE: ../secrets only exists from inside worktree/backend-rust
export SPRING_DATASOURCE_URL=jdbc:postgresql://127.0.0.1:5432/manga_library
export SPRING_DATASOURCE_USERNAME=tladmin SPRING_DATASOURCE_PASSWORD="$DBPW"
export REDIS_TEST_ADDR=127.0.0.1:6379
docker run --rm -d --name rust-minio-test -p 19000:9000 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
export MINIO_TEST_ENDPOINT=http://127.0.0.1:19000
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## Key decisions & documented deviations

1. sqlx raw SQL over SeaORM — schema is hand-managed init.sql; compile-time-checked queries fit.
2. JWT algorithm picked by SECRET LENGTH like jjwt (≥64B HS512 / ≥48B HS384 / else HS256);
   zero clock skew; production secret is 64 B ⇒ HS512 (verified against live tokens).
3. Auth errors: missing/invalid token on protected API = **403** Boot-shape JSON
   `{timestamp(+00:00 ms), status, error:"Forbidden", path:"/tlhub/…"}`; unauthenticated
   `/api/auth/me|refresh|change-password` = **401** `{"message":"Not authenticated"}` from the
   controller itself; bad login = 401 **text/plain** "Invalid credentials"; internal API =
   401 exact bytes `{"error": "Unauthorized: Invalid internal token"}`.
4. Validation/malformed-JSON errors are RFC-7807 `application/problem+json`:
   `{type:"about:blank", title, status, detail, instance:"/tlhub/path"[, timestamp][, errors]}` —
   validation adds nanosecond `timestamp` + `errors` map; malformed JSON has NO timestamp and
   detail "Failed to read request".
5. Redis connect is fail-fast at boot (Spring was lazily silent) — deliberate deviation.
6. WebP thumbnails: width 512, aspect height, RGB, lossy q85, upscale-small allowed.
7. Passwords: bcrypt cost 10 pinned `$2a$`; committed regression hash from live Java backend;
   `tests/java_compat.rs` proves bidirectional hash+JWT interop (env-gated).

## Gotchas that already bit once

- `cargo test` does NOT refresh `target/debug/manga-backend` — `cargo build` before smoke runs.
- Deployment DB user is `tladmin` (from repo `.env`), not compose's default `postgres`.
- `../secrets/db_password.txt` resolves relative to CWD; use absolute paths when unsure.
- axum `nest` strips the prefix: handlers see `/api/...`; re-add context_path for Boot-shaped
  error payloads.
- Futures do nothing unless `.await`ed (`delete_quietly` test bug).
- Uncommitted tx rows are invisible to pool connections (auth middleware test bug).
- aws-sdk SdkError is huge: module-level `allow(clippy::result_large_err)` in minio.rs.
- redis 0.27 ConnectionManager has NO pub/sub — subscribers open dedicated connections.

## Where things live

| Path | Contents |
|---|---|
| `src/config.rs` | env+secrets loading, fail-closed validation, JDBC URL translation |
| `src/db.rs`, `src/models.rs` | PgPool; 17 entity structs mapped from database/init.sql |
| `src/jwt.rs`, `src/password.rs` | jjwt-parity JWTs; bcrypt `$2a$10` |
| `src/auth.rs` | AuthUser extractor, 403 shape, internal-token guard |
| `src/minio.rs`, `src/redis_service.rs`, `src/thumbnails.rs` | storage/queues/pub-sub/WebP |
| `src/routes/mod.rs` | router assembly under CONTEXT_PATH |
| `spec/golden-openapi.json` | THE frozen contract (71 ops); `spec/golden-routes.txt` inventory |
| `tests/*.rs` | db_entities, auth_middleware, minio_service, redis_service, java_compat |

## Phase 2 execution order (current phase)

DONE: error.rs (problem+json) ✅ · routes/auth.rs all 7 endpoints ✅ · scripts/diff_routes.py
contract gate in CI ✅ (8/71 operations at last count).

NEXT — SeriesController (13 routes in golden spec). SCOPING ALREADY DONE, honor it:
* SystemSettingsService split (source read 2026-08-23): series CRUD needs ONLY
  getSettingValue(key,default)/saveSetting — trivial system_settings upsert pair; put them in
  src/settings.rs. The FULL getSettings() DTO + validateOverrides() depend on
  ProviderConfigCache (config/providers.json + worker-published Redis config) — defer both to
  the SettingsController slice, NOT needed for series/chapters.
* Series create semantics to mirror exactly: resolveSetting() on every field; targetLang
  fallback "en", original/source fallback "ja"; createdBy = principal user.
* SeriesDto JSON: {id,title,originalLanguage,sourceLanguage,targetLanguage,readingDirection,
  coverImageUrl,ocrProvider,ocrModel,tlProvider,tlModel,qaProvider,qaLlmModel,qaVlmModel,
  qaMode,routingStrategy,useFallbackModels,resolvedUseFallbackModels,createdAt,updatedAt}
  (camelCase, OffsetDateTime = RFC-3339 with offset — chrono serde gives +00:00 form).
* ChapterDto adds: chapterNumber(double),useContextMemory(bool),pageCount(int?),
  resolvedOcr{provider,model,source},resolvedTranslation{...},resolvedQa{provider,llmModel,
  vlmModel,mode,source}. Resolution source field values come from JobCoordinatorService —
  read its resolveConfigForChapter + ResolvedPipelineConfig before writing routes/series.rs.
* Port FIRST: SystemSettingsService (src/settings.rs — system_settings table + defaults +
  caching) because createSeries resolves every field via resolveSetting(), defaulting
  targetLang=en origLang=ja.
* ChapterDto carries resolvedOcr/resolvedTranslation/resolvedQa slots + resolvedUseFallbackModels
  — these come from JobCoordinatorService.resolveModelWithCheck/resolveConfigForChapter
  (override chain chapter→series→global-settings). That resolution logic must be ported as a
  pure module BEFORE chapter list/create endpoints can match the contract.
* coverImageUrl on both DTOs = MinIO presigned URL of cover image (10-min TTL, external-url
  rewrite already implemented in minio.rs).
* Pagination: Spring Pageable — ?page=&size= (defaults 10 series / 15 chapters), sortBy only
  createdAt|updatedAt (fallback updatedAt), sortDir asc/desc; max-page-size 100 cap.
  PagedResponse = {content[], page, size, totalElements, totalPages}.
* DEFER to Phase 3 (job-pipeline entangled): POST /chapters/import, GET /chapters/{id}/export,
  DELETE /exports, GET /exports/{id}/download, and handleDuplicateImageCloning.
Then: PageController (uploads/streaming/thumbnails) → Layer/OcrRegion → Settings → Job →
Forward. utoipa OpenAPI-doc generation deferred to cutover prep; route-table gate runs now.

---

# Checkpoints

Legend: `[x]` done+verified · `[~]` partially done · `[ ]` not started

---

## Phase 0 — Contract freeze + scaffolding ✅

- [x] Linked worktree + branch (`rust-backend`), Java `backend/` untouched
- [x] Golden OpenAPI spec exported live → `spec/golden-openapi.json`
- [x] Human-readable route inventory → `spec/golden-routes.txt`
- [x] Cargo project: axum router nested under `CONTEXT_PATH` (`/tlhub`), tower-http tracing
- [x] Config loader: env + Docker secrets (`*_FILE`), fail-closed, ALL problems reported at once
- [x] Port of `SecretsStartupValidator` (min lengths, known-insecure list, dev-profile bypass)
- [x] `jdbc:postgresql://` URL translation so compose needs no changes at cutover
- [x] `/actuator/health` (+liveness/readiness) byte-compatible `{"status":"UP"}`
- [x] Graceful SIGTERM/Ctrl-C shutdown (compose sends SIGTERM)
- [x] `.env.local.example` zero-export local dev flow
- [x] Beginner-oriented README (commands, Java↔Rust concept map, phase roadmap)

## Phase 1 — Foundation (no API surface yet) ✅ COMPLETE

- [x] `ci-cargo.yml`: fmt --check · clippy `-D warnings` · tests w/ Postgres service container
- [x] sqlx `PgPool`, eager startup connect (bad DB ⇒ boot fails, verified live)
- [x] All 17 JPA entities → serde + `FromRow` structs mapped 1:1 from `init.sql`
      (`jobs.id` varchar kept, `"type"` columns renamed via `#[sqlx]`/`#[serde]`)
- [x] Rolled-back round-trip integration tests vs live schema (uuid/timestamptz/jsonb/f64)
- [x] **JWT utils** — port `JwtUtils` w/ `jsonwebtoken` crate; jjwt key-length algorithm
      rule mirrored (production secret is 64 B ⇒ HS512), zero clock-skew expiry,
      null-on-failure `expiry_from_token` contract; 8 tests incl. AUDIT-B8 regression
      and cross-algorithm rejection
- [x] **Auth middleware skeleton** — `AuthUser` extractor (Bearer → JWT → DB user → role
      uppercased) reproducing Spring's surprising 403-shape for missing/invalid/unknown-user
      tokens; verified live against running backend + real-DB round-trip test
- [x] **Internal-token guard** — `X-Internal-Token` constant-time check, exact 401 body
      `{"error": "Unauthorized: Invalid internal token"}`, fail-closed on unconfigured token
- [x] **MinIO client** — `aws-sdk-s3` w/ path-style addressing against MinIO; port of
      `MinioService` (ensure-bucket @PostConstruct log-don't-crash semantics, upload/stat/
      stream/delete/list/presigned-GET with MINIO_EXTERNAL_URL rewrite); 2 live-server tests
      (throwaway docker or CI service container, skipped when endpoint unset)
- [x] **Redis client + pub/sub plumbing** — `RedisService` over auto-reconnecting
      ConnectionManager (queue RPUSH/LPOP/LLEN, string get/set/del, pause gate,
      PUBLISH/SUBSCRIBE); dedicated pub/sub connections; startup listener task on
      `provider:config:updated` with resubscribe loop; 4 live-server tests. DEVIATION
      (documented): Redis connect is fail-fast at boot where Spring was silently lazy
- [x] **WebP thumbnail pipeline** — `thumbnails.rs`: decode JPEG/PNG/WebP/BMP → width-512
      aspect-preserving resize (Triangle ≈ SCALE_SMOOTH) → RGB → lossy WebP @85 (Java parity:
      512px width, alpha drop, upscale-small behavior); vendored libwebp builds under cargo —
      JNI stage + WEBP_LOCK serialization gone; 5 unit tests
- [x] **Password hashing parity** — bcrypt cost 10, `$2a$` version pinned (Spring default);
      committed Java-produced regression hash + env-gated live tests: Rust verifies real
      Spring hashes AND real Java-minted HS512 JWTs (both proven against the running stack)

## Phase 2 — CRUD APIs (contract-frozen ports)

- [~] Contract gate: scripts/diff_routes.py checks ported routes ⊆ golden-routes.txt in CI
      (11% at auth completion; full utoipa OpenAPI-doc generation deferred to cutover prep)
- [x] Error handling parity: problem+json family (validation w/ nanosecond timestamp +
      errors map, not-found, bad-request, access-denied, payload-too-large, internal) +
      Boot's no-timestamp unreadable-body shape + plain-text controller errors
- [x] `AuthController` — all 7 endpoints; live-DB lifecycle test asserting every wire shape
      (problem+json validation, text/plain errors, explicit-null token, controller-401 vs
      security-403, blank-name no-op, change-password, account deletion, admin-rejection)
- [ ] `SeriesController` — series CRUD + nested chapters CRUD + import + export download/cleanup
- [ ] `PageController` — image upload (multipart ≤50MB), page/image reads, reorder,
      streaming file/reader/rendered responses, thumbnail generation on upload
- [ ] `LayerController` + layer-elements CRUD + edit history
- [ ] OCR-region PATCH + redo triggers
- [ ] `SettingsController` — get/put/validate system settings
- [ ] `JobController` — list/pause/resume/retry/clear
- [ ] `ForwardController` — worker proxy pass-through
- [ ] Pagination semantics identical (page/size caps: max-page-size 100)

## Phase 3 — Jobs & realtime (the hard core)

- [ ] `InternalJobController` — worker-facing callbacks (panel/ocr/layout/translation/qa/
      qa-re-ocr/render), internal image endpoints, job status PATCH
- [ ] `JobCoordinatorService` port (~2.3k lines): pipeline orchestration, model resolution
      (override chain chapter→series→global), callback state machine, cost recording
- [ ] Transaction-boundary parity: publish-to-Redis strictly after DB commit (Java `afterCommit`)
- [ ] `WorkerDispatcherService` — dispatch loop, stale-job recovery, startup reset of PROCESSING jobs
- [ ] Redis pub/sub subscriber → `ProviderConfigCache` invalidation
- [ ] `SseService` — per-user emitters, ticket auth (`POST /api/notifications/ticket`),
      missed-event replay, heartbeat
- [ ] `DebouncedRenderService`, `ExportCleanupService`, `ChapterExportService`,
      `CostEstimationService`, `SystemSettingsService` cache semantics

## Phase 4 — Parity & cutover

- [ ] Scenario-level coverage parity vs the 48 Java test files' behaviors
- [ ] Frontend E2E smoke against Rust backend; `npm run generate-api` produces no functional diff
- [ ] Real Python worker run: register → poll → callbacks end-to-end
- [ ] New Dockerfile: cargo-chef multi-stage, musl static binary, embedded frontend dist,
      NO JNI/libwebp-native stage; multi-arch via BUILDPLATFORM pattern
- [ ] docker-compose swap to Rust image; Traefik labels/secrets layout unchanged
- [ ] Grafana dashboards verified (reads Postgres directly — schema untouched by design)
- [ ] Baseline comparison: cold-start time, idle RSS, p95 latency vs Java (record numbers here)
- [ ] Update AGENTS.md / docs / release.yml; retire `ci-maven.yml`
- [ ] Delete `backend/` Java tree; merge `rust-backend` → main

---

## Verification commands (run before ticking anything)

```bash
cd backend-rust
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
APP_PROFILE=test SPRING_DATASOURCE_URL=jdbc:postgresql://127.0.0.1:5432/manga_library \
SPRING_DATASOURCE_USERNAME=<user> SPRING_DATASOURCE_PASSWORD=<pw> cargo test   # integration
```
