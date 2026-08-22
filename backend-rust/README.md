# manga-backend (Rust)

The Rust rewrite of the Java/Spring Boot backend. Lives alongside `backend/` (Java) until
the cutover; the HTTP contract is frozen — `spec/golden-openapi.json` is the exported spec
from the running Java app (71 routes, 26 schemas), and the Rust side must match it.

## Why this exists

Same reasons you are reading this: no Maven, no JVM warmup, no 400-line factory beans.
A debug binary builds in seconds; the release image is a ~20 MB static musl binary instead
of a JRE + fat jar.

## Quick start

```bash
# one-time
cp .env.local.example .env.local

cargo run            # build + serve on http://localhost:8080/tlhub/actuator/health
curl localhost:8080/tlhub/actuator/health   # -> {"status":"UP"}
```

Everyday commands:

| Command | What it does | Java equivalent |
|---|---|---|
| `cargo run` | compile (debug) + start server | `mvn spring-boot:run` |
| `cargo test` | run all tests | `mvn test` |
| `cargo clippy --all-targets -- -D warnings` | linter, fails on any warning | SpotBugs/PMD |
| `cargo fmt` | auto-format everything | Spotless |
| `cargo build --release` | optimized build | `mvn package -Pprod` |

With no `.env.local` and no env vars, startup refuses with a list of every missing piece
(fail-closed, ported from `SecretsStartupValidator`). That is intentional.

## File map

```
src/
  main.rs          entrypoint: dotenv -> logging -> config -> router -> serve.
                   Graceful SIGTERM/Ctrl-C shutdown (compose sends SIGTERM).
  config.rs        Config loading + fail-closed validation.
                   Ports DockerSecretsEnvironmentPostProcessor (NAME_FILE secret files,
                   plain NAME fallback) and SecretsStartupValidator (min lengths,
                   known-insecure list, dev-profile bypass). Also translates the
                   jdbc:postgresql:// URL compose passes into host/port/name parts.
  state.rs         AppState — shared state handlers receive, like @Autowired services.
  routes/
    mod.rs         Router assembly. Nests everything under CONTEXT_PATH (/tlhub),
                   matching Spring's context-path. Add new route modules here.
    health.rs      /actuator/health (+ liveness/readiness) returning {"status":"UP"}.
spec/
  golden-openapi.json   The frozen API contract, exported live from the Java backend.
  golden-routes.txt     Human-readable inventory of all 71 operations.
.env.local.example     Copy to .env.local for local dev (gitignored).
```

## Rust concepts you will keep meeting

| Spring world | Rust world |
|---|---|
| `pom.xml` | `Cargo.toml` (+ committed `Cargo.lock`) |
| Maven Central | crates.io |
| Jackson | serde (`#[derive(Serialize)]` on a struct = serializable DTO) |
| `@Autowired`, ApplicationContext | axum state (`AppState`, passed via `.with_state()`) |
| Filters / interceptors | tower layers (`.layer(...)` on the router) |
| `Optional<T>` | `Option<T>` |
| checked exceptions | `Result<T, E>`, propagate with `?` |
| interfaces | traits |
| JUnit | built-in `#[test]` functions, `assert!`/`assert_eq!` |
| SLF4J/logback | `tracing` (`tracing::info!(...)`) |

Reading errors: cargo prints the failing file/line and usually a "help:" suggestion that is
literally the fix. Read the help line first; paste anything confusing into conversation.

## Migration phases

- **Phase 0 (done)** — contract freeze + scaffold: config/secrets/validation, logging,
  health endpoints, router under `/tlhub`, graceful shutdown, tests.
- **Phase 1** — sqlx (compile-time-checked SQL) against the existing schema in
  `database/init.sql`; JWT utils; MinIO client. No new routes yet.
- **Phase 2** — CRUD controllers (auth, series/chapters/pages/images, layers, settings),
  streaming downloads, WebP thumbnails via libwebp bindings (no JNI dance).
- **Phase 3** — job pipeline port (`JobCoordinatorService`), worker callbacks
  (`/api/internal/**`), Redis pub/sub, SSE notifications.
- **Phase 4** — parity tests vs the 48 Java test files' scenarios, new Dockerfile
  (cargo-chef, frontend embedded, musl static), compose swap, delete `backend/`.

Contract rule for Phases 2–3: after each controller lands, regenerate the OpenAPI doc from
utoipa annotations and diff it against `spec/golden-openapi.json` before moving on.
