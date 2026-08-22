//! Shared application state.
//!
//! In Spring you would @Autowire services into controllers. Axum's equivalent is *state*:
//! one value that is cloned cheaply into every request handler. `Arc` = Atomic Reference
//! Counted — a shared pointer, so the clone is just a counter bump, not a deep copy.

use std::sync::Arc;

use crate::config::Config;

/// The single state object every handler can reach via `State<AppState>`.
/// `#[derive(Clone)]` generates `.clone()` for us; axum requires handlers' state to be Clone.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Arc::new(config),
        }
    }
}
