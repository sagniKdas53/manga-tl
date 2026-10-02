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

/// [`advance_page_revision`] for an edit made by hand in the editor: it also stamps
/// `pages.hand_edited_at`, which keeps machine QA off the page from then on.
///
/// The mark used to be "some element of the page has `is_manually_edited`", which only an
/// element save set. Deleting an element, adding one, or showing, hiding or deleting a layer left
/// a page looking untouched, and deleting the one edited element cleared it — so the next render
/// queued a paid QA pass that could retranslate what the user had just fixed.
pub async fn advance_page_revision_by_hand(
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar(
        "UPDATE pages \
         SET last_edited_at = now(), hand_edited_at = now(), scene_revision = scene_revision + 1 \
         WHERE id = $1 \
         RETURNING scene_revision",
    )
    .bind(page_id)
    .fetch_one(&mut **tx)
    .await
}

/// Advances a page's **source/geometry generation** — the R3 fence that decides which pipeline
/// attempts are still current.
///
/// Distinct from [`advance_page_revision`] on purpose. `scene_revision` describes an artifact
/// scene: moving English text, retranslating, restyling all advance it, and none of those
/// invalidate a cleanup patch that was computed from the *source* pixels underneath. A new OCR
/// pass, a region-geometry redo or a replaced source image do invalidate it, and those advance
/// this counter instead. Jobs carry the generation they were dispatched for, so an attempt that
/// finishes after its inputs were superseded cannot claim its callback (`claim_callback*`).
///
/// Call it in the same transaction as the mutation that superseded the inputs.
pub async fn advance_page_input_generation(
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar(
        "UPDATE pages SET input_generation = input_generation + 1 WHERE id = $1 \
         RETURNING input_generation",
    )
    .bind(page_id)
    .fetch_one(&mut **tx)
    .await
}

/// Pool-based [`advance_page_input_generation`], for callers that supersede a page's inputs
/// before opening the transaction that enqueues the replacement work (the redo triggers).
pub async fn advance_page_input_generation_pool(
    pool: &sqlx::PgPool,
    page_id: Uuid,
) -> Result<i32, sqlx::Error> {
    sqlx::query_scalar(
        "UPDATE pages SET input_generation = input_generation + 1 WHERE id = $1 \
         RETURNING input_generation",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await
}
