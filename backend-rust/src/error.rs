//! Error responses — port of `GlobalExceptionHandler` + Boot's security/error defaults.
//!
//! Three DISTINCT families live here (verified live against the running backend):
//!
//! 1. RFC-7807 problem+json (GlobalExceptionHandler): content-type
//!    `application/problem+json`, body
//!    `{type:"about:blank", title, status, detail, instance:"/tlhub/…" [,timestamp] [,errors]}`.
//!    Handlers that set a `timestamp` property use Java's `Instant.toString()`: nanosecond
//!    precision with trailing-zero groups trimmed and a literal `Z`.
//! 2. Boot's error-attributes shape for SECURITY denials (auth.rs 403) and malformed
//!    request bodies (`{type,title,status,detail,instance}` — note: no timestamp).
//! 3. Raw text/plain bodies some controllers return directly ("Invalid credentials").
//!
//! Rust refresher: `serde_json::json!` builds Values; we enabled serde_json's
//! `preserve_order` feature so keys serialize in insertion order like Jackson does,
//! keeping our bytes visually comparable to captured Java responses.

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{Datelike, Timelike, Utc};
use serde_json::json;

/// Content type GlobalExceptionHandler emits via ProblemDetail.
pub const PROBLEM_JSON: &str = "application/problem+json";

/// Java `Instant.now().toString()` equivalent: variable-precision fraction, trailing
/// zeros trimmed (e.g. `.74Z`, `.742493926Z`), never empty when sub-second.
fn java_instant_now() -> String {
    let now = Utc::now();
    let base = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    );
    let nanos = now.timestamp_subsec_nanos();
    if nanos == 0 {
        return format!("{base}Z");
    }
    // 9 digits, right-trimmed of trailing zeros.
    let frac = format!("{nanos:09}").trim_end_matches('0').to_string();
    format!("{base}.{frac}Z")
}

/// Builds a problem+json response. `extra_properties` are merged after the standard five
/// fields (Jackson writes ProblemDetail's own fields first, then custom properties).
fn problem_response(
    status: StatusCode,
    title: &str,
    detail: &str,
    instance: &str,
    extra_properties: Option<serde_json::Value>,
) -> Response {
    let mut body = json!({
        "type": "about:blank",
        "title": title,
        "status": status.as_u16(),
        "detail": detail,
        "instance": instance,
    });
    if let (Some(serde_json::Value::Object(extra)), Some(map)) =
        (extra_properties, body.as_object_mut())
    {
        for (k, v) in extra {
            map.insert(k, v);
        }
    }
    (
        status,
        [(header::CONTENT_TYPE, PROBLEM_JSON)],
        body.to_string(),
    )
        .into_response()
}

/// Full path as Boot reports it (context path included), e.g. `/tlhub/api/auth/register`.
pub fn full_path(context_path: &str, uri: &axum::http::Uri) -> String {
    format!("{context_path}{}", uri.path())
}

// ---------------------------------------------------------------------------
// GlobalExceptionHandler ports (all include the timestamp property)
// ---------------------------------------------------------------------------

/// ResourceNotFoundException → 404, detail = exception message.
pub fn not_found(detail: &str, instance: &str) -> Response {
    problem_response(
        StatusCode::NOT_FOUND,
        "Not Found",
        detail,
        instance,
        Some(json!({ "timestamp": java_instant_now() })),
    )
}

/// IllegalArgumentException / service-level bad input → 400.
pub fn bad_request(detail: &str, instance: &str) -> Response {
    problem_response(
        StatusCode::BAD_REQUEST,
        "Bad Request",
        detail,
        instance,
        Some(json!({ "timestamp": java_instant_now() })),
    )
}

/// MethodArgumentNotValidException → 400 + per-field messages from @Valid.
/// Messages mirror the jakarta annotations on the Java DTOs exactly.
pub fn validation_failed(instance: &str, field_errors: Vec<(&str, &str)>) -> Response {
    let mut errors = serde_json::Map::new();
    for (field, message) in field_errors {
        errors.insert(field.to_string(), json!(message));
    }
    problem_response(
        StatusCode::BAD_REQUEST,
        "Validation Failed",
        "Validation failed for request",
        instance,
        Some(json!({
            "timestamp": java_instant_now(),
            "errors": errors,
        })),
    )
}

