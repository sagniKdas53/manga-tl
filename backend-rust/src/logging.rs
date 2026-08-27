//! Runtime-adjustable log levels — the port of Spring's exposed `/actuator/loggers`.
//!
//! Why this exists: `application.yml` deliberately exposed `loggers` (ADMIN-only) and
//! documented it as the reason the DEBUG demotions in the coordinator and the internal
//! job controller are safe — the detail is not gone, it is off by default, and an
//! operator turns it on live rather than editing LOG_LEVEL and restarting the container.
//! The first pass of the port dropped the whole actuator surface except `/health`, which
//! quietly took that escape hatch away.
//!
//! One deviation is unavoidable: Spring addressed Java packages
//! (`com.manga.library.service.JobCoordinatorService`), while a tracing target is a Rust
//! module path (`manga_backend::jobs::coordinator`). The mechanism matches; the names do
//! not, so the runbook command changes shape. Directives are otherwise plain
//! `EnvFilter` syntax, so `manga_backend::jobs=debug` works to set a whole subtree.
//!
//! The controller lives in a process-global rather than `AppState` because the subscriber
//! it reloads is itself process-global: there is exactly one per binary, and tests that
//! never install a subscriber simply see `None`.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use tracing_subscriber::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt;

/// The levels Spring's actuator advertises, in its order.
pub const LEVELS: [&str; 6] = ["OFF", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

type ApplyFn = Box<dyn Fn(EnvFilter) -> Result<(), String> + Send + Sync>;

struct LogControl {
    /// The directive the process booted with (RUST_LOG or LOG_LEVEL); the reset target.
    base: String,
    /// Per-target overrides set through the endpoint, layered on top of `base`.
    overrides: Mutex<BTreeMap<String, String>>,
    apply: ApplyFn,
}

static CONTROL: OnceLock<LogControl> = OnceLock::new();

/// Installs the subscriber with a reloadable filter. Call once, at startup.
///
/// `base` is the directive to boot with. Returns quietly if a subscriber is already
/// installed, which keeps tests that initialise logging themselves from panicking.
pub fn init(base: String) {
    let (layer, handle) = reload::Layer::new(EnvFilter::new(base.clone()));
    if tracing_subscriber::registry()
        .with(layer)
        .with(tracing_subscriber::fmt::layer())
        .try_init()
        .is_err()
    {
        return;
    }

    let _ = CONTROL.set(LogControl {
        base,
        overrides: Mutex::new(BTreeMap::new()),
        apply: Box::new(move |filter| handle.reload(filter).map_err(|err| err.to_string())),
    });
}

/// Whether a reloadable subscriber was installed (false in tests that never call `init`).
pub fn is_available() -> bool {
    CONTROL.get().is_some()
}

/// The boot directive, reported as ROOT's level.
pub fn root_level() -> String {
    CONTROL
        .get()
        .map(|control| control.base.to_uppercase())
        .unwrap_or_else(|| "INFO".to_string())
}

/// Every target currently carrying an explicit override, newest state first-hand.
pub fn overrides() -> BTreeMap<String, String> {
    CONTROL
        .get()
        .and_then(|control| control.overrides.lock().ok().map(|map| map.clone()))
        .unwrap_or_default()
}

/// The level configured for one target, if it carries an override.
pub fn level_for(target: &str) -> Option<String> {
    overrides().get(target).cloned()
}

/// Sets (or with `None`, clears) one target's level and reloads the live filter.
///
/// Spring's `{"configuredLevel": null}` reset maps onto removing the override and
/// rebuilding the directive from `base` — the same "put it back" semantics.
pub fn set_level(target: &str, level: Option<&str>) -> Result<(), String> {
    let Some(control) = CONTROL.get() else {
        return Err("log level control is not installed".to_string());
    };
    if target.is_empty() || target.contains([',', '=', ' ']) {
        return Err(format!("invalid logger name: {target}"));
    }

    let normalised = match level {
        Some(level) => {
            let upper = level.to_uppercase();
            if !LEVELS.contains(&upper.as_str()) {
                return Err(format!("invalid level: {level}"));
            }
            Some(upper)
        }
        None => None,
    };

    let mut guard = control
        .overrides
        .lock()
        .map_err(|_| "log level state poisoned".to_string())?;
    let previous = match &normalised {
        Some(level) => guard.insert(target.to_string(), level.clone()),
        None => guard.remove(target),
    };

    let directive = build_directive(&control.base, &guard);
    let filter = match EnvFilter::try_new(&directive) {
        Ok(filter) => filter,
        Err(err) => {
            // Leave the live filter untouched rather than half-applied.
            restore(&mut guard, target, previous);
            return Err(format!("invalid filter directive `{directive}`: {err}"));
        }
    };
    if let Err(err) = (control.apply)(filter) {
        restore(&mut guard, target, previous);
        return Err(err);
    }
    Ok(())
}

fn restore(map: &mut BTreeMap<String, String>, target: &str, previous: Option<String>) {
    match previous {
        Some(level) => {
            map.insert(target.to_string(), level);
        }
        None => {
            map.remove(target);
        }
    }
}

/// `base,target=level,...` — EnvFilter reads later directives as more specific.
fn build_directive(base: &str, overrides: &BTreeMap<String, String>) -> String {
    let mut directive = String::from(base);
    for (target, level) in overrides {
        directive.push(',');
        directive.push_str(target);
        directive.push('=');
        directive.push_str(&level.to_lowercase());
    }
    directive
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directive_layers_overrides_after_the_base() {
        let mut overrides = BTreeMap::new();
        overrides.insert("manga_backend::jobs".to_string(), "DEBUG".to_string());
        overrides.insert("tower_http".to_string(), "WARN".to_string());
        assert_eq!(
            build_directive("info", &overrides),
            "info,manga_backend::jobs=debug,tower_http=warn"
        );
    }

    #[test]
    fn directive_with_no_overrides_is_the_base() {
        assert_eq!(build_directive("info", &BTreeMap::new()), "info");
    }

    #[test]
    fn every_advertised_level_parses_as_a_filter() {
        for level in LEVELS {
            let mut overrides = BTreeMap::new();
            overrides.insert("manga_backend".to_string(), level.to_string());
            let directive = build_directive("info", &overrides);
            assert!(
                EnvFilter::try_new(&directive).is_ok(),
                "level {level} produced an unparsable directive: {directive}"
            );
        }
    }

    #[test]
    fn set_level_without_an_installed_subscriber_reports_rather_than_panics() {
        // Integration tests never call init(); the endpoint must degrade, not abort.
        if !is_available() {
            assert!(set_level("manga_backend", Some("DEBUG")).is_err());
        }
    }
}
