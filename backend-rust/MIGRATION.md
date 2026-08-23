# Migration checkpoints — Java/Spring Boot → Rust/axum

Living checklist for the rewrite on branch `rust-backend`. Tick items only when they are
implemented AND verified (build/clippy/test green, live behavior checked where applicable).
The frozen contract lives in `spec/golden-openapi.json` (71 operations, 26 schemas).

---

# SESSION HANDOFF — read this first after any context loss

> STATUS SNAPSHOT (2026-08-23): Phases 0–2 COMPLETE · 49/71 API operations served ·
> CI GREEN on GitHub Actions (ci-cargo.yml) · branch rust-backend pushed to BOTH remotes
> (`github` + `pi5`). Next work item: Phase 3 — see execution order below.

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
- GitHub Actions SERVICE CONTAINERS cannot take a command: minio/minio exits printing usage
  unless started as `server /data`. It runs via a docker-run step in ci-cargo.yml instead.
- CI's Postgres starts EMPTY: ci-cargo.yml applies database/init.sql (sed strips pg_dump
  \restrict lines and rewrites OWNER TO tladmin -> postgres). Tests must seed a bootstrap
  user when the users table is empty — Java makes the first-ever registrant ADMIN.
- Security-denial 403s are application/json (Boot error attributes); @PreAuthorize denials
  inside controllers are application/problem+json. Both verified live.
- series.reading_direction is NOT NULL but Java never defaults it: missing field = 500
  problem+json on BOTH stacks (Rust via CatchPanicLayer -> internal_error). Frontend
  always sends it; keep test payloads doing the same.
- Route-mount regression lesson: page/layer routers must be nest("/api", ...) — a full
  mod.rs rewrite silently regressed them to merge-at-root, which unit tests miss and CI's
  integration tests catch (404 from the SPA fallback). Always run `cargo test` (all
  targets) before pushing, not just --lib.
