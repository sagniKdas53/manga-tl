//! Library root of the Rust backend.
//!
//! Splitting into lib + thin bin (`src/main.rs`) lets integration tests under
//! `tests/` import everything here — the same reason Spring apps keep logic out
//! of the application class.

pub mod config;
pub mod db;
pub mod jwt;
pub mod models;
pub mod routes;
pub mod state;
