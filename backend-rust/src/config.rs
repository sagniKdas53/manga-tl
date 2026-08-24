//! Configuration loading.
//!
//! Rust refresher for this file:
//! - `struct` = data type with named fields (like a Java record).
//! - `impl` blocks attach functions to a type (like static methods).
//! - `Option<T>` is like `@Nullable T`, except the compiler forces you to handle the null case.
//! - `Result<T, E>` is a checked exception expressed as a value: `Ok(value)` or `Err(error)`.
//! - `Vec<String>` is a growable list of strings.
//!
//! This file ports two Java classes:
//!   * DockerSecretsEnvironmentPostProcessor -> [`resolve_credential`]
//!   * SecretsStartupValidator               -> [`check_secret`] + `Config::load` collecting ALL problems
//!
//! The rule is fail-closed: no secret, no startup — and every problem is reported at once,
//! so a misconfigured deployment is fixed in one pass instead of one restart per secret.
//!
//! Everything testable is written as a *pure function* (input in, output out, no global state).
//! That makes tests trivial AND sidesteps `std::env::set_var`, which became `unsafe` in the
//! Rust 2024 edition because mutating process-wide environment mid-run races other threads.

use std::env;
use std::fs;

/// Every setting the app needs at boot.
#[derive(Debug)]
pub struct Config {
    /// URL prefix every route lives under (Spring's `server.servlet.context-path`).
    /// Already normalized to start with `/` by the time you read it.
    pub context_path: String,
    /// HTTP port to listen on.
    pub port: u16,
    /// True under a development profile (`APP_PROFILE=local|test|integration`).
    /// (Read by main.rs logging and future feature flags; validated at startup already.)
    #[allow(dead_code)]
    pub development: bool,
    /// Postgres connection settings (sqlx will consume these in Phase 1).
    #[allow(dead_code)]
    pub database: DatabaseConfig,
    /// HS256/384/512 signing key for JWTs. Required outside development profiles.
    /// (Consumed by `jwt::JwtUtils`; validated at startup already.)
    #[allow(dead_code)]
    pub jwt_secret: Option<String>,
    /// Shared token between us and the Python worker for `/api/internal/**`.
    /// (Read by the internal-auth filter added in Phase 3.)
    #[allow(dead_code)]
    pub internal_api_token: Option<String>,
    /// JWT lifetime in milliseconds. Java: `jwt.expirationMs`, application.yml default 24h.
    pub jwt_expiration_ms: i64,
    /// Object storage connection settings.
    pub minio: MinioConfig,
    /// Redis/Valkey connection settings (Spring used SPRING_DATA_REDIS_*).
    pub redis: RedisConfig,
}

/// MinIO (S3-compatible) object storage. Compose passes:
///   MINIO_ENDPOINT=http://minio:9000   (scheme REQUIRED for the Java SDK; we keep it)
///   MINIO_EXTERNAL_URL=                (optional public base to rewrite presigned URLs)
///   MINIO_ACCESS_KEY / MINIO_SECRET_KEY(_FILE)
/// Redis/Valkey. Compose passes REDIS_HOST=redis / REDIS_PORT=6379.
#[derive(Debug, Clone)]
pub struct RedisConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone)]
pub struct MinioConfig {
    pub endpoint: String,
    pub external_url: Option<String>,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
}

/// Postgres connection details.
///
/// Compose hands these over Spring-style:
///   SPRING_DATASOURCE_URL=jdbc:postgresql://db:5432/manga_library
///   SPRING_DATASOURCE_USERNAME=postgres
///   SPRING_DATASOURCE_PASSWORD_FILE=/run/secrets/db_password
/// We accept that exact format so docker-compose.yml needs no changes at cutover.
/// (Fields are consumed when sqlx lands in Phase 1; until then they are validated-only.)
#[allow(dead_code)]
#[derive(Debug)]
pub struct DatabaseConfig {
    pub host: String,
    pub port: u16,
    pub name: String,
    pub user: String,
    pub password: String,
}

