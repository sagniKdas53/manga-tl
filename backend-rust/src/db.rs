//! Postgres connectivity (Phase 1 foundation).
//!
//! Rust refresher for this file:
//! - sqlx talks to Postgres asynchronously. A `PgPool` is a small set of reusable
//!   connections — the moral equivalent of Spring's HikariCP DataSource.
//! - `PgConnectOptions` is a builder: each method returns a modified copy, so you chain
//!   `.host(..).port(..)...`. Using it means we never hand-craft a URL string for the
//!   actual connection; the library escapes everything properly.
//! - We still build a URL *string* for logs/CI (`build_postgres_url`), which is why
//!   user/password get percent-encoded there manually.

use std::time::Duration;

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};

use crate::config::DatabaseConfig;

/// Connection options derived from our config. No I/O happens here, so it is cheap and
/// usable in tests.
pub fn connect_options(config: &DatabaseConfig) -> PgConnectOptions {
    PgConnectOptions::new()
        .host(&config.host)
        .port(config.port)
        .database(&config.name)
        .username(&config.user)
        .password(&config.password)
}

/// Creates a connection pool and verifies Postgres is actually reachable by opening one
/// connection before returning. This is what makes startup fail fast when the DB is down
/// or the password file is wrong — same contract as Spring booting its DataSource.
pub async fn connect(config: &DatabaseConfig) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        // The Java side runs Hikari at Spring Boot's default of 10 connections.
        .max_connections(10)
        // Fail an unresponsive DB acquire after 5s rather than hanging requests forever.
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(connect_options(config))
        .await
}

/// Builds a `postgres://user:password@host:port/name` URL for logs/CI wiring only
/// (the live connection path uses `PgConnectOptions`, which escapes internally).
///
/// Percent-encoding rule used here: encode every byte that is not an unreserved URL
/// character (ALPHA / DIGIT / `-` `.` `_` `~`). `%XX` hex form, uppercase digits,
/// matching RFC 3986 and what `urlencoding::encode` produces.
#[allow(dead_code)] // consumed by migration tooling in an upcoming slice
pub fn build_postgres_url(config: &DatabaseConfig) -> String {
    format!(
        "postgres://{}:{}@{}:{}/{}",
        percent_encode(&config.user),
        percent_encode(&config.password),
        config.host,
        config.port,
        config.name
    )
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(user: &str, password: &str) -> DatabaseConfig {
        DatabaseConfig {
            host: "db".to_string(),
            port: 5432,
            name: "manga_library".to_string(),
            user: user.to_string(),
            password: password.to_string(),
        }
    }

    #[test]
    fn plain_credentials_pass_through() {
        assert_eq!(
            build_postgres_url(&db("postgres", "devpw")),
            "postgres://postgres:devpw@db:5432/manga_library"
        );
    }

    #[test]
    fn special_characters_are_percent_encoded() {
        assert_eq!(
            build_postgres_url(&db("user@x", "p@ss/w:rd%20")),
            "postgres://user%40x:p%40ss%2Fw%3Ard%2520@db:5432/manga_library"
        );
    }

    #[test]
    fn unicode_is_encoded_byte_wise() {
        // é is two bytes in UTF-8 (0xC3 0xA9), so it must become %C3%A9.
        assert_eq!(percent_encode("é"), "%C3%A9");
    }
}
