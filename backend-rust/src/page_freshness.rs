//! Transactional page-output freshness state.
//!
//! Every caller keeps its page mutation and freshness change in one PostgreSQL transaction;
//! committing an artifact-affecting mutation without its new revision would make a stale render
//! look current.

use sqlx::{Postgres, Transaction};
use uuid::Uuid;

/// Advances one page after its output-affecting mutation has succeeded in the caller's transaction.
///
/// The returned revision is the exact value the caller must bind into any subsequent immutable
/// scene/job record. A rollback reverts both this update and the caller's mutation.
pub async fn advance_page_revision(
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar(
        "UPDATE pages \
         SET last_edited_at = now(), scene_revision = scene_revision + 1 \
         WHERE id = $1 \
         RETURNING scene_revision",
    )
    .bind(page_id)
    .fetch_one(&mut **tx)
    .await
}
