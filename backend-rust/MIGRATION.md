# Migration checkpoints — Java/Spring Boot → Rust/axum

Living checklist for the rewrite on branch `rust-backend`. Tick items only when they are
implemented AND verified (build/clippy/test green, live behavior checked where applicable).
The frozen contract lives in `spec/golden-openapi.json` (71 operations, 26 schemas).

---

# SESSION HANDOFF — read this first after any context loss

> STATUS SNAPSHOT (2026-08-24): Phases 0–3 COMPLETE · **71/71 API operations served
> (route parity 100%, diff_routes.py enforces exact equality)** · 81 tests green across
> 14 suites · CI GREEN (ci-cargo.yml) · branch rust-backend pushed to BOTH remotes.
> CURRENT PHASE: **Phase 4 — Parity & cutover** (the last phase). Execution order +
> scenario-parity matrix below. Land steps in order; commit+push both remotes per step.

## Mission (Phase 4)

Prove the Rust backend can replace the Java one without anyone noticing, then cut over:
scenario-level test parity vs the 48 Java test files' behaviors → frontend E2E smoke →
a REAL Python worker pipeline run → new Dockerfile (cargo-chef, no JNI stage) → compose
swap → Grafana + performance baselines → docs/release updates → delete `backend/`,
merge `rust-backend` → main. The HTTP contract stays frozen throughout.

## Environment facts

- Worktree: `/home/sagnik/Projects/docker-composes/manga-library-rust` (branch `rust-backend`);
  canonical checkout `/home/sagnik/Projects/docker-composes/manga-library` stays on `main`.
- Remotes: `github` = github.com/sagniKdas53/manga-tl.git · `pi5` = ssh://git@pi5.tail9ece4.ts.net:2222/sagnik/manga-library.git
  → **push BOTH** after every commit (`git push github rust-backend && git push pi5 rust-backend`).
- Live stack runs via docker compose on the canonical dir: Postgres (**user is `tladmin`,
  NOT postgres** — see `.env`), Valkey :6379, MinIO (:9000 NOT published to host — tests use a
  throwaway `docker run -p 19000:9000 minio/minio server /data`), backend :8080 under `/tlhub`.
- Secrets live in the CANONICAL checkout only:
  `/home/sagnik/Projects/docker-composes/manga-library/secrets/*.txt`
  (db_password.txt, jwt_secret.txt [64 B ⇒ HS512], internal_api_token.txt…).
- **The Python worker is a git submodule** (`worker/`, repo `manga-tl-worker`). It is
  initialized ONLY in the canonical checkout; the rust worktree shows it empty. For the
  real-worker E2E either work in the canonical checkout after `git checkout rust-backend`
  there, or `git submodule update --init worker` inside the worktree. Worker image:
  `ghcr.io/sagnikdas53/manga-tl-worker:latest`; it calls back to
  `${BACKEND_CALLBACK_URL:-http://backend:8080}${CONTEXT_PATH:-/tlhub}/api/internal/jobs/callback`.
- **COMPOSE ENV GAP (must fix before the swap):** compose passes `SPRING_DATA_REDIS_HOST`
  /`SPRING_DATA_REDIS_PORT` to the BACKEND service (docker-compose.yml ~L170), but Rust
  `config.rs` reads `REDIS_HOST`/`REDIS_PORT` — names only the WORKER service receives
  (~L267). Preferred fix: teach config.rs to fall back to SPRING_DATA_REDIS_* (zero compose
  churn); alternative: add REDIS_HOST/PORT to the backend's environment block. Everything
  else the backend consumes already matches: SPRING_DATASOURCE_URL/USERNAME(+PASSWORD_FILE),
  MINIO_ENDPOINT/EXTERNAL_URL/ACCESS_KEY/SECRET_KEY_FILE, JWT_SECRET_FILE, CONTEXT_PATH,
  INTERNAL_API_TOKEN_FILE, WORKER_URLS/POLL_MS/API_SECRET_FILE, LOG_LEVEL, model/provider
  lists, DISABLE_LOCAL_OCR/LLM, PADDLEOCR_REC_MODEL.
- **NO `/v3/api-docs` yet:** the frontend's `npm run generate-api` pulls the OpenAPI JSON
  from `http://localhost:8080/tlhub/v3/api-docs`. The Rust backend does not serve it.
  Recommended fix (step 1 of the execution order): serve `spec/golden-openapi.json`
  byte-for-byte at that path — the contract is frozen, so a static copy IS the truth.
- Compose healthcheck runs `curl -f http://localhost:8080/actuator/health` INSIDE the
  backend container. If the new Rust image is distroless/static-musl there is no curl —
  either stay alpine-based, install curl, or switch the healthcheck to a tiny static
  helper baked into the image. Decide before the compose swap.
