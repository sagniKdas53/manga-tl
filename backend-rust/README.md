# manga-backend (Rust)

The production backend service for Manga Library, built with Axum, Tokio, and SQLx.
It replaced the earlier Spring Boot service, serving the API contract defined in
`spec/golden-openapi.json` (71 routes, 26 schemas) with native WebP generation,
in-memory SSE broadcasting, and async pipeline coordination.

## Architecture

- **Web Framework**: Axum 0.8 on Tokio
- **Database**: PostgreSQL via SQLx connection pools
- **Object Storage**: MinIO (S3-compatible API via AWS SDK)
- **Cache & Pub/Sub**: Valkey / Redis via `redis` crate
- **Image Processing**: Native WebP decoding and encoding via `image` and `webp` crates
- **Frontend Serving**: Embedded React SPA assets via `rust-embed` at `/tlhub/`

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

## Migration History

The transition from Java/Spring Boot to Rust/Axum was executed in 5 phases, detailed in [MIGRATION.md](MIGRATION.md):

- **Phase 0 (Completed)**: Contract freeze, configuration validation, logging, health endpoints, router mounting under `/tlhub`, graceful shutdown.
- **Phase 1 (Completed)**: SQLx compile-time query verification against `database/init.sql`, JWT utilities, MinIO client.
- **Phase 2 (Completed)**: CRUD operations (auth, series, chapters, pages, images, layers, settings), streaming downloads, native WebP thumbnails via libwebp.
- **Phase 3 (Completed)**: Job pipeline coordinator (`jobs/coordinator.rs`), worker callbacks, Redis pub/sub, SSE notification broadcasts.
- **Phase 4 (Completed)**: 48-scenario parity verification, multi-stage Dockerfile with embedded frontend SPA, compose cutover, and decommissioning of the Java tree.
