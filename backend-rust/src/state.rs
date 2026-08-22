//! Shared application state.
//!
//! In Spring you would @Autowire services into controllers. Axum's equivalent is *state*:
//! one value that is cloned cheaply into every request handler. `Arc` = Atomic Reference
//! Counted — a shared pointer, so the clone is just a counter bump, not a deep copy.

use std::sync::Arc;

use sqlx::PgPool;

use crate::config::Config;
use crate::jwt::JwtUtils;
use crate::minio::MinioService;

/// The single state object every handler can reach via `State<AppState>`.
/// `#[derive(Clone)]` generates `.clone()` for us; axum requires handlers' state to be Clone.
/// `Arc<..>` and `PgPool` are all internally shared, so cloning is a counter bump.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    /// Consumed by repositories/handlers as Phase 1 lands them.
    #[allow(dead_code)]
    pub pool: PgPool,
    /// Issues and verifies the same JWTs as Java `JwtUtils`.
    #[allow(dead_code)]
    pub jwt: Arc<JwtUtils>,
    /// S3-compatible object storage (port of Java MinioService).
    #[allow(dead_code)]
    pub storage: Arc<MinioService>,
}

impl AppState {
    pub fn new(config: Config, pool: PgPool, jwt: JwtUtils, storage: MinioService) -> Self {
        Self {
            config: Arc::new(config),
            pool,
            jwt: Arc::new(jwt),
            storage: Arc::new(storage),
        }
    }
}