- Integration tests that touch MinIO MUST call storage.ensure_bucket() in their app()
  setup: fresh test containers (and CI's) start with zero buckets, and PutObject fails
  with NoSuchBucket -> bare 500. ensure_bucket is create-if-missing, so it is equally
  safe against an already-populated instance — never wipe container data to "fix" tests.
- Production manga-minio is unreachable from the host by design (compose maps only the
  9001 console to loopback; 9000 stays inside manga-net), so local test containers on
  port 19000 can never collide with it.

## Where things live (backend-rust/src)

| Path | Contents |
|---|---|
| `main.rs` / `lib.rs` | thin entrypoint; library root for integration tests |
| `config.rs` | env + Docker-secrets loading, fail-closed validation, JDBC URL translation |
| `db.rs`, `models.rs` | PgPool; 17 entity structs (serde camelCase for embedded responses) |
| `error.rs` | RFC-7807 problem+json builders + Boot no-timestamp variants |
| `auth.rs` | AuthUser/MaybeAuthUser extractors, security-403 shape, internal-token guard |
| `jwt.rs`, `password.rs` | jjwt-parity JWTs (length-based HMAC); bcrypt `$2a$10` |
| `minio.rs`, `redis_service.rs` | S3 ops (+presign); queues/pub-sub over ConnectionManager |
| `thumbnails.rs` | WebP width-512 q85 pipeline (vendored libwebp, no JNI) |
| `resolve.rs`, `settings.rs` | override chain (pure); system_settings pair + env defaults |
| `routes/mod.rs` | router assembly, CONTEXT_PATH nest, CatchPanic, SPA fallback |
| `routes/{auth,series,page,layers,layers_ops,jobs,settings}.rs` | Phase-2 controllers |
| `spec/golden-openapi.json` | THE frozen contract (71 ops); `golden-routes.txt` inventory |
| `tests/` | db_entities, auth_middleware, auth_endpoints, series_endpoints, pages_endpoints, minio_service, redis_service, java_compat |

## Phase 3 execution order (CURRENT PHASE)

The remaining 22 golden-spec operations are exactly the job-pipeline surface:

| Group | Routes | Java source to read first |
|---|---|---|
| Internal worker API | GET/HEAD `/api/internal/images/{id}`, POST `qa-hybrid-prepare`, PATCH `jobs/{id}/status`, GET `jobs/{jobId}`, 7 callbacks (`panel` `ocr` `layout` `translation` `qa` `qa-re-ocr` `render`) | `InternalJobController.java` (759 ln) |
| Redo triggers | POST `/api/images/{imageId}/redo`, POST `/api/ocr-regions/{id}/redo` | JobCoordinatorService L1576–1728 |
| Import | POST `/api/series/{id}/chapters/import`, POST `/api/chapters/{id}/import-project`, ZIP/ePub branches inside `POST /api/images` | SeriesController L576+, PageController L243–625 |
| Export | GET `/api/series/chapters/{id}/export`, DELETE `.../exports`, GET `exports/{exportId}/download` | `ChapterExportService.java` (444 ln) |
| Realtime | GET `/api/notifications/stream` (SSE), POST `/api/notifications/ticket` | `SseService.java` (392 ln), `SseTicketService`, SecurityConfig SSE notes |

Recommended build order (each step compiles+tests+commits before the next):

1. **SseService port** (`src/sse.rs`) — per-user emitter registry, single-use tickets
   (`POST /api/notifications/ticket` mints, stream validates), missed-event replay,
   heartbeat. axum SSE via `axum::response::sse`. Everything downstream emits through it,
   so land it first even though its two routes come last in the gate.
2. **JobCoordinator core** (`src/jobs/coordinator.rs`): startPipeline/enqueueDirectly,
   payload construction (READ `enqueueJobDirectly` carefully — it is the AUTHORITY for
   model resolution task keys: ocr/tl/qaLLM/qaVLM), push-to-queue (RedisService exists),
   trace-key TTL semantics, `claimCallback` idempotency guard (AUDIT-P4/P5).
   resolveModel/resolveWithCheck already live in `src/resolve.rs`.
3. **Startup recovery**: `resetProcessingJobsToPending`, `recoverStaleProcessingJobs`
   (10-min staleness sweep), `requeuePendingJobs` — as tokio interval tasks replacing
   Spring's @Scheduled pool (compose env SCHEDULING_POOL_SIZE is then obsolete).
4. **WorkerDispatcherService** port — dispatch loop popping queue:* to worker URLs with
   health gating + re-push-on-failure (WorkerDispatcherService.java, 425 ln).
5. **InternalJobController routes** + callback handlers one at a time (panel -> ocr ->
   layout -> translation -> qa -> qa-re-ocr -> render), each with a live-DB test driving
   the same JSON the real worker sends. Transaction parity rule: DB writes commit BEFORE
   Redis/SSE fan-out (Java used afterCommit hooks; sequence explicitly here).
6. **ProviderConfigCache** (config/providers.json + worker-published Redis blob) ->
   wire into resolve_model_with_check (currently permissive) + Settings activeProviders.
7. **Import/export quartet + ZIP upload branches + redo endpoints**, now that pipeline
   calls exist. DebouncedRenderService + ExportCleanupService + CostEstimationService
   alongside. Then flip diff_routes.py PORTED set to ALL and require exact equality.

Transaction-boundary rules for every handler above (from Java audit comments):
* Publish-to-Redis strictly AFTER the DB tx commits (afterCommit hook parity).
* Callback application is claimed ONCE per job row (`claimCallback`) — duplicate worker
  callbacks after recovery requeues MUST be dropped, not reapplied.
* Trace ids: PIPELINE_TRACE_TTL 12h Redis key refreshed on every enqueue.

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

- [x] Contract gate: scripts/diff_routes.py checks ported routes ⊆ golden-routes.txt in CI
      (69% at Phase 2 completion; the remaining 22 ops all need the job pipeline;
      full utoipa OpenAPI-doc generation deferred to cutover prep)
- [x] Error handling parity: problem+json family (validation w/ nanosecond timestamp +
      errors map, not-found, bad-request, access-denied, payload-too-large, internal) +
      Boot's no-timestamp unreadable-body shape + plain-text controller errors
- [x] `AuthController` — all 7 endpoints; live-DB lifecycle test asserting every wire shape
      (problem+json validation, text/plain errors, explicit-null token, controller-401 vs
      security-403, blank-name no-op, change-password, account deletion, admin-rejection)
- [ ] `SeriesController` — series CRUD + nested chapters CRUD + import + export download/cleanup
- [x] `PageController` (Phase-2 scope) — single-image multipart upload w/ magic-byte
      validation incl BMP->PNG convert + sha256 dedup (already_exists/duplicate), slot
      clamp + two-phase shift-up, cover refresh; list/get page+image assembly; streaming
      file/reader/thumbnail/rendered with immutable cache + suffixed ETags; delete/
      reorder/update-number/ocr PATCH. ZIP branches + duplicate-cloning + redo endpoints
      + import-project defer to Phase 3 (pipeline); thumbnails generate synchronously
- [x] `LayerController` — element update with change-detected edit history + metadata
      bump, history list, layer create (page/image paths) + partial update + delete,
      element create with Java defaults + delete; all ADMIN/TRANSLATOR gated
- [x] OCR-region PATCH (text/translatedText/approved/confidence, translated clears
      translation_failed). Redo triggers -> Phase 3
- [x] `SettingsController` — GET/PUT via system_settings + env defaults; provider lists/
      catalog empty until worker publishes (Java cache behaves identically pre-publish);
      validate -> {"orphaned":[]} while permissive
- [x] `JobController` — active-jobs + pause flag from Redis; queue pause/resume/clear
      (status sets + queue:* key sweep); retry/pause/resume/delete per-job incl.
      re-enqueue when gate open. SSE fan-out + requeuePendingJobs -> Phase 3
- [x] `ForwardController` — SPA fallback serves index.html for non-API unmatched paths
      (dist dir via SPA_DIST_DIR; binary embed lands in Phase 4 Dockerfile); unmatched
      /api/** return Boot-shaped 404 JSON
- [x] Pagination semantics identical (defaults 10/15/25, clamp at max-page-size 100,
      sort whitelists, asc/desc steering the SQL)

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