impl Config {
    /// Reads the environment and validates everything.
    ///
    /// Returns `Ok(Config)` or `Err(problems)` listing EVERY issue found; main.rs prints them
    /// and exits non-zero (mirroring SecretsStartupValidator's one-shot report).
    pub fn load() -> Result<Config, Vec<String>> {
        let mut problems: Vec<String> = Vec::new();

        let development = matches!(env_var("APP_PROFILE").as_deref(), Some(p) if DEVELOPMENT_PROFILES.contains(&p));

        let context_path = normalize_context_path(
            &env_var("CONTEXT_PATH").unwrap_or_else(|| "/tlhub".to_string()),
        );

        let port = match env_var("PORT") {
            None => 8080,
            Some(raw) => match raw.parse::<u16>() {
                Ok(p) if p > 0 => p,
                _ => {
                    problems.push(format!("PORT ({raw}) is not a valid TCP port."));
                    8080
                }
            },
        };

        let database = database_from_env(&mut problems);

        let jwt_secret = resolve_credential("JWT_SECRET", &mut problems);
        let internal_api_token = resolve_credential("INTERNAL_API_TOKEN", &mut problems);

        let jwt_expiration_ms = match env_var("JWT_EXPIRATION_MS") {
            None => 86_400_000, // 24h, same as application.yml
            Some(raw) => match raw.parse::<i64>() {
                Ok(ms) if ms > 0 => ms,
                _ => {
                    problems.push(format!(
                        "JWT_EXPIRATION_MS ({raw}) is not a positive integer."
                    ));
                    86_400_000
                }
            },
        };

        // MinIO creds are NOT startup-fatal on the Java side (empty yml defaults), so any
        // *_FILE problems are surfaced but the client tolerates absence at call time.
        let mut minio_problems = Vec::new();
        let minio = MinioConfig {
            endpoint: env_var("MINIO_ENDPOINT").unwrap_or_else(|| "http://localhost:9000".into()),
            external_url: env_var("MINIO_EXTERNAL_URL"),
            access_key: resolve_credential("MINIO_ACCESS_KEY", &mut minio_problems),
            secret_key: resolve_credential("MINIO_SECRET_KEY", &mut minio_problems),
        };
        problems.append(&mut minio_problems);

        let redis = RedisConfig {
            host: redis_host(env_var("REDIS_HOST"), env_var("SPRING_DATA_REDIS_HOST")),
            port: match redis_port(
                env_var("REDIS_PORT").or_else(|| env_var("SPRING_DATA_REDIS_PORT")),
            ) {
                Ok(p) => p,
                Err(problem) => {
                    problems.push(problem);
                    6379
                }
            },
        };

        // --- Port of SecretsStartupValidator.validate() ------------------------------
        problems.extend(check_secret(
            "JWT_SECRET",
            jwt_secret.as_deref(),
            MIN_JWT_SECRET_LENGTH,
            development,
        ));
        problems.extend(check_secret(
            "INTERNAL_API_TOKEN",
            internal_api_token.as_deref(),
            MIN_INTERNAL_TOKEN_LENGTH,
            development,
        ));

        if !problems.is_empty() {
            return Err(problems);
        }

        if development {
            tracing::warn!(
                "Development profile active: secrets are not checked against the \
                 known-insecure list. Never run this configuration in production."
            );
        }

        Ok(Config {
            context_path,
            port,
            development,
            database,
            jwt_secret,
            internal_api_token,
            jwt_expiration_ms,
            minio,
            redis,
        })
    }
}

// -------------------------------------------------------------------------------------------
// Pure helpers — no environment access, easy to reason about and to test.
// -------------------------------------------------------------------------------------------

/// Normalizes a context path to exactly one canonical form:
///   "" | "/"  -> "/"
///   "tlhub"   -> "/tlhub"
///   "/tlhub/" -> "/tlhub"
pub fn normalize_context_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return "/".to_string();
    }
    let with_slash = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    if with_slash.len() > 1 {
        with_slash.trim_end_matches('/').to_string()
    } else {
        with_slash
    }
}

/// Parses `jdbc:postgresql://HOST:PORT/DBNAME` into `(host, port, dbname)`.
/// Port defaults to 5432 when omitted; query strings after `?` are dropped.
pub fn parse_jdbc_url(url: &str) -> Option<(String, u16, String)> {
    let rest = url.strip_prefix("jdbc:postgresql://")?;
    let (hostport, name) = rest.split_once('/')?;
    let name = name.split('?').next()?;
    if hostport.is_empty() || name.is_empty() {
        return None;
    }
    let (host, port) = match hostport.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()?),
        None => (hostport.to_string(), 5432),
    };
    Some((host, port, name.to_string()))
}