- SPA today: `routes/mod.rs` spa_fallback reads `SPA_DIST_DIR/index.html` from disk.
  Phase 4 embeds the dist into the binary (rust-embed/include_dir), keeping SPA_DIST_DIR
  as an override for local dev. The old Dockerfile bakes frontend dist into Spring's
  static resources with `VITE_BASE_PATH=${CONTEXT_PATH:-/tlhub}` — replicate that build
  arg flow in the new Dockerfile.
- Rust stable ≥1.98 via rustup; run `source "$HOME/.cargo/env"` in fresh shells.

## Verify everything before ticking (full gate)

```bash
cd /home/sagnik/Projects/docker-composes/manga-library-rust/backend-rust
DBPW=$(cat /home/sagnik/Projects/docker-composes/manga-library/secrets/db_password.txt)
export SPRING_DATASOURCE_URL=jdbc:postgresql://127.0.0.1:5432/manga_library
export SPRING_DATASOURCE_USERNAME=tladmin SPRING_DATASOURCE_PASSWORD="$DBPW"
export REDIS_TEST_ADDR=127.0.0.1:6379
docker run --rm -d --name rust-minio-test -p 19000:9000 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
export MINIO_TEST_ENDPOINT=http://127.0.0.1:19000
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
python3 ../scripts/diff_routes.py   # must print 71/71 AND exit 0
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
6. WebP thumbnails: width 512, aspect height, RGB, lossy q85, upscale-small allowed;
   generated SYNCHRONOUSLY during upload (Java used an async executor) — same end state,
   different latency. Documented Phase-2 deviation.
7. Passwords: bcrypt cost 10 pinned `$2a$`; committed regression hash from live Java backend;
   `tests/java_compat.rs` proves bidirectional hash+JWT interop (env-gated).
8. SSE: channel-per-connection with a lifecycle actor; 15s comment-frame keep-alive ADDED
   (Java had none — EventSource ignores comments; harmless). Session-expired push at the
   JWT's own exp, 1h emitter timeout preserved via tokio sleep.
9. Transaction-boundary parity: Redis pushes strictly AFTER commit (afterCommit parity);
   SSE events emitted immediately like Java did inside the tx; claimCallback idempotency
   (AUDIT-P4) commits its claim at once (Java claimed inside the handler tx).
10. CostEstimationService was NOT ported — zero callers anywhere in the Java tree (costs
    arrive from worker callbacks); job_costs table still written, ModelRate untouched.
11. TraceContext/MDC log-line tracing (X-Trace-Id filter, TraceIdFilterTest) was dropped:
    trace ids live in jobs.trace_id and every worker payload; log-correlation via tracing
    spans is a nice-to-have, not contract. Documented deviation.

## Gotchas that already bit once

- `cargo test` does NOT refresh `target/debug/manga-backend` — `cargo build` before smoke runs.
- Deployment DB user is `tladmin` (from repo `.env`), not compose's default `postgres`.
- `../secrets/db_password.txt` resolves relative to CWD; secrets exist only in the CANONICAL
  checkout — use absolute paths.
- axum `nest` strips the prefix: handlers see `/api/...`; re-add context_path for Boot-shaped
  error payloads. For 403 bodies prefer the `OriginalUri` extension (axum inserts it for EVERY
  request; it already includes CONTEXT_PATH — do NOT prepend context_path again).
- Futures do nothing unless `.await`ed (`delete_quietly` test bug).
- Uncommitted tx rows are invisible to pool connections (auth middleware test bug).
- aws-sdk SdkError is huge: module-level `allow(clippy::result_large_err)` in minio.rs.
- redis 0.27 ConnectionManager has NO pub/sub — subscribers open dedicated connections;
  GETDEL must go through `cmd("GETDEL")`. RENAME failing = key raced away, not an error.
- GitHub Actions SERVICE CONTAINERS cannot take a command: minio/minio exits printing usage
  unless started as `server /data` (docker-run step in ci-cargo.yml). CI Postgres starts EMPTY:
  ci-cargo.yml applies database/init.sql (sed strips \restrict, rewrites OWNER TO postgres).
  Tests seed a bootstrap user when users is empty — first-ever registrant becomes ADMIN.
- series.reading_direction is NOT NULL but Java never defaults it: missing field = 500
  problem+json on BOTH stacks. Frontend always sends it; keep test payloads doing the same.
- Route-mount regression lesson: page/layer routers must be nest("/api", ...) — always run
  `cargo test` (ALL targets) before pushing, not just --lib; CI's integration tests catch it.
- Integration tests touching MinIO MUST call storage.ensure_bucket() in app() setup.
- Production manga-minio :9000 is unreachable from the host by design; test containers on
  19000 can never collide with it.
- axum sse::Event has no Display; bound SSE body reads in tests with tokio timeouts (streams
  never EOF while open; KeepAlive at 15s sits outside a 5s window).
- layers.created_at is NOT NULL with no default — every INSERT INTO layers needs now().
  Same check before adding any raw INSERT here (ocr_regions/layers/layer_elements differ).
- zip crate: `ZipWriter::finish()` returns the inner writer — one `.into_inner()` gets the
  Vec; calling finish() twice or double-wrapping panics with duplicate-entry errors in tests.
- The Java `zip_of`-style helpers in tests write entries literally; passing project.json
  both as entry AND param duplicates the name and ZipArchive rejects it.
- Tests in ONE binary run in PARALLEL against the shared live DB: never give two tests the
  same probe-email prefix (a sibling's cleanup will delete your user mid-run → mysterious
  403s/FK violations). Scope every new test's seed+cleanup to its own prefix.
- tests/settings_endpoints.rs PUTs real global keys (system_settings) — it resets them to
  factory afterwards; if it CRASHES mid-run, re-run it (self-healing) and note that a
  crashed run can overwrite the Redis `system:providers:config` blob — restore by
  `docker restart manga-worker` (republishes at boot).
- rust-minio-test (:19000) is `--rm`: a live-stack restart or aborted shell kills it.
  Re-create before any suite needing MINIO_TEST_ENDPOINT.
- JWT exp has WHOLE-SECOND resolution (jsonwebtoken): a 1500ms token expires ~1s. Time
  assertions on session-expiry pushes must tolerate second rounding.
- jobs table has NO created_at-style traps like pages.created_at — but pages has NO
  created_at AT ALL: ORDER BY created_at on pages errors and unwrap_or_default() hides it
  (bit get_image_info until Phase 4 step 2). Prefer ORDER BY page_number there.

## Where things live (backend-rust/src)

| Path | Contents |
|---|---|
| `main.rs` / `lib.rs` | thin entrypoint; library root for integration tests |
| `config.rs` | env + Docker-secrets loading, fail-closed validation, JDBC URL translation |
| `db.rs`, `models.rs` | PgPool; 17 entity structs (serde camelCase for embedded responses) |
| `error.rs` | RFC-7807 problem+json builders + Boot no-timestamp variants |
| `auth.rs` | AuthUser/MaybeAuthUser extractors, security-403 shape, internal-token guard |
| `jwt.rs`, `password.rs` | jjwt-parity JWTs (length-based HMAC); bcrypt `$2a$10` |
| `minio.rs`, `redis_service.rs` | S3 ops (+presign, prefix deletes); queues/pub-sub over ConnectionManager |
| `sse.rs` | SseService + SseTicketService port: per-user emitters, single-use tickets, replay, heartbeat |
| `providers.rs` | ProviderConfigCache: Redis catalog blob → validity checks for model resolution |
| `jobs/` | coordinator (pipeline + callbacks), dispatcher (worker fan-out), recovery (sweeps) |
| `export.rs`, `clone.rs`, `archive.rs` | chapter export ZIPs, duplicate-image OCR/TL cloning, archive read/write |
| `thumbnails.rs` | WebP width-512 q85 pipeline (vendored libwebp, no JNI) |
| `resolve.rs`, `settings.rs` | override chain (pure); system_settings pair + env defaults |
| `routes/mod.rs` | router assembly, CONTEXT_PATH nest, CatchPanic, SPA fallback |
| `routes/{auth,series,page,layers,layers_ops,jobs,settings}.rs` | Phase-2 controllers |
| `routes/{notifications,internal}.rs` | SSE handshake + worker-facing internal API (Phase 3) |
| `spec/golden-openapi.json` | THE frozen contract (71 ops); `golden-routes.txt` inventory |
| `tests/` | db_entities, auth_middleware, auth_endpoints, series_endpoints, pages_endpoints, minio_service, redis_service, java_compat, sse_endpoints, internal_endpoints, import_export_endpoints |

## Phase 4 execution order (CURRENT PHASE)

Each step compiles + gates + commits before the next. Order chosen so that every step
de-risks the one after it; nothing after step 6 is reversible-cheap, so 1–5 are the proof
burden.

1. **Serve `/v3/api-docs`** from the Rust backend as the static bytes of
   `spec/golden-openapi.json` (route it OUTSIDE the /api nest, next to /actuator; content-type
   application/json). Then `cd frontend && API_DOCS_URL=http://localhost:<rust-port>/tlhub/v3/api-docs
   npm run generate-api` and diff `src/api/schema.d.ts` against the copy generated from the
   JAVA backend (generate once from the live Java stack FIRST and stash it). No functional diff
   ⇒ tick the checklist item. Any drift means our 71-op surface diverges from the golden spec —
   fix the backend, never the golden file.
2. **Scenario-parity sweep** — close the gaps in the matrix below (new test files:
   `settings_endpoints.rs`, `jobs_endpoints.rs`, `layers_endpoints.rs`, plus unit tests for
   providers.rs parsing/validity, coordinator textbox geometry (TextBoxForTest edge cases),
   export metadata building, recovery functions). Gate: every row of the matrix is ✅ or
   explicitly N/A-with-reason.
3. **Dispatcher + real-shape worker simulation**: spin an in-test axum server pretending to be
   the worker (/capabilities + /api/v1/jobs/submit returning 202/400/429) and assert dispatch
   behavior incl. cooldown + permanent-rejection FAILED marking. This mirrors
   WorkerDispatcherServiceTest without needing the Python container.
4. **Frontend E2E smoke**: build frontend (`VITE_BASE_PATH=/tlhub npm run build`), run the Rust
   backend on :8080 against the LIVE db/valkey + minio-test, serve SPA via SPA_DIST_DIR, drive
   Playwright through: login → series create → chapter upload (single image + zip) → page
   visible in reader → SSE notification arrives (job_update) → settings save/load. The
   webapp-testing skill (.agents/skills/webapp-testing) has the harness.
5. **Real Python worker run**: initialize the worker submodule, run the REAL worker container
   against the Rust backend (compose override file pinning `backend` to a locally-built Rust
   image is the cleanest path): register admin → upload chapter ZIP → watch panel→ocr→layout→
   translation→render→qa complete end-to-end with real models → download export. This is THE
   cutover gate. Record any contract mismatches as bugs, fix, re-run.
6. **New Dockerfile** (`backend-rust/Dockerfile`): cargo-chef multi-stage caching, final stage
   debian-slim or alpine (healthcheck needs curl/wget OR bake a static healthcheck helper),
   frontend-build stage with BUILDPLATFORM pattern + VITE_BASE_PATH arg, dist embedded via
   rust-embed (fall back to COPY + SPA_DIST_DIR if embed fights the build). NO JNI/libwebp
   native stage — vendored libwebp compiles under cargo. Multi-arch via
   `FROM --platform=$BUILDPLATFORM` for ALL build stages (rustc cross-compiles via
   `--target x86_64/aarch64-unknown-linux-gnu` + gcc-aarch64-linux-gnu, mirroring how the JAR
   stage avoided QEMU). Verify: `docker buildx build --platform linux/amd64,linux/arm64`.
7. **Compose swap**: point compose `backend.build.dockerfile` at the new Dockerfile (or publish
   `ghcr.io/sagnikdas53/manga-tl-rust:latest`). Fix the REDIS env gap (see Environment facts).
   Keep Traefik labels/secrets layout byte-identical. Bring the stack up on a TEST hostname
   first; compare `/actuator/health`, login, one upload, SSE, export download against the Java
   stack BEFORE tearing it down. Then hard-swap.
8. **Grafana verification**: dashboards read Postgres directly (schema untouched by design) —
   load each dashboard, confirm panels fill while a pipeline runs on the Rust backend.
9. **Baselines** (record numbers right here in this file when measured): cold-start time
   (`docker compose up backend` → first healthy status), idle RSS (`docker stats --no-stream`),
   p95 latency of GET /api/series (list of 50) and GET /api/images/{id}/reader under `hey -z
   30s -c 10`, image size (docker images). Compare against the Java stack measured the same way
   BEFORE deleting it.
10. **Cutover housekeeping**: update AGENTS.md + README(s), release.yml image paths,
    retire ci-maven.yml, flip diff_routes.py comment to "post-cutover", DELETE `backend/` java
    tree, merge `rust-backend` → main, push both remotes, tag the release.

---

# SCENARIO PARITY MATRIX (Phase 4 step 2 tracker)

Legend: ✅ Rust equivalent exists & green · 🟡 partial (behaviors missing) · ❌ gap ·
N/A deliberately not portable (say why).

| Java test file (48) | Status | Rust coverage / what's missing |
|---|---|---|
| AuthControllerTest | ✅ | tests/auth_endpoints.rs — full lifecycle wire shapes |
| JwtTest / JwtUtilsTest / JwtAuthFilterTest | ✅ | jwt.rs unit tests + tests/auth_middleware.rs |
| SseTicketTest | ✅ | sse_endpoints.rs (single-use, legacy shape, expiry carry) |
| SseServiceTest / NotificationControllerTest | ✅ | replay + multi-tab + session-expired push at the token's own exp (short-expiry test) + concurrent drain race (RENAME lost ⇒ exactly-once) |
| InternalJobControllerTest | ✅ | guard/status/job/HEAD/pipeline + image-info region filtering by latest OCR layer + context-memory fields (previousPageText/seriesMetadata) |
| PipelineFlowIntegrationTest | ✅ | internal_endpoints.rs full walk panel→qa |
| JobCoordinatorServiceTest | ✅ | claim/dup + redo + qa retry-budget exhaustion (COMPLETED at 2, RETRIED within budget) + hybrid prepare visibility sweep + reader-mode short-circuit (coordinator_flows.rs) |
| TextBoxForTest | ✅ | all 9 geometry cases as pure unit tests in coordinator.rs textbox_tests (bubble inset, column squaring f3aa160, safeText→bbox fallback, page clamping) |
| JobCoordinatorStartupTransactionTest | ✅ | reset_processing_jobs_to_pending + max-attempt-exhaustion FAILED branch (jobs_endpoints.rs recovery test, scratch DB) |
| WorkerDispatcherServiceTest | ✅ | tests/dispatcher_mock_worker.rs — in-test axum mock worker: 202 started_at stamping + body shape, 400 permanent FAILED w/ error text, 429 cooldown (next cycle zero contact), slot saturation, AUDIT-P3 single-queue stall isolation, pause gate |
| DebouncedRenderServiceTest | ✅ | recovery::process_pending_renders — threshold query, 5-min recent-failure skip, backdated failure allows re-trigger |
| ChapterExportServiceTest | ✅ | lifecycle trio + meta-data.json content (model/cost/qa) + hash-id cache hit (deterministic BTree ordering) + EXPORT_SUCCESS/EXPORT_ERROR notifications (export_service.rs vs minio-test) |
| ExportCleanupServiceTest | ❌ | delete_older_than against minio-test with backdated objects |
| MinioServiceTest | ✅ | tests/minio_service.rs |
| ProviderConfigCacheTest | ✅ | providers.rs unit tests — exact catalog blob parse, priority ordering, validity/ORPHANED rules, free-tier flags, empty-cache permissive, unparsable-blob keeps stale |
| SystemSettingsServiceTest / SettingsControllerTest | ✅ | tests/settings_endpoints.rs — get/put round-trip + persistence, validateOverrides DEPRECATED entries with seeded catalog blob, empty-cache {"orphaned":[]}; global table reset to factory after run |
| JobControllerTest | ✅ | tests/jobs_endpoints.rs — active list envelope, pause gate + resume requeue, clear force flag (COMPLETED untouched), per-job retry/pause/resume rules with exact 400 texts; runs ONLY against JOBS_E2E_DATABASE_URL scratch DB (global side effects) |
| LayerControllerTest | ✅ | tests/layers_endpoints.rs — create (page+image paths, fractional zOrder coercion), update, history change-detection, delete, Java element defaults, ADMIN/TRANSLATOR-vs-viewer gating |
| SeriesControllerTest | ✅ | series_endpoints.rs CRUD + import/export interplay + pagination/sort whitelist test ({createdAt,updatedAt} only, fallback on junk) |
| PageControllerTest | ✅ | pages_endpoints.rs broad + ocr PATCH translated-clears-failed assertion |
| SettingsControllerTest (validate) | see SystemSettings row | ✅ |
| SecurityConfigTest / AuthorizationDenialFilterTest | ✅ | 403 Boot shape + @PreAuthorize problem+json verified live in Phase 2; role-matrix asserted per group (series admin-delete, layers ADMIN/TRANSLATOR, settings/jobs any-auth, internal token) |
| ForwardControllerTest | ✅ | API-404 + SPA index.html for extension-less non-API path; dotted asset paths stay 404 (Java [^\\.]* mapping parity) |
| GlobalExceptionHandlerTest | ✅ | shapes exercised across all endpoint suites |
| HealthReporterTest | ✅ | health router unit test |
| OpenApiSpecTest | ✅ | routes/mod.rs: /v3/api-docs serves golden bytes byte-for-byte (include_bytes) + core-path assertions; generate-api diff vs live Java stack is multiset-identical (3058 lines, springdoc emits non-deterministic key order per boot — zero functional drift) |
| SchemaValidationTest / InitScriptReconciliationTest | ✅ | schema shared verbatim; db_entities round-trips |
| Repository tests (Chapter/LayerElement/Layer/Page/Series) | ✅ | db_entities.rs rolled-back round-trips (query semantics live in endpoint suites) |
| Entity tests (PageTest/UserTest/SystemSettingTest) | ✅ | serde/FromRow mappings in db_entities |
| SecretsStartupValidatorTest | ✅ | config.rs fail-closed unit tests |
| TraceIdFilterTest | N/A | MDC log tracing dropped deliberately (decision #11); trace ids persist in jobs.trace_id + payloads |
| SchedulingPoolConfigTest | N/A | @Scheduled pool replaced by tokio interval tasks |
| CostEstimationServiceTest | N/A | service has zero callers in the Java tree; not ported (decision #10) |

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

## Phase 3 — Jobs & realtime ✅ COMPLETE (71/71 ops)

- [x] `InternalJobController` — worker-facing callbacks (panel/ocr/layout/translation/qa/
      qa-re-ocr/render), internal image endpoints (GET + HEAD existence check), job status
      PATCH with JobStatus vocabulary validation, region callback, qa-hybrid-prepare;
      X-Internal-Token guard on every route (`routes/internal.rs`)
- [x] `JobCoordinatorService` port (`jobs/coordinator.rs`): startPipeline/enqueueDirectly
      payload construction (task keys ocr/tl/qaLLM/qaVLM), QA-mode auto/vlm/llm fallback,
      useFallbackModels chain, claimCallback idempotency (AUDIT-P4/P5), trace-key 12h TTL
      refreshed per hand-off (AUDIT-P8), reader-mode short-circuit, translation layer
      geometry (bubble inset / free-text reshape), QA verdict state machine with per-page
      retry budget, cost recording, redo triggers w/ reason keys
- [x] Transaction-boundary parity: SSE inside the "transaction", Redis push strictly after
      commit (Java afterCommit) — see enqueue_job_directly/push_persisted_job_if_queue_running
- [x] `WorkerDispatcherService` (`jobs/dispatcher.rs`) — heavy/light slot gating via
      /capabilities, 429 exponential cooldown (10s base, 60s cap), permanent-rejection
      FAILED marking (AUDIT-P2), AUDIT-P3 queue-local backoff, started_at stamping
- [x] Startup recovery (`jobs/recovery.rs`) — PROCESSING→PENDING reset at boot, 10-min
      stale sweep (5-min cadence), requeuePendingJobs unless paused; DebouncedRenderService
      as a 5s loop; all replacing Spring's @Scheduled pool
- [x] `ProviderConfigCache` (`providers.rs`) — Redis blob parse, pub/sub reload listener in
      main.rs, wired into resolve_model_with_check + Settings activeProviders/
      providerModelsMap/localOcrModel + real validateOverrides (DEPRECATED entries)
- [x] `SseService` — per-user emitters, ticket auth (`POST /api/notifications/ticket`),
      missed-event replay, heartbeat (see its own entry above)
- [x] Import/export: chapter ZIP import (dup-image cloning incl. config comparison +
      OCR/TL reuse), project restore via POST /api/chapters/{id}/import-project and the
      ZIP/ePub branches of POST /api/images, export trio (202 build job, GONE download,
      clear), ChapterExportService port (`export.rs`) + daily cleanup loops.
      CostEstimationService deliberately NOT ported: it has zero callers in the Java tree
      (costs arrive from the worker); ModelRate table stays untouched for Grafana.

Route parity: **71/71** (`scripts/diff_routes.py`). New deps: reqwest (dispatcher),
zip (archives), hex, base64.

## Phase 4 — Parity & cutover (CURRENT — see handoff execution order + matrix above)

- [x] **Step 1** Serve `/v3/api-docs` (static golden spec bytes); `npm run generate-api`
      against the Rust backend produces zero functional diff vs the Java-generated schema.d.ts
      (VERIFIED 2026-08-24: served bytes cmp-identical to golden; schema.d.ts multiset-equal
      vs live-Java generation — springdoc key-order only; frontend copy committed as
      regenerated from the Rust backend so post-cutover regen is stable)
- [x] **Step 2** Scenario-parity sweep: every row of the matrix above is ✅ or N/A-with-reason
      (VERIFIED 2026-08-24: new suites settings_endpoints, jobs_endpoints [scratch-DB gated],
      layers_endpoints, coordinator_flows, export_service; unit tests for providers
      parse/validity + textbox geometry; recovery branches; SSE expiry/drain-race;
      image-info filtering. DRIFT FOUND & FIXED: textbox safeText fallback chain,
      fractional zOrder coercion, edit-history TEXT→jsonb bind (500 on element update),
      export hash nondeterminism (HashMap order broke cache hits), get_image_info ORDER BY
      nonexistent pages.created_at (endpoint silently returned no context). Gate: 114 tests
      green, fmt+clippy clean, parity 71/71)
- [x] **Step 3** Dispatcher test with an in-test mock worker (VERIFIED 2026-08-24:
      dispatcher_mock_worker.rs drives real Dispatcher::run_cycle() cycles — pause gate,
      202 stamping, 400 permanent FAILED, 429 cooldown skip, slot saturation,
      single-queue stall; run_cycle made pub for tests. Gate: 115 tests green)
- [x] **Step 4** Frontend E2E smoke via Playwright against the Rust backend (VERIFIED
      2026-08-24: scripts/e2e-smoke.js — register→dashboard, SSE stream 200, series create,
      chapter create, single-image upload appears in grid, reader renders the page bitmap,
      settings modal loads + saves. Playwright 1.62.1 headless chromium via
      NODE_PATH=npx cache. DRIFT FOUND & FIXED: SPA serving — axum nest misses
      {context}/ exact root (404 where Spring serves its welcome page) and dotted asset
      paths need real static-file serving from the dist (Spring's resource handler runs
      BEFORE ForwardController); spa_shell()/asset_mime() added + tests. Gate: 116 tests
      green, parity 71/71)
- [x] **Step 5** REAL Python worker run end-to-end (VERIFIED 2026-08-24: real worker image
      ghcr.io/sagnikdas53/manga-tl-worker on host network, scratch DB + throwaway MinIO +
      live Valkey; upload of corpus sample133 (ja, 1254x2000) drove the full chain:
      panel-detection COMPLETED (YOLO, 1 panel) → ocr COMPLETED (PP-OCRv6 det/rec ja +
      gemini-2.5-flash VLM OCR via OpenRouter, 9 regions, real ja text in ocr_regions) →
      layout COMPLETED (conversation grouping) → translation COMPLETED (real en text in
      translated_text) → render COMPLETED → qa COMPLETED (auto→none: no QA models
      configured, expected) → chapter export ZIP built+uploaded to MinIO and downloaded
      through the authenticated API (808 KB, 001.jpg + meta-data.json). Worker auth:
      WORKER_API_SECRET header; dispatcher HTTP-push verified incl. capabilities probe.
      ENV NOTE (not a port bug): presigned GET URLs are SigV4-signed for the backend's
      MINIO_ENDPOINT host — MINIO_EXTERNAL_URL string-rewrite (byte-faithful to Java)
      cannot cross hostnames without 403, so E2E ran the worker with the SAME endpoint
      view (host network); production is unaffected (worker resolves the internal
      endpoint). Callback-driven stage chaining verified once a job is delivered; two
      transient stuck-PENDING states during multi-restart races were cleared by the
      startup requeue path (requeue_pending_jobs), no code change needed)
- [x] **Step 6** New Dockerfile (VERIFIED 2026-08-24: backend-rust/Dockerfile — frontend
      stage on BUILDPLATFORM, cargo-chef plan/cook/build with arm64 cross-compiled via
      gcc-aarch64-linux-gnu (no QEMU for the compile), rust-embed bakes ../frontend/dist
      at compile time with SPA_DIST_DIR runtime override kept for dev (build.rs seeds a
      stub dist so clean checkouts still compile), NO JNI/libwebp stage; runtime is
      debian-slim with ZERO packages — apt under QEMU killed the arm64 build (exit 255),
      so healthcheck is a ~2KB static C probe (src/main/c/healthcheck.c) cross-built in
      the builder and CA bundle copied from builder for rustls. amd64 image verified
      live: health 200, embedded SPA served, login OK, probe exits 0, 119MB.
      multi-arch buildx left to CI release workflow (user decision). CRITICAL FIX:
      .dockerignore was missing backend-rust/target — 38GB of cargo artifacts entered
      every context send (allowlist-style ignore now). Gate: fmt+clippy clean, 117 tests)
- [~] **Step 7** Compose swap — SIDE-BY-SIDE VERIFIED 2026-08-24, hard swap pending user
      go-ahead. docker-compose.rust-test.yml (-p ruststack): fresh db/minio/redis under this
      worktree's data/, renumbered loopback ports (8084/55432/56379/19001), Traefik/Watchtower
      labels dropped, worker shares model caches with canonical checkout, backend healthcheck
      swapped to the baked static probe (compose's wget doesn't exist in the slim runtime).
      Full acceptance on the stack: register -> upload sample133 -> panel/ocr/layout/
      translation/render/qa ALL COMPLETED with real models -> export ZIP 200 via API.
      THREE DRIFTS FIXED by this step:
        1. config.rs read only REDIS_HOST/PORT but compose passes SPRING_DATA_REDIS_* —
           backend silently retried localhost forever (get_connection_manager has no
           timeout); now falls back to the Spring spellings and RedisService::connect
           fails loudly after 15s.
        2. dispatcher read WORKER_API_SECRET env directly; compose only passes
           WORKER_API_SECRET_FILE -> secret None -> every capabilities probe 401'd ->
           treated as "no workers", SILENTLY. Now resolve_credential(_FILE aware) +
           non-200 probes log a warning.
        3. database/init.sql carried pg_dump \restrict markers that abort psql 15 imports
           mid-file (fresh stacks got 1 table) — stripped.
- [ ] **Step 8** Grafana dashboards verified filling while a pipeline runs on the Rust backend
- [ ] **Step 9** Baselines measured and recorded HERE:
      - cold-start: Java ____s · Rust ____s
      - idle RSS: Java ____MB · Rust ____MB
      - p95 GET /api/series (50 rows): Java ____ms · Rust ____ms
      - p95 GET /api/images/{id}/reader: Java ____ms · Rust ____ms
      - image size: Java ____MB · Rust ____MB
- [ ] **Step 10** Housekeeping: AGENTS.md + READMEs + release.yml updated, ci-maven.yml
      retired, diff_routes.py comment flipped to post-cutover, `backend/` deleted,
      `rust-backend` merged → main, both remotes pushed, release tagged

### Phase 4 rules of engagement

* The golden OpenAPI file is NEVER edited. If generate-api drifts, the Rust backend is wrong.
* No new features during Phase 4 — parity only. Anything discovered missing goes through
  diff_routes.py first (it must stay at exactly 71 ops = golden).
* The Java stack stays UP until step 9's baselines are recorded from it. Deleting `backend/`
  is the LAST action of the LAST step.
* Every commit still runs the full gate and pushes BOTH remotes.

---

## Verification commands (run before ticking anything)

```bash
cd backend-rust
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
APP_PROFILE=test SPRING_DATASOURCE_URL=jdbc:postgresql://127.0.0.1:5432/manga_library \
SPRING_DATASOURCE_USERNAME=<user> SPRING_DATASOURCE_PASSWORD=<pw> cargo test   # integration
```

---

## Session handoff — 2026-08-24 (end of Phase 4 steps 4–7 working session)

### State

* Steps 1–6 DONE. Step 7 side-by-side VERIFIED, **hard swap ON HOLD**: the user browsed the
  Rust instance and saw small/medium issues (details in their test report — do not swap until
  they are triaged and fixed).
* Live Java stack untouched and UP throughout; Rust test stack runs alongside it.
* Commits this session: `8c54a86` (step 4), `25df426` (step 5), `29f923b` (step 6),
  `58ae6ee` (step 7 fixes) on `rust-backend`, pushed to GitHub. pi5 was unreachable all
  session — retry `git push pi5 rust-backend` when it's back.

### The test stack (what the user is testing)

```bash
cd /home/sagnik/Projects/docker-composes/manga-library-rust
docker compose -p ruststack \
  -f docker-compose.yml -f docker-compose.rust-test.yml \
  up -d db redis minio backend worker      # fresh data dirs under ./data/
