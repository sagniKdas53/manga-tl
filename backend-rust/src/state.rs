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
use crate::providers::ProviderConfigCache;
use crate::redis_service::RedisService;
use crate::sse::SseService;

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
    /// Redis queues/pub-sub. `None` only in tests; production connects fail-fast at boot.
    #[allow(dead_code)]
    pub redis: Option<Arc<RedisService>>,
    /// Server-Sent Events: emitters, tickets, pending-notification replay
    /// (port of Java SseService + SseTicketService). Built here from pool + redis
    /// so call sites don't have to assemble it themselves.
    #[allow(dead_code)]
    pub sse: Arc<SseService>,
    /// Worker-published provider/model catalog cache (Java ProviderConfigCache).
    #[allow(dead_code)]
    pub providers: Arc<ProviderConfigCache>,
}

impl AppState {
    pub fn new(
        config: Config,
        pool: PgPool,
        jwt: JwtUtils,
        storage: MinioService,
        redis: Option<Arc<RedisService>>,
    ) -> Self {
        let sse = Arc::new(SseService::new(pool.clone(), redis.clone()));
        Self {
            config: Arc::new(config),
            pool,
            jwt: Arc::new(jwt),
            storage: Arc::new(storage),
            sse,
            providers: Arc::new(ProviderConfigCache::new()),
            redis,
        }
    }
}