/// AccessDeniedException (@PreAuthorize) → authenticated-but-insufficient → 403.
pub fn access_denied(instance: &str) -> Response {
    problem_response(
        StatusCode::FORBIDDEN,
        "Forbidden",
        "You do not have permission to perform this action",
        instance,
        Some(json!({ "timestamp": java_instant_now() })),
    )
}

/// True when a multipart read failed because the request body ran past
/// `routes::MAX_REQUEST_BODY_BYTES`.
///
/// axum reports the overrun through `MultipartError::status()` as 413; Spring raised
/// `MaxUploadSizeExceededException` for the same condition, which
/// `GlobalExceptionHandler` answered with the [`payload_too_large`] problem+json below.
/// Every multipart handler checks this so an oversized upload gets that shape instead of
/// being reported as a malformed request — or, worse, silently truncated.
pub fn is_payload_too_large(err: &axum::extract::multipart::MultipartError) -> bool {
    err.status() == StatusCode::PAYLOAD_TOO_LARGE
}

/// MaxUploadSizeExceededException → 413 (compose/yml cap is 50MB).
pub fn payload_too_large(instance: &str) -> Response {
    problem_response(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Payload Too Large",
        "File exceeds maximum upload size",
        instance,
        Some(json!({ "timestamp": java_instant_now() })),
    )
}

/// NPE or any other unhandled failure → 500 with generic detail (message goes to logs only).
pub fn internal_error(instance: &str) -> Response {
    problem_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Internal Server Error",
        "An unexpected internal error occurred",
        instance,
        Some(json!({ "timestamp": java_instant_now() })),
    )
}

// ---------------------------------------------------------------------------
// Boot defaults WITHOUT timestamp
// ---------------------------------------------------------------------------

/// HttpMessageNotReadableException (malformed JSON body) → 400, detail fixed by Boot.
pub fn unreadable_body(instance: &str) -> Response {
    problem_response(
        StatusCode::BAD_REQUEST,
        "Bad Request",
        "Failed to read request",
        instance,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;

    async fn body_json(response: Response) -> serde_json::Value {
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            PROBLEM_JSON
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn validation_shape_matches_live_capture() {
        let response = validation_failed(
            "/tlhub/api/auth/register",
            vec![("email", "Email is required")],
        );
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["type"], "about:blank");
        assert_eq!(body["title"], "Validation Failed");
        assert_eq!(body["status"], 400);
        assert_eq!(body["detail"], "Validation failed for request");
        assert_eq!(body["instance"], "/tlhub/api/auth/register");
        assert_eq!(body["errors"]["email"], "Email is required");
        // Instant-style timestamp: ends in Z, has a fractional part without trailing zeros.
        let ts = body["timestamp"].as_str().unwrap();
        assert!(ts.ends_with('Z') && ts.contains('.'));
        assert!(
            !ts.split('.')
                .nth(1)
                .unwrap()
                .trim_end_matches('Z')
                .ends_with('0')
        );
    }

    #[tokio::test]
    async fn unreadable_body_has_no_timestamp_like_boot() {
        let response = unreadable_body("/tlhub/api/auth/login");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert_eq!(body["title"], "Bad Request");
        assert_eq!(body["detail"], "Failed to read request");
        assert!(body.get("timestamp").is_none());
    }

    #[test]
    fn instant_format_trims_trailing_zeros() {
        // Deterministic check of the trimming logic itself.
        let formatted = {
            let nanos: u32 = 742_000_000; // .742 would be Java's output
            let base = "2026-08-23T05:56:33";
            let frac = format!("{nanos:09}").trim_end_matches('0').to_string();
            format!("{base}.{frac}Z")
        };
        assert_eq!(formatted, "2026-08-23T05:56:33.742Z");
    }

    #[tokio::test]
    async fn access_denied_is_403_with_fixed_detail() {
        let response = access_denied("/tlhub/api/layers/1");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = body_json(response).await;
        assert_eq!(
            body["detail"],
            "You do not have permission to perform this action"
        );
        assert_eq!(body["title"], "Forbidden");
    }

    #[test]
    fn full_path_prepends_context() {
        let uri: axum::http::Uri = "/api/series".parse().unwrap();
        assert_eq!(full_path("/tlhub", &uri), "/tlhub/api/series");
    }

    #[allow(dead_code)]
    fn ensure_body_type_usable(_b: Body) {}
}
