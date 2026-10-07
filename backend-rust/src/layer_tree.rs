//! F3 (#178): layer groups.
//!
//! A group is a row in `layers` with type `group`. It holds no elements; other layers point at it
//! with `parent_id`. Groups do not nest. A layer is *shown* only while it is visible and its
//! group, if it has one, is visible too. Hiding a group leaves its layers' own switches alone, so
//! showing the group again brings back exactly what was shown before (as in Photoshop).

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub const GROUP_TYPE: &str = "group";

/// SQL for "this layer is shown", for a `layers` row under the alias given. A `&'static str`, so
/// it composes into sqlx queries with `concat!`.
#[macro_export]
macro_rules! layer_shown {
    ($alias:literal) => {
        concat!(
            "(",
            $alias,
            ".visible = TRUE AND (",
            $alias,
            ".parent_id IS NULL OR EXISTS (SELECT 1 FROM layers layer_group WHERE layer_group.id = ",
            $alias,
            ".parent_id AND layer_group.visible = TRUE)))"
        )
    };
}

/// The kinds of layer whose elements can be merged together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeKind {
    /// Translation and SFX layers: text elements.
    Text,
    /// Inpainting layers: cleanup patches.
    Patches,
}

impl MergeKind {
    pub fn of(layer_type: &str) -> Option<Self> {
        match layer_type.to_ascii_lowercase().as_str() {
            "translation" | "sfx" => Some(Self::Text),
            "inpainting" => Some(Self::Patches),
            _ => None,
        }
    }
}

/// Whether the layer is shown now: its own switch and its group's.
pub async fn is_shown(
    tx: &mut Transaction<'_, Postgres>,
    layer_id: Uuid,
) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar(concat!(
        "SELECT ",
        layer_shown!("l"),
        " FROM layers l WHERE l.id = $1"
    ))
    .bind(layer_id)
    .fetch_optional(&mut **tx)
    .await?
    .unwrap_or(false))
}

/// Re-applies redo overlays after a change to what is shown: the layer itself, or, for a group,
/// every layer in it. An overlay hides the text it superseded only while it is shown, so hiding a
/// group that holds one must give that text back, and showing the group must hide it again.
pub async fn sync_overlays(
    tx: &mut Transaction<'_, Postgres>,
    layer_id: Uuid,
) -> Result<(), sqlx::Error> {
    let members: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM layers WHERE id = $1 OR parent_id = $1 ORDER BY z_order",
    )
    .bind(layer_id)
    .fetch_all(&mut **tx)
    .await?;
    for member in members {
        let shown = is_shown(tx, member).await?;
        crate::jobs::coordinator::sync_superseded_elements(tx, member, shown).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_like_layers_merge() {
        assert_eq!(MergeKind::of("Translation"), Some(MergeKind::Text));
        assert_eq!(MergeKind::of("sfx"), Some(MergeKind::Text));
        assert_eq!(MergeKind::of("inpainting"), Some(MergeKind::Patches));
        assert_eq!(MergeKind::of("ocr"), None);
        assert_eq!(MergeKind::of(GROUP_TYPE), None);
    }

    #[test]
    fn the_shown_condition_checks_the_layer_and_its_group() {
        let sql = layer_shown!("l");
        assert!(sql.starts_with("(l.visible = TRUE AND (l.parent_id IS NULL"));
        assert!(sql.contains("layer_group.id = l.parent_id AND layer_group.visible = TRUE"));
    }
}