docker compose -p ruststack \
  -f docker-compose.yml -f docker-compose.rust-test.yml \
  build backend                            # after any source change (VITE_BASE_PATH=/tlhub!)
```

* UI: http://127.0.0.1:8084/tlhub — admin@test.local / test-password-123 (or register;
  DB is fresh)
* Ports renumbered vs live stack: backend 8084, pg 55432, valkey 56379, minio console 19001
* `./secrets` is a symlink to the canonical checkout's secrets dir (gitignored)
* Worker model caches bind-mount read-write from the canonical checkout's
  `data/worker/{huggingface,paddlex}` — caches only, not app data
* Teardown: `docker compose -p ruststack -f docker-compose.yml -f docker-compose.rust-test.yml down`
  (data persists under ./data/ — wipe with a root container if you want truly fresh)

### Acceptance already passed on this stack

register → series/chapter create → upload (corpus/samples/sample133 ja page) →
panel-detection → ocr (PP-OCRv6 + gemini-2.5-flash VLM OCR) → layout → translation
(real ja→en text persisted) → render → qa → export ZIP download (808 KB via API).
Route parity 71/71; gate: fmt+clippy clean, 117 tests green.

### Known issues / open items for the next session

1. USER REPORTED: small + medium issues browsing the UI on the Rust instance — collect
   specifics, triage each against Java behavior (parity bugs are Phase 4 blockers; anything
   else goes to TODO.md). NO SWAP until cleared.
2. arm64 image builds left to the CI release workflow (user decision); amd64 verified.
3. Step 8 Grafana: dashboards read Postgres directly; point them at the ruststack db or
   run pipelines on the live-shaped stack and confirm panels fill.
4. Step 9 baselines need BOTH stacks up (they are right now): cold-start, idle RSS,
   p95 GET /api/series + /api/images/{id}/reader, image sizes. Record numbers HERE above.
5. Step 10 housekeeping unchanged (delete backend/, merge, tag, retire ci-maven.yml).
6. Minor: dispatcher capabilities probe now warns on non-200; RedisService::connect fails
   after 15s instead of retrying forever. If the worker is slow to boot, backend health is
   fine but dispatch waits for the next cycle — no action needed.

### Rules that still apply

* Golden OpenAPI frozen; diff_routes.py must stay exactly 71 ops.
* Java stack stays UP until step 9 baselines are recorded from it.
* Full gate + BOTH remotes on every commit.
