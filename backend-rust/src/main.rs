//! Binary entrypoint of the Rust backend.
//!
//! All application code lives in the library (`src/lib.rs`); this file only wires
//! startup together: dotenv -> logging -> config -> Postgres pool -> router -> serve.

use std::net::SocketAddr;

use manga_backend::config::Config;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::redis_service::{PROVIDER_CONFIG_CHANNEL, RedisService};
use manga_backend::state::AppState;
use manga_backend::{db, routes};

#[tokio::main]
async fn main() {
    load_dotenv_local();
    init_logging();

    // Fail-closed startup: collect ALL configuration problems, print them, exit(1).
    let config = match Config::load() {
        Ok(config) => config,
        Err(problems) => {
            eprintln!("Refusing to start:");
            for problem in &problems {
                eprintln!("  - {problem}");
            }
            eprintln!(
                "Provide secrets via Docker secrets (*_FILE) or environment variables, or set \
                 APP_PROFILE=local and create backend-rust/.env.local for development."
            );
            std::process::exit(1);
        }
    };

    // Fail fast when Postgres is unreachable — the same contract as Spring failing to
    // boot its DataSource. No half-alive container for the healthcheck to lie about.
    let pool = match db::connect(&config.database).await {
        Ok(pool) => {
            tracing::info!(
                "connected to Postgres at {}:{}/{}",
                config.database.host,
                config.database.port,
                config.database.name
            );
            pool
        }
        Err(err) => {
            eprintln!(
                "Cannot reach Postgres at {}:{}/{}: {err}",
                config.database.host, config.database.port, config.database.name
            );
            std::process::exit(1);
        }
    };

    let port = config.port;
    let context_path = config.context_path.clone();

    // Config::load refuses to start without JWT_SECRET, so the secret is guaranteed present.
    let jwt = JwtUtils::new(
        config
            .jwt_secret
            .clone()
            .expect("Config::load guarantees JWT_SECRET is set"),
        config.jwt_expiration_ms,
    );

    // Same contract as Java's @PostConstruct init(): create the bucket if missing,
    // log failures without blocking boot.
    let storage = MinioService::new(&config.minio);
    storage.ensure_bucket().await;

    // Deliberate deviation from Java: Spring booted happily with Redis down (lazy template)
    // and degraded silently. We connect eagerly and refuse to start otherwise — compose
    // gates this service on healthy Redis anyway, and explicit failure beats quiet rot.
    let redis_host = config.redis.host.clone();
    let redis_port = config.redis.port;
    let redis = match RedisService::connect(&redis_host, redis_port).await {
        Ok(service) => {
            tracing::info!("connected to Redis at {redis_host}:{redis_port}");
            Some(std::sync::Arc::new(service))
        }
        Err(err) => {
            eprintln!("Cannot reach Redis at {redis_host}:{redis_port}: {err}");
            std::process::exit(1);
        }
    };
    spawn_provider_config_listener(redis.as_ref().map(std::sync::Arc::clone));

    let state = AppState::new(config, pool, jwt, storage, redis);
    let app = routes::build_router(state);

    // 0.0.0.0 = listen on all interfaces, same as Tomcat does inside its container.
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            tracing::info!("manga-backend (rust) listening on http://{addr}{context_path}");
            axum::serve(listener, app)
                // Graceful shutdown: finish in-flight requests when compose sends SIGTERM
                // (or you press Ctrl-C), instead of dropping them mid-flight.
                .with_graceful_shutdown(shutdown_signal())
                .await
                .expect("server error while running");
        }
        Err(err) => {
            eprintln!("Cannot bind {addr}: {err}");
            std::process::exit(1);
        }
    }
}

/// Loads `backend-rust/.env.local` if present so local development needs zero exports.
/// Production containers have no such file and read real env vars + Docker secrets instead.
fn load_dotenv_local() {
    if !std::path::Path::new(".env.local").exists() {
        return;
    }
    if let Err(err) = dotenvy::from_filename(".env.local") {
        eprintln!("Failed to parse backend-rust/.env.local: {err}");
        std::process::exit(1);
    }
}

/// Logging setup. Precedence:
///   1. RUST_LOG (the Rust ecosystem standard, e.g. RUST_LOG=debug,tower_http=info)
///   2. LOG_LEVEL (what docker-compose.yml already passes — INFO/DEBUG)
///   3. "info"
fn init_logging() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(env_or_default("LOG_LEVEL", "info")));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

fn env_or_default(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

/// Resolves once either signal arrives; axum then stops accepting new requests and lets
/// existing ones finish before the process exits.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending::<()>().await, // never resolves
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("Shutdown signal received, draining connections...");
}

/// Subscribes to `provider:config:updated`. Phase 3 will invalidate ProviderConfigCache
/// here; for now receipt is logged so the plumbing is observable end-to-end.
fn spawn_provider_config_listener(redis: Option<std::sync::Arc<RedisService>>) {
    let Some(redis) = redis else { return };
    tokio::spawn(async move {
        loop {
            match redis.subscribe(PROVIDER_CONFIG_CHANNEL).await {
                Ok(mut pubsub) => {
                    use futures_util::StreamExt;
                    while let Some(message) = pubsub.on_message().next().await {
                        let payload: String =
                            message.get_payload().unwrap_or_else(|_| "<binary>".into());
                        tracing::info!(
                            "provider config update received on '{PROVIDER_CONFIG_CHANNEL}': {payload}"
                        );
                    }
                }
                Err(err) => {
                    tracing::error!("provider-config subscribe failed, retrying in 5s: {err}");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
            tracing::warn!("provider-config subscription ended, resubscribing...");
        }
    });
}
