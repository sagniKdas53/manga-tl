//! `/api/auth/**` — full port of AuthController.
//!
//! CONTRACT NOTES (all verified live against the running Java backend):
//! - Success bodies are `AuthResponse{token,id,email,displayName,role}` with camelCase
//!   keys; `token` serializes as explicit null on GET/PUT /me (Jackson includes nulls).
//! - Register/login failures are PLAIN TEXT (`text/plain;charset=UTF-8`) bodies:
//!   400 "Email already exists"
//!   400 "Cannot register as Admin. Admin is created on first registration."
//!   401 "Invalid credentials"
//! - Unauthenticated calls to principal-taking endpoints return
//!   401 {"message":"Not authenticated"} <- the CONTROLLER's shape, not security-403.
//!   Hence this module uses MaybeAuthUser, not AuthUser (whose rejection is a 403).
//! - Validation failures are problem+json via error::validation_failed with the exact
//!   jakarta messages; field errors are collected ALL AT ONCE like Hibernate does.
//! - First-ever registration becomes ADMIN; afterwards admin role is rejected.
//!
//! Rust refresher:
//! - `Option<AuthUser>`-style extraction is hand-rolled as MaybeAuthUser because axum's
//!   built-in Option support requires the OptionalFromRequestParts trait; doing it
//!   explicitly keeps the two behaviors (401 vs 403) visible.
//! - Handler -> Response conversions go through IntoResponse; tuples of
//!   (StatusCode, headers, body) all implement it.

use axum::extract::State;
use axum::http::StatusCode;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::MaybeAuthUser;
use crate::error;
use crate::models::User;
use crate::password::{hash_password, verify_password};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// DTOs (field names + validation messages mirror the Java records)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct AuthResponse {
    /// Explicit null on profile endpoints — Jackson parity (no skip_serializing_if).
    pub token: Option<String>,
    pub id: Uuid,
    pub email: String,
    pub displayName: String,
    pub role: String,
}

impl From<User> for AuthResponse {
    fn from(user: User) -> Self {
        Self {
            token: None,
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            role: user.role,
        }
    }
}

fn auth_response_with_token(user: &User, token: String) -> AuthResponse {
    AuthResponse {
        token: Some(token),
        ..AuthResponse::from(user.clone())
    }
}

