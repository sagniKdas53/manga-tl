//! Authentication & authorization primitives.
//!
//! Ports two Java pieces:
//!   * JwtAuthFilter + SecurityConfig rules -> [`AuthUser`] extractor
//!   * InternalAuthFilter                   -> [`require_internal_token`]
//!
//! SEMANTICS WORTH KNOWING (they are surprising but they are THE CONTRACT):
//! - The Java filter NEVER rejects by itself. It authenticates when it can and lets
//!   authorization decide later. A missing OR invalid OR unknown-user token all end up
//!   the same way on protected API routes: HTTP 403 with
//!   `{"timestamp": "...+00:00", "status": 403, "error": "Forbidden", "path": "..."}`
//!   (verified live against the running backend; note the path INCLUDES /tlhub).
//! - `/api/internal/**` instead requires the `X-Internal-Token` header compared in
//!   constant time; failures are HTTP 401 with
//!   `{"error": "Unauthorized: Invalid internal token"}`.
//!
//! Rust refresher:
//! - `FromRequestParts` is how handlers declare "give me an X or fail the request".
//!   `AuthUser` as a handler parameter == Spring's `@AuthenticationPrincipal`.
//! - The `Rejection` type is what the caller receives when extraction fails; we return
//!   the ready-made 403 response so handlers never see unauthenticated traffic.

use axum::Json;
use axum::extract::FromRequestParts;
use axum::http::{StatusCode, header, request::Parts};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::models::User;
use crate::state::AppState;

/// The authenticated principal, resolved exactly like JwtAuthFilter does:
/// Bearer token -> verify signature/expiry -> look the user up by email in Postgres.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    /// Uppercased role ("ADMIN", "USER", ...), matching the ROLE_ authority Java derives.
    pub role: String,
}
impl From<User> for AuthUser {
    fn from(user: User) -> Self {
        Self {
            id: user.id,
            email: user.email,
            display_name: user.display_name,
            // Stored VERBATIM: Java's @AuthenticationPrincipal carries the raw entity
            // (endpoints like GET /me return it unchanged); only the ROLE_ authority
            // string was uppercased inside the filter, and nothing consumes that yet.
            role: user.role,
        }
    }
}

/// Shared resolution logic: Bearer -> verify -> load user. Used by both the strict
/// extractor below and MaybeAuthUser.
async fn resolve_auth_user(parts: &mut Parts, state: &AppState) -> Option<AuthUser> {
    let token = bearer_token(&parts.headers)?;
    let email = state.jwt.email_from_token(&token).ok()?;
    let user: Option<User> = sqlx::query_as("SELECT * FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    user.map(AuthUser::from)
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match resolve_auth_user(parts, state).await {
            Some(auth_user) => Ok(auth_user),
            None => Err(forbidden_like_spring(state, &parts.uri)),
        }
    }
}

/// Never-failing variant for endpoints that answer THEMSELVES when unauthenticated
/// (Java's @AuthenticationPrincipal == null paths, e.g. /api/auth/me returning
/// 401 {"message":"Not authenticated"} instead of security's 403).
pub struct MaybeAuthUser(pub Option<AuthUser>);

impl FromRequestParts<AppState> for MaybeAuthUser {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(MaybeAuthUser(resolve_auth_user(parts, state).await))
    }
}

/// Extracts the token from `Authorization: Bearer <token>` — header only.
/// The old `?token=` fallback was removed on the Java side for log-leak reasons (AUDIT-S4).
pub fn bearer_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?;
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// The 403 response Spring Security produces for denied API access, byte-shape identical:
/// Boot's error attributes with a millisecond ISO timestamp carrying a literal `+00:00`.
pub fn forbidden_like_spring(state: &AppState, uri: &axum::http::Uri) -> Response {
    let path = format!("{}{}", state.config.context_path, uri.path());
    let timestamp = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3f+00:00");
    let body = json!({
        "timestamp": timestamp.to_string(),
        "status": 403,
        "error": "Forbidden",
        "path": path,
    });
    (StatusCode::FORBIDDEN, Json(body)).into_response()
}

// -------------------------------------------------------------------------------------------
// Internal worker API guard (/api/internal/**)
// -------------------------------------------------------------------------------------------

/// Constant-time equality over UTF-8 bytes, mirroring `MessageDigest.isEqual`: compares up
/// to the longer input so response timing leaks nothing about the shared secret.
/// (The fail-closed "unconfigured never matches" rule lives in `check_internal_token`.)
fn constant_time_eq(actual: &[u8], expected: &[u8]) -> bool {
    // Bytes are widened so the length difference and byte differences share one accumulator
    // without type gymnastics.
    let mut diff = (actual.len() ^ expected.len()) as u64;
    for i in 0..actual.len().max(expected.len()) {
        let a = actual.get(i).copied().unwrap_or(0);
        let b = expected.get(i).copied().unwrap_or(0);
        diff |= u64::from(a ^ b);
    }
    diff == 0
}

/// Result of checking `X-Internal-Token` against the configured secret.
pub enum InternalAuth {
    Ok,
    Invalid,
}

/// Verifies the header the Python worker sends on every `/api/internal/**` call.
pub fn check_internal_token(configured: Option<&str>, header_value: Option<&str>) -> InternalAuth {
    match (configured.filter(|c| !c.is_empty()), header_value) {
        (Some(expected), Some(actual))
            if constant_time_eq(actual.as_bytes(), expected.as_bytes()) =>
        {
            InternalAuth::Ok
        }
        _ => InternalAuth::Invalid,
    }
}

/// The exact 401 body InternalAuthFilter writes on failure (space after the colon included).
pub fn unauthorized_internal_token() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(
            header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("application/json"),
        )],
        r#"{"error": "Unauthorized: Invalid internal token"}"#,
    )
        .into_response()
}

// -------------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"", b"x"), "empty expected never matches");
        assert!(!constant_time_eq(b"x", b""), "absent header never matches");
    }

    #[test]
    fn bearer_parsing_follows_java_filter() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            axum::http::HeaderValue::from_static("Bearer tok.en.here"),
        );
        assert_eq!(bearer_token(&headers).as_deref(), Some("tok.en.here"));

        headers.insert(
            header::AUTHORIZATION,
            axum::http::HeaderValue::from_static("bearer lowercase-not-accepted"),
        );
        assert_eq!(bearer_token(&headers), None, "Java checks case-sensitively");

        headers.insert(
            header::AUTHORIZATION,
            axum::http::HeaderValue::from_static("Bearer "),
        );
        assert_eq!(bearer_token(&headers), None);
        assert_eq!(bearer_token(&axum::http::HeaderMap::new()), None);
    }

    #[test]
    fn internal_token_check_mirrors_filter() {
        assert!(matches!(
            check_internal_token(Some("tok-123"), Some("tok-123")),
            InternalAuth::Ok
        ));
        assert!(matches!(
            check_internal_token(Some("tok-123"), Some("wrong")),
            InternalAuth::Invalid
        ));
        assert!(matches!(
            check_internal_token(Some("tok-123"), None),
            InternalAuth::Invalid
        ));
        assert!(matches!(
            check_internal_token(None, Some("anything")),
            InternalAuth::Invalid
        ));
    }

    #[tokio::test]
    async fn unauthorized_body_matches_java_bytes() {
        let response = unauthorized_internal_token();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let bytes = http_body_util::BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(
            &bytes[..],
            &br#"{"error": "Unauthorized: Invalid internal token"}"#[..]
        );
    }
}
