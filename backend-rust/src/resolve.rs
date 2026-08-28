//! Model-override resolution — the pure core of JobCoordinatorService's inheritance chain.
//!
//! Java contract (SeriesController.toChapterDto + enqueueJobDirectly, AUDIT-P1):
//!   * isOverride: non-null, trimmed non-empty, != "inherit", != "default",
//!     and not containing "[ORPHANED]"
//!   * resolveModel(chapter, series, global): first level with an override wins;
//!     NO coupling between provider choice and model choice — every field falls
//!     back independently
//!   * resolveWithCheck would validate against ProviderConfigCache; with an empty cache it
//!     is permissive (returns the resolved value), which is exactly what we do until the
//!     provider catalog lands in Phase 3.
//!   * source attribution ("chapter"/"series"/"global") uses the same override test across
//!     ALL of a slot's fields at that level.

/// Java JobCoordinatorService.isOverride.
pub fn is_override(value: Option<&str>) -> bool {
    let Some(trimmed) = value.map(str::trim) else {
        return false;
    };
    !trimmed.is_empty()
        && trimmed != "inherit"
        && trimmed != "default"
        && !trimmed.contains("[ORPHANED]")
}

/// chapter-level override, else series-level, else the global default (never null).
pub fn resolve_model(chapter: Option<&str>, series: Option<&str>, global: &str) -> String {
    if is_override(chapter) {
        return chapter.unwrap().trim().to_string();
    }
    if is_override(series) {
        return series.unwrap().trim().to_string();
    }
    global.to_string()
}

/// resolveModelWithCheck: when the resolution left the global default, the provider
/// catalog gets a veto — an override naming a model the provider no longer serves
/// falls back to the global default (with a warning). An EMPTY cache is permissive.
pub fn resolve_model_with_check(
    state: &crate::state::AppState,
    chapter: Option<&str>,
    series: Option<&str>,
    global: &str,
    provider: &str,
    task: &str,
) -> String {
    let resolved = resolve_model(chapter, series, global);
    let overrode = resolved != global;
    if overrode
        && !provider.is_empty()
        && !state
            .providers
            .is_valid_provider_model(provider, &resolved, task)
    {
        tracing::warn!(
            "Resolved model '{resolved}' for task '{task}' under provider '{provider}' is no longer valid or available — falling back to global default '{global}'"
        );
        return global.to_string();
    }
    resolved
}

/// hasOverride(...) over any number of fields at one inheritance level.
pub fn any_override<'a>(values: impl IntoIterator<Item = &'a Option<String>>) -> bool {
    values.into_iter().any(|v| is_override(v.as_deref()))
}

/// The `source` label for a resolved slot given its chapter/series field groups.
pub fn source_of<'a>(
    chapter_fields: impl IntoIterator<Item = &'a Option<String>>,
    series_fields: impl IntoIterator<Item = &'a Option<String>>,
) -> &'static str {
    if any_override(chapter_fields) {
        "chapter"
    } else if any_override(series_fields) {
        "series"
    } else {
        "global"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_rules_match_java() {
        assert!(!is_override(None));
        assert!(!is_override(Some("")));
        assert!(!is_override(Some("  ")));
        assert!(!is_override(Some("inherit")));
        assert!(!is_override(Some("default")));
        assert!(!is_override(Some("x [ORPHANED] y")));
        // AUDIT-Q3: trimming happens before comparison, so " inherit " IS an override-noop.
        assert!(!is_override(Some(" inherit ")));
        assert!(is_override(Some("gpt-4o")));
    }

    #[test]
    fn resolution_order_chapter_series_global() {
        assert_eq!(
            resolve_model(Some("c-model"), Some("s-model"), "g-model"),
            "c-model"
        );
        assert_eq!(
            resolve_model(Some("inherit"), Some("s-model"), "g-model"),
            "s-model"
        );
        assert_eq!(resolve_model(None, None, "g-model"), "g-model");
    }

    #[test]
    fn source_labels() {
        let ch = Some("m".to_string());
        assert_eq!(source_of([&ch], [&None]), "chapter");
        assert_eq!(source_of([&None], [&ch]), "series");
        assert_eq!(source_of([&None], [&None]), "global");
    }
}