/// One credential check, ported 1:1 from SecretsStartupValidator.check().
fn check_secret(name: &str, value: Option<&str>, min_len: usize, development: bool) -> Vec<String> {
    let mut problems = Vec::new();
    let Some(trimmed) = value else {
        problems.push(format!("{name} is not set."));
        return problems;
    };
    // Development profiles tolerate short/insecure values — but the secret must still exist.
    if development {
        return problems;
    }
    if trimmed.len() < min_len {
        problems.push(format!(
            "{name} is only {} characters; at least {min_len}.",
            trimmed.len()
        ));
    }
    let lowered = trimmed.to_lowercase();
    if KNOWN_INSECURE_SECRETS.contains(&lowered.as_str()) {
        problems.push(format!(
            "{name} is a known-public development value and cannot be used."
        ));
    }
    problems
}

// -------------------------------------------------------------------------------------------
// Environment-reading helpers (impure; kept thin).
// -------------------------------------------------------------------------------------------

/// Resolves a credential exactly like DockerSecretsEnvironmentPostProcessor did:
///   1. If `<NAME>_FILE` is set, treat its value as a path to a Docker secret file.
///   2. Otherwise fall back to plain `<NAME>`.
///
/// A missing value simply yields `None`; an unreadable/empty FILE records a problem.
/// Public so the job dispatcher can resolve `WORKER_API_SECRET(_FILE)` the same way
/// Config does — compose only passes the _FILE form.
pub fn resolve_credential(name: &str, problems: &mut Vec<String>) -> Option<String> {
    match env::var(format!("{name}_FILE")) {
        Ok(path) => match fs::read_to_string(&path) {
            Ok(content) => {
                let value = content.trim();
                if value.is_empty() {
                    problems.push(format!("{name}_FILE ({path}) exists but is empty."));
                    None
                } else {
                    Some(value.to_string())
                }
            }
            Err(err) => {
                problems.push(format!("{name}_FILE ({path}) cannot be read: {err}"));
                None
            }
        },
        Err(_) => env::var(name)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
    }
}

/// Builds DatabaseConfig from the environment, translating the JDBC URL compose gives us.
fn database_from_env(problems: &mut Vec<String>) -> DatabaseConfig {
    let url = env_var("SPRING_DATASOURCE_URL").unwrap_or_default();

    let (host, port, name) = match parse_jdbc_url(&url) {
        Some(triple) => triple,
        None => {
            problems.push(format!(
                "SPRING_DATASOURCE_URL ({url}) is not jdbc:postgresql://HOST:PORT/DBNAME."
            ));
            ("localhost".to_string(), 5432, "manga_library".to_string())
        }
    };

    let user = env_var("SPRING_DATASOURCE_USERNAME").unwrap_or_else(|| "postgres".to_string());

    let mut pw_problems = Vec::new();
    let password = resolve_credential("SPRING_DATASOURCE_PASSWORD", &mut pw_problems);
    // Surface any file-read errors under their real variable name.
    for p in pw_problems {
        problems.push(p.replace("SPRING_DATASOURCE_PASSWORD_FILE", "database password file"));
    }
    let password = match password {
        Some(p) => p,
        None => {
            problems.push(
                "Database password is not set (SPRING_DATASOURCE_PASSWORD or \
                 SPRING_DATASOURCE_PASSWORD_FILE)."
                    .to_string(),
            );
            String::new()
        }
    };

    DatabaseConfig {
        host,
        port,
        name,
        user,
        password,
    }
}

/// Redis host resolution: the native `REDIS_HOST` wins (it is also the worker's own
/// knob, so a shared .env keeps both services in agreement), the Spring property name
/// that compose passes (`SPRING_DATA_REDIS_HOST`) is the fallback, keeping the compose
/// file byte-identical across the cutover.
fn redis_host(native: Option<String>, spring: Option<String>) -> String {
    native.or(spring).unwrap_or_else(|| "localhost".into())
}

/// Redis port resolution over either spelling; non-numeric or zero values are problems.
fn redis_port(raw: Option<String>) -> Result<u16, String> {
    match raw {
        None => Ok(6379),
        Some(raw) => match raw.parse::<u16>() {
            Ok(p) if p > 0 => Ok(p),
            _ => Err(format!("REDIS_PORT ({raw}) is not a valid TCP port.")),
        },
    }
}

/// Env var helper treating empty/whitespace-only values as unset.
fn env_var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Profiles under which placeholder development secrets are acceptable.
const DEVELOPMENT_PROFILES: [&str; 3] = ["local", "test", "integration"];

