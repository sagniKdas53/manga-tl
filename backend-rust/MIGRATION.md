# Migration checkpoints — Java/Spring Boot → Rust/axum

Living checklist for the rewrite on branch `rust-backend`. Tick items only when they are
implemented AND verified (build/clippy/test green, live behavior checked where applicable).
The frozen contract lives in `spec/golden-openapi.json` (71 operations, 26 schemas).

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

## Phase 1 — Foundation (no API surface yet) 🔄

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
- [ ] MinIO client service (`aws-sdk-s3` against MinIO; putObject/getObject/stat/stream/delete)
- [ ] Redis client + pub/sub plumbing (job push channel, provider-config invalidation channel)
- [ ] WebP thumbnail encode/decode via libwebp bindings (replaces JNI vendored-C story)
- [ ] Password hashing parity check (verify BCrypt hashes written by Java side)

## Phase 2 — CRUD APIs (contract-frozen ports)

- [ ] utoipa annotations wired; CI job diffs generated spec vs `golden-openapi.json`
- [ ] Error handling parity: RFC-7807 `application/problem+json` bodies like `GlobalExceptionHandler`
- [ ] `AuthController` — register/login/me(PUT/GET/DELETE)/refresh/change-password/setup-required
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