impl From<crate::auth::AuthUser> for AuthResponse {
    fn from(u: crate::auth::AuthUser) -> Self {
        Self {
            token: None,
            id: u.id,
            email: u.email,
            displayName: u.display_name,
            role: u.role,
        }
    }
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
pub struct RegisterRequest {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub displayName: String,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
pub struct ChangePasswordRequest {
    #[serde(default)]
    pub currentPassword: String,
    #[serde(default)]
    pub newPassword: String,
}

/// Plain-text error body helper (StringHttpMessageConverter parity).
fn plain_text(status: StatusCode, body: &str) -> Response {
    (
        status,
        [(
            header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("text/plain;charset=UTF-8"),
        )],
        body.to_string(),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Validation (jakarta messages verbatim)
// ---------------------------------------------------------------------------

const MSG_EMAIL_REQUIRED: &str = "Email is required";
const MSG_EMAIL_INVALID: &str = "Invalid email format";
const MSG_PASSWORD_REQUIRED: &str = "Password is required";
const MSG_DISPLAY_NAME_REQUIRED: &str = "Display name is required";
const MSG_MUST_NOT_BE_BLANK: &str = "must not be blank";
const MSG_SIZE_MIN_6: &str = "size must be between 6 and 2147483647";

/// Approximates Hibernate's @Email: needs one '@', non-empty local/domain parts,
/// no whitespace, domain carries at least one non-'.' char. "a@b" passes (Hibernate does).
fn is_valid_email(email: &str) -> bool {
    if email.is_empty() || email.contains(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    if local.is_empty() || domain.is_empty() || email.matches('@').count() != 1 {
        return false;
    }
    // Domain labels: something other than dots/dashes must exist, and it can't end on . or -
    !domain.chars().all(|c| c == '.' || c == '-')
        && !domain.ends_with('.')
        && !domain.ends_with('-')
}

fn validate_register(request: &RegisterRequest) -> Vec<(&'static str, String)> {
    let mut errors: Vec<(&'static str, String)> = Vec::new();
    if request.email.trim().is_empty() {
        errors.push(("email", MSG_EMAIL_REQUIRED.into()));
    } else if !is_valid_email(&request.email) {
        errors.push(("email", MSG_EMAIL_INVALID.into()));
    }
    if request.password.is_empty() {
        errors.push(("password", MSG_PASSWORD_REQUIRED.into()));
    } else if request.password.chars().count() < 6 {
        errors.push(("password", MSG_SIZE_MIN_6.into()));
    }
    if request.displayName.trim().is_empty() {
        errors.push(("displayName", MSG_DISPLAY_NAME_REQUIRED.into()));
    }
    errors
}

fn validate_login(request: &LoginRequest) -> Vec<(&'static str, String)> {
    let mut errors = Vec::new();
    if request.email.trim().is_empty() {
        errors.push(("email", MSG_EMAIL_REQUIRED.into()));
    } else if !is_valid_email(&request.email) {
        errors.push(("email", MSG_EMAIL_INVALID.into()));
    }
    if request.password.is_empty() {
        errors.push(("password", MSG_PASSWORD_REQUIRED.into()));
    }
    errors
}

fn validate_change_password(request: &ChangePasswordRequest) -> Vec<(&'static str, String)> {
    let mut errors = Vec::new();
    if request.currentPassword.is_empty() {
        errors.push(("currentPassword", MSG_MUST_NOT_BE_BLANK.into()));
    }
    if request.newPassword.is_empty() {
        errors.push(("newPassword", MSG_MUST_NOT_BE_BLANK.into()));
    } else if request.newPassword.chars().count() < 6 {
        errors.push(("newPassword", MSG_SIZE_MIN_6.into()));
    }
    errors
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn find_user_by_email(pool: &sqlx::PgPool, email: &str) -> Option<User> {
    sqlx::query_as("SELECT * FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn find_user_by_id(pool: &sqlx::PgPool, id: Uuid) -> Option<User> {
    sqlx::query_as("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

/// GET /setup-required → {"setupRequired": <users table empty>}
pub async fn setup_required(State(state): State<AppState>) -> Json<serde_json::Value> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);
    Json(serde_json::json!({ "setupRequired": count == 0 }))
}

/// POST /register
pub async fn register(
    State(state): State<AppState>,
    body: Result<Json<RegisterRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = "/api/auth/register";

    let Json(request) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(instance),
    };

    let field_errors = validate_register(&request);
    if !field_errors.is_empty() {
        let owned: Vec<(&str, &str)> = field_errors.iter().map(|(f, m)| (*f, m.as_str())).collect();
        return error::validation_failed(instance, owned);
    }

    if find_user_by_email(&state.pool, &request.email)
        .await
        .is_some()
    {
        return plain_text(StatusCode::BAD_REQUEST, "Email already exists");
    }

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);

    let assigned_role;
    if count == 0 {
        assigned_role = "admin".to_string();
    } else {
        match request.role.as_deref() {
            None | Some("admin") | Some("ADMIN") | Some("Admin") => {
                return plain_text(
                    StatusCode::BAD_REQUEST,
                    "Cannot register as Admin. Admin is created on first registration.",
                );
            }
            Some(raw) => {
                let lowered = raw.to_lowercase();
                assigned_role = if lowered == "translator" || lowered == "viewer" {
                    lowered
                } else {
                    "viewer".to_string()
                };
            }
        }
    }

    let password_hash = hash_password(&request.password);
    let user: User = sqlx::query_as(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES ($1, now(), $2, $3, $4, $5) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(request.displayName.trim())
    .bind(&request.email)
    .bind(password_hash)
    .bind(assigned_role)
    .fetch_one(&state.pool)
    .await
    .expect("user insert (unique email pre-checked)");

    let token = state.jwt.generate_token(&user.email).unwrap_or_default();
    Json(auth_response_with_token(&user, token)).into_response()
}

/// POST /login
pub async fn login(
    State(state): State<AppState>,
    body: Result<Json<LoginRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = "/api/auth/login";
    let Json(request) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(instance),
    };

    let field_errors = validate_login(&request);
    if !field_errors.is_empty() {
        let owned: Vec<(&str, &str)> = field_errors.iter().map(|(f, m)| (*f, m.as_str())).collect();
        return error::validation_failed(instance, owned);
    }

    let Some(user) = find_user_by_email(&state.pool, &request.email).await else {
        return plain_text(StatusCode::UNAUTHORIZED, "Invalid credentials");
    };
    if !verify_password(&request.password, &user.password_hash) {
        return plain_text(StatusCode::UNAUTHORIZED, "Invalid credentials");
    }

    let token = state.jwt.generate_token(&user.email).unwrap_or_default();
    Json(auth_response_with_token(&user, token)).into_response()
}

/// GET /me — profile without token.
pub async fn get_profile(MaybeAuthUser(found): MaybeAuthUser) -> Response {
    match found {
        None => not_authenticated(),
        Some(user) => Json(AuthResponse::from(user)).into_response(),
    }
}

/// POST /refresh — fresh token for the same principal.
pub async fn refresh(
    State(state): State<AppState>,
    MaybeAuthUser(found): MaybeAuthUser,
) -> Response {
    let Some(found) = found else {
        return not_authenticated();
    };
    let token = state.jwt.generate_token(&found.email).unwrap_or_default();
    Json(AuthResponse {
        token: Some(token),
        ..AuthResponse::from(found)
    })
    .into_response()
}

/// PUT /me — display-name-only update; blank name means "no change" (Java parity).
pub async fn update_profile(
    State(state): State<AppState>,
    MaybeAuthUser(found): MaybeAuthUser,
    body: Result<
        Json<std::collections::HashMap<String, String>>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Response {
    let Some(found) = found else {
        return not_authenticated();
    };
    let Ok(Json(body)) = body else {
        return error::unreadable_body("/api/auth/me");
    };

    let Some(db_user) = find_user_by_id(&state.pool, found.id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut updated = db_user;
    if let Some(display_name) = body.get("displayName").filter(|n| !n.trim().is_empty()) {
        updated.display_name = display_name.trim().to_string();
        sqlx::query("UPDATE users SET display_name = $1 WHERE id = $2")
            .bind(&updated.display_name)
            .bind(updated.id)
            .execute(&state.pool)
            .await
            .expect("display_name update");
    }

    Json(AuthResponse::from(updated)).into_response()
}

/// POST /change-password
pub async fn change_password(
    State(state): State<AppState>,
    MaybeAuthUser(found): MaybeAuthUser,
    body: Result<Json<ChangePasswordRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Some(found) = found else {
        return not_authenticated();
    };
    let instance = "/api/auth/change-password";
    let Json(request) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(instance),
    };

    let field_errors = validate_change_password(&request);
    if !field_errors.is_empty() {
        let owned: Vec<(&str, &str)> = field_errors.iter().map(|(f, m)| (*f, m.as_str())).collect();
        return error::validation_failed(instance, owned);
    }

    let Some(db_user) = find_user_by_id(&state.pool, found.id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };

    if !verify_password(&request.currentPassword, &db_user.password_hash) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "message": "Current password is incorrect" })),
        )
            .into_response();
    }

    let new_hash = hash_password(&request.newPassword);
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(new_hash)
        .bind(db_user.id)
        .execute(&state.pool)
        .await
        .expect("password update");

    (
        StatusCode::OK,
        Json(serde_json::json!({ "message": "Password changed successfully" })),
    )
        .into_response()
}

/// DELETE /me — account removal.
pub async fn delete_account(
    State(state): State<AppState>,
    MaybeAuthUser(found): MaybeAuthUser,
) -> Response {
    let Some(found) = found else {
        return not_authenticated();
    };
    let Some(db_user) = find_user_by_id(&state.pool, found.id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(db_user.id)
        .execute(&state.pool)
        .await
        .expect("account delete");
    (
        StatusCode::OK,
        Json(serde_json::json!({ "message": "Account deleted successfully" })),
    )
        .into_response()
}

fn not_authenticated() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "message": "Not authenticated" })),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Router + shared extractor types used above
// ---------------------------------------------------------------------------

/// Sub-router mounted under `/api/auth`. All paths here are permitAll on the Java side;
/// principal-aware handlers decide their own 401s.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/setup-required", get(setup_required))
        .route("/register", axum::routing::post(register))
        .route("/login", axum::routing::post(login))
        .route(
            "/me",
            get(get_profile).put(update_profile).delete(delete_account),
        )
        .route("/refresh", axum::routing::post(refresh))
        .route("/change-password", axum::routing::post(change_password))
}