/// Values that must never authenticate anything outside development.
/// Copied verbatim from SecretsStartupValidator.KNOWN_INSECURE_SECRETS.
const KNOWN_INSECURE_SECRETS: [&str; 6] = [
    "5367566b59703373367639792f423f4528482b4d6251655468576d5a71347437",
    "manga-library-internal-token-12345",
    "dev-only-insecure-jwt-secret-do-not-use-in-production-0000000000",
    "dev-only-insecure-internal-token-do-not-use-in-production",
    "changeme",
    "secret",
];

/// HS256 signing keys must carry at least 256 bits of material.
const MIN_JWT_SECRET_LENGTH: usize = 32;
const MIN_INTERNAL_TOKEN_LENGTH: usize = 16;

// -------------------------------------------------------------------------------------------
// Tests — run with `cargo test`. No env mutation here: pure functions only.
// -------------------------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_secrets_fail_even_in_development() {
        assert_eq!(
            check_secret("JWT_SECRET", None, MIN_JWT_SECRET_LENGTH, true),
            vec!["JWT_SECRET is not set.".to_string()]
        );
    }

    #[test]
    fn insecure_secret_rejected_in_production() {
        let problems = check_secret("JWT_SECRET", Some("changeme"), MIN_JWT_SECRET_LENGTH, false);
        assert!(problems.iter().any(|p| p.contains("known-public")));
    }

    #[test]
    fn insecure_secret_tolerated_in_development() {
        assert!(
            check_secret("JWT_SECRET", Some("changeme"), MIN_JWT_SECRET_LENGTH, true).is_empty()
        );
    }

    #[test]
    fn short_known_public_value_lists_both_problems() {
        // "secret": only 6 characters (< 16) AND on the known-insecure list.
        let problems = check_secret(
            "INTERNAL_API_TOKEN",
            Some("secret"),
            MIN_INTERNAL_TOKEN_LENGTH,
            false,
        );
        assert_eq!(problems.len(), 2, "length and known-public both reported");
    }

    #[test]
    fn long_unique_secret_accepted_in_production() {
        let good = "x".repeat(MIN_JWT_SECRET_LENGTH);
        assert!(check_secret("JWT_SECRET", Some(&good), MIN_JWT_SECRET_LENGTH, false).is_empty());
    }

    #[test]
    fn redis_env_names_fall_back_to_spring_spelling() {
        // Native knob wins over the Spring property compose passes.
        assert_eq!(
            redis_host(Some("native".into()), Some("spring".into())),
            "native"
        );
        // Spring-only deployment (compose as shipped).
        assert_eq!(
            redis_host(None, Some("redis-in-compose".into())),
            "redis-in-compose"
        );
        // Neither set -> loopback default.
        assert_eq!(redis_host(None, None), "localhost");

        assert_eq!(redis_port(None), Ok(6379));
        assert_eq!(redis_port(Some("6380".into())), Ok(6380));
        assert!(redis_port(Some("0".into())).is_err());
        assert!(redis_port(Some("nope".into())).is_err());
    }

    #[test]
    fn jdbc_urls_parse() {
        let (host, port, name) =
            parse_jdbc_url("jdbc:postgresql://db:5432/manga_library").expect("should parse");
        assert_eq!(
            (host.as_str(), port, name.as_str()),
            ("db", 5432, "manga_library")
        );

        // Default port when omitted.
        let (_, port, _) = parse_jdbc_url("jdbc:postgresql://db/manga_library").unwrap();
        assert_eq!(port, 5432);

        // Query string stripped.
        let (_, _, name) =
            parse_jdbc_url("jdbc:postgresql://db:5433/manga_library?sslmode=require").unwrap();
        assert_eq!(name, "manga_library");
    }

    #[test]
    fn bad_jdbc_urls_rejected() {
        assert!(parse_jdbc_url("jdbc:mysql://db/x").is_none());
        assert!(parse_jdbc_url("not-a-url").is_none());
        assert!(parse_jdbc_url("jdbc:postgresql:///").is_none());
        assert!(parse_jdbc_url("jdbc:postgresql://db:99999/x").is_none()); // port out of range
    }

    #[test]
    fn context_paths_normalize() {
        assert_eq!(normalize_context_path(""), "/");
        assert_eq!(normalize_context_path("/"), "/");
        assert_eq!(normalize_context_path("  "), "/");
        assert_eq!(normalize_context_path("tlhub"), "/tlhub");
        assert_eq!(normalize_context_path("/tlhub/"), "/tlhub");
        assert_eq!(normalize_context_path(" /tlhub "), "/tlhub");
    }
}
