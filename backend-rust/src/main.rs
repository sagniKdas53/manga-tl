//! Binary entrypoint of the Rust backend.
//!
//! Rust refresher for this file:
//! - `#[tokio::main]` turns the async `main` into a normal `fn main` that starts the tokio
//!   runtime and blocks on it. You never write that boilerplate yourself.
//! - `async fn` / `.await`: like CompletableFuture chains in Java, but with syntax support.
//! - `match` is a switch expression that must cover every case — no fall-through surprises.
//! - `?` can't be used here because `main` returns nothing; we handle errors explicitly and
//!   exit non-zero, which is exactly what Docker's healthcheck expects on misconfiguration.

mod config;
mod routes;
mod state;

use std::net::SocketAddr;
use tokio::net::TcpListener;

use crate::config::Config;
use crate::state::AppState;

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

    let port = config.port;
    let context_path = config.context_path.clone();

    let state = AppState::new(config);
    let app = routes::build_router(state);

    // 0.0.0.0 = listen on all interfaces, same as Tomcat does inside its container.
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    match TcpListener::bind(addr).await {
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
