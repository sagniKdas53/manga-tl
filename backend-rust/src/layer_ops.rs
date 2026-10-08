//! F4 (#178): undo and redo of layer actions that survive a save and a reload.
//!
//! Every layer action (add, delete, rename, reorder, group, ungroup, move to a group, merge, delete
//! hidden texts) runs in one transaction with a [`Recorder`]: it snapshots the page's `layers` and
//! `layer_elements` rows before the action and after it, and stores only the rows that changed,
//! as `{table, id, before, after}` (`null` for a row that did not exist). So whatever an action
//! touches on the side (overlays giving back the text they superseded, patches renumbered, lower
//! texts hidden by a merge, a deleted group's layers let out) is undone with it, with no
//! per-action code.
//!
//! The history is one line per page, newest first, at most [`DEPTH`] actions (owner, D3,
//! 2026-10-07). A new action drops whatever was undone after the last one (no branches). Undo
//! writes the "before" rows back and redo the "after" rows, in place: an existing row is updated,
//! never deleted and re-inserted, so its element history stays.
//!
//! An action can be undone only while the rows it touched are still as it left them. Anything
//! since (an edit to its text, a re-run, QA, showing or hiding one of its layers) makes it no
//! longer undoable, and [`blocked`] says why. Two columns are left out of that check because the
//! pipeline rewrites them without anyone editing: `layer_elements.size` (the render callback fits
//! auto-sized text) and `metadata_json.last_modified` on a layer (every element save bumps it).
//!
//! Recorded handlers and undo/redo take a per-page advisory lock first, so two actions on one
//! page never interleave their snapshots. A row is counted as changed only if this transaction
//! wrote it (`xmin`), so an element autosave that commits mid-action is not swept into the action.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Postgres, Transaction};
use uuid::Uuid;

/// How many layer actions a page keeps (owner, D3, 2026-10-07).
pub const DEPTH: i64 = 20;

/// The two tables a layer action changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Table {
    Layers,
    Elements,
}

impl Table {
    fn name(self) -> &'static str {
        match self {
            Table::Layers => "layers",
            Table::Elements => "layer_elements",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        match name {
            "layers" => Some(Table::Layers),
            "layer_elements" => Some(Table::Elements),
            _ => None,
        }
    }
}

/// One changed row: what it was before the action and after it (None: absent).
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub table: Table,
    pub id: Uuid,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

impl Change {
    fn to_json(&self) -> Value {
        json!({
            "table": self.table.name(),
            "id": self.id,
            "before": self.before,
            "after": self.after,
        })
    }

    fn from_json(value: &Value) -> Option<Self> {
        let row = |key: &str| match value.get(key) {
            None | Some(Value::Null) => None,
            Some(row) => Some(row.clone()),
        };
        Some(Change {
            table: Table::parse(value.get("table")?.as_str()?)?,
            id: Uuid::parse_str(value.get("id")?.as_str()?).ok()?,
            before: row("before"),
            after: row("after"),
        })
    }
}

/// Serialises layer actions on one page (recording, undo, redo). Released at commit or rollback.
pub async fn lock_page(
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('layer_ops:' || $1::text, 0))")
        .bind(page_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// The page's rows as `to_jsonb` objects, by table and id, each with whether this transaction
/// wrote it.
type Snapshot = HashMap<(Table, Uuid), (Value, bool)>;

async fn snapshot(
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
) -> Result<Snapshot, sqlx::Error> {
    // txid_current() is this transaction's id with its epoch; xmin is the 32-bit part.
    let layers: Vec<(Uuid, Value, bool)> = sqlx::query_as(
        "SELECT l.id, to_jsonb(l), l.xmin::text::bigint = txid_current() % 4294967296 \
         FROM layers l WHERE l.page_id = $1",
    )
    .bind(page_id)
    .fetch_all(&mut **tx)
    .await?;
    let elements: Vec<(Uuid, Value, bool)> = sqlx::query_as(
        "SELECT e.id, to_jsonb(e), e.xmin::text::bigint = txid_current() % 4294967296 \
         FROM layer_elements e JOIN layers l ON l.id = e.layer_id WHERE l.page_id = $1",
    )
    .bind(page_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut rows = Snapshot::new();
    for (id, row, ours) in layers {
        rows.insert((Table::Layers, id), (row, ours));
    }
    for (id, row, ours) in elements {
        rows.insert((Table::Elements, id), (row, ours));
    }
    Ok(rows)
}

/// The rows this transaction changed between two snapshots. A row another transaction wrote in
/// between is not this action's change and is left out.
fn diff(before: &Snapshot, after: &Snapshot) -> Vec<Change> {
    let mut changes = Vec::new();
    for (key, (row, ours)) in after {
        let old = before.get(key).map(|(row, _)| row);
        if !ours || old == Some(row) {
            continue;
        }
        changes.push(Change {
            table: key.0,
            id: key.1,
            before: old.cloned(),
            after: Some(row.clone()),
        });
    }
    for (key, (row, _)) in before {
        if !after.contains_key(key) {
            changes.push(Change {
                table: key.0,
                id: key.1,
                before: Some(row.clone()),
                after: None,
            });
        }
    }
    changes.sort_by_key(|change| (change.table == Table::Elements, change.id));
    changes
}

/// Two recordings of one action (a reorder sent as several requests): the first one's "before",
/// the last one's "after". Rows that end where they started are dropped.
fn combine(first: Vec<Change>, then: Vec<Change>) -> Vec<Change> {
    let mut merged: Vec<Change> = first;
    for change in then {
        match merged
            .iter_mut()
            .find(|seen| seen.table == change.table && seen.id == change.id)
        {
            Some(seen) => seen.after = change.after,
            None => merged.push(change),
        }
    }
    merged.retain(|change| change.before != change.after);
    merged
}

/// Records one layer action. Start it before the action changes anything, in the same
/// transaction, and finish it after.
pub struct Recorder {
    page_id: Uuid,
    before: Snapshot,
}

impl Recorder {
    /// Locks the page's layer history and takes the "before" snapshot.
    pub async fn start(
        tx: &mut Transaction<'_, Postgres>,
        page_id: Uuid,
    ) -> Result<Self, sqlx::Error> {
        lock_page(tx, page_id).await?;
        let before = snapshot(tx, page_id).await?;
        Ok(Recorder { page_id, before })
    }

    /// Stores the action, unless it changed nothing. `batch` joins it to the newest action when
    /// that one carries the same batch (the requests of one reorder).
    pub async fn finish(
        self,
        tx: &mut Transaction<'_, Postgres>,
        kind: &str,
        label: &str,
        user: &str,
        batch: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let after = snapshot(tx, self.page_id).await?;
        let changes = diff(&self.before, &after);
        if changes.is_empty() {
            return Ok(());
        }
        // No branches: an action after an undo drops what was undone.
        sqlx::query("DELETE FROM layer_ops WHERE page_id = $1 AND undone")
            .bind(self.page_id)
            .execute(&mut **tx)
            .await?;
        if let Some(batch) = batch {
            let newest: Option<(Uuid, Option<String>, Value)> = sqlx::query_as(
                "SELECT id, batch, changes FROM layer_ops WHERE page_id = $1 \
                 ORDER BY seq DESC LIMIT 1",
            )
            .bind(self.page_id)
            .fetch_optional(&mut **tx)
            .await?;
            if let Some((id, Some(seen), stored)) = newest
                && seen == batch
            {
                let merged = combine(parse_changes(&stored), changes);
                sqlx::query("UPDATE layer_ops SET changes = $2, created_at = now() WHERE id = $1")
                    .bind(id)
                    .bind(changes_json(&merged))
                    .execute(&mut **tx)
                    .await?;
                return Ok(());
            }
        }
        sqlx::query(
            "INSERT INTO layer_ops (id, page_id, kind, label, batch, created_by, changes) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(Uuid::new_v4())
        .bind(self.page_id)
        .bind(kind)
        .bind(label)
        .bind(batch)
        .bind(user)
        .bind(changes_json(&changes))
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "DELETE FROM layer_ops WHERE page_id = $1 AND seq <= ( \
               SELECT seq FROM layer_ops WHERE page_id = $1 ORDER BY seq DESC OFFSET $2 LIMIT 1)",
        )
        .bind(self.page_id)
        .bind(DEPTH)
        .execute(&mut **tx)
        .await?;
        Ok(())
    }
}

fn changes_json(changes: &[Change]) -> Value {
    Value::Array(changes.iter().map(Change::to_json).collect())
}

fn parse_changes(stored: &Value) -> Vec<Change> {
    stored
        .as_array()
        .map(|rows| rows.iter().filter_map(Change::from_json).collect())
        .unwrap_or_default()
}

/// Which way to apply an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Undo,
    Redo,
}

impl Direction {
    /// The state the rows must be in now, and the one they are put in.
    fn sides(self, change: &Change) -> (&Option<Value>, &Option<Value>) {
        match self {
            Direction::Undo => (&change.after, &change.before),
            Direction::Redo => (&change.before, &change.after),
        }
    }
}

/// Carries what the pipeline rewrote since (see the module docs) from the live row into the one
/// being written back, so an undo or redo restores the action's change and not a stale fit or
/// timestamp. [`blocked`] ignores these two for the same reason.
fn keep_pipeline_fields(table: Table, row: &mut Value, now: &Value) {
    let Some(map) = row.as_object_mut() else {
        return;
    };
    match table {
        Table::Elements => {
            map.insert(
                "size".into(),
                now.get("size").cloned().unwrap_or(Value::Null),
            );
        }
        Table::Layers => {
            let live = now
                .get("metadata_json")
                .and_then(|meta| meta.get("last_modified"))
                .cloned();
            if let Some(Value::Object(meta)) = map.get_mut("metadata_json") {
                match live {
                    Some(value) => {
                        meta.insert("last_modified".into(), value);
                    }
                    None => {
                        meta.remove("last_modified");
                    }
                }
            }
        }
    }
}

/// A row without what the pipeline rewrites on its own (see the module docs).
fn comparable(table: Table, row: &Value) -> Value {
    let mut row = row.clone();
    if let Some(map) = row.as_object_mut() {
        match table {
            Table::Elements => {
                map.remove("size");
            }
            Table::Layers => {
                if let Some(Value::Object(meta)) = map.get_mut("metadata_json") {
                    meta.remove("last_modified");
                }
            }
        }
    }
    row
}

fn layer_label(row: &Value) -> String {
    row.get("metadata_json")
        .and_then(|meta| meta.get("layer_name"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let kind = row.get("type").and_then(Value::as_str).unwrap_or("layer");
            format!("the {} layer", kind.to_ascii_lowercase())
        })
}

async fn current_rows(
    tx: &mut Transaction<'_, Postgres>,
    table: Table,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, Value>, sqlx::Error> {
    let rows: Vec<(Uuid, Value)> = match table {
        Table::Layers => {
            sqlx::query_as("SELECT id, to_jsonb(t) FROM layers t WHERE id = ANY($1)")
                .bind(ids)
                .fetch_all(&mut **tx)
                .await?
        }
        Table::Elements => {
            sqlx::query_as("SELECT id, to_jsonb(t) FROM layer_elements t WHERE id = ANY($1)")
                .bind(ids)
                .fetch_all(&mut **tx)
                .await?
        }
    };
    Ok(rows.into_iter().collect())
}

/// Locks the rows an undo or redo is about to check and write. An element save or a show/hide
/// takes no history lock: with the rows locked before [`blocked`] reads them, one that committed
/// first is seen there, and one that comes later waits for the undo and lands on top of it instead
/// of being written over. Elements first, in the order an element save locks them.
pub async fn lock_rows(
    tx: &mut Transaction<'_, Postgres>,
    changes: &[Change],
) -> Result<(), sqlx::Error> {
    let ids = |table: Table| -> Vec<Uuid> {
        changes
            .iter()
            .filter(|change| change.table == table)
            .map(|change| change.id)
            .collect()
    };
    sqlx::query("SELECT 1 FROM layer_elements WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(ids(Table::Elements))
        .execute(&mut **tx)
        .await?;
    sqlx::query("SELECT 1 FROM layers WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(ids(Table::Layers))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Why the action cannot be applied in `direction` now, or None when it can.
pub async fn blocked(
    tx: &mut Transaction<'_, Postgres>,
    changes: &[Change],
    direction: Direction,
) -> Result<Option<String>, sqlx::Error> {
    let ids = |table: Table| -> Vec<Uuid> {
        changes
            .iter()
            .filter(|change| change.table == table)
            .map(|change| change.id)
            .collect()
    };
    let layer_ids = ids(Table::Layers);
    let element_ids = ids(Table::Elements);
    let layers_now = current_rows(tx, Table::Layers, &layer_ids).await?;
    let elements_now = current_rows(tx, Table::Elements, &element_ids).await?;
    // A layer's name, from whichever version of it is at hand.
    let name_of = |id: Uuid| -> String {
        layers_now
            .get(&id)
            .or_else(|| {
                changes
                    .iter()
                    .find(|change| change.table == Table::Layers && change.id == id)
                    .and_then(|change| change.before.as_ref().or(change.after.as_ref()))
            })
            .map(layer_label)
            .unwrap_or_else(|| "a layer".to_string())
    };
    let element_layer = |row: &Value| -> Option<Uuid> {
        row.get("layer_id")
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
    };

    for change in changes {
        let (expected, _) = direction.sides(change);
        let now = match change.table {
            Table::Layers => layers_now.get(&change.id),
            Table::Elements => elements_now.get(&change.id),
        };
        let reason = match (expected, now) {
            (Some(expected), Some(now))
                if comparable(change.table, expected) != comparable(change.table, now) =>
            {
                Some(match change.table {
                    Table::Layers => {
                        let mut a = comparable(change.table, expected);
                        let mut b = comparable(change.table, now);
                        if let (Some(a), Some(b)) = (a.as_object_mut(), b.as_object_mut()) {
                            a.remove("visible");
                            b.remove("visible");
                        }
                        if a == b {
                            format!(
                                "{} was shown or hidden since; switch it back to undo this",
                                name_of(change.id)
                            )
                        } else {
                            format!("{} changed since", name_of(change.id))
                        }
                    }
                    Table::Elements => {
                        let layer = element_layer(now).map(name_of);
                        format!(
                            "an element on {} was edited since",
                            layer.unwrap_or_else(|| "a layer".to_string())
                        )
                    }
                })
            }
            (Some(_), None) => Some(match change.table {
                Table::Layers => format!("{} was deleted since", name_of(change.id)),
                Table::Elements => "an element it touched was deleted since".to_string(),
            }),
            (None, Some(now)) => Some(match change.table {
                Table::Layers => format!("{} is back since", layer_label(now)),
                Table::Elements => "an element it removed is back since".to_string(),
            }),
            _ => None,
        };
        if reason.is_some() {
            return Ok(reason);
        }
    }

    // Layers this would delete must hold nothing the action did not put there.
    let (target_of, deleted_layers): (HashSet<Uuid>, Vec<Uuid>) = {
        let deleted: Vec<Uuid> = changes
            .iter()
            .filter(|change| change.table == Table::Layers && direction.sides(change).1.is_none())
            .map(|change| change.id)
            .collect();
        (element_ids.iter().copied().collect(), deleted)
    };
    if !deleted_layers.is_empty() {
        let extra_elements: Option<Uuid> = sqlx::query_scalar(
            "SELECT layer_id FROM layer_elements WHERE layer_id = ANY($1) AND NOT (id = ANY($2)) \
             LIMIT 1",
        )
        .bind(&deleted_layers)
        .bind(target_of.iter().copied().collect::<Vec<_>>())
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(layer) = extra_elements {
            return Ok(Some(format!("{} has content added since", name_of(layer))));
        }
        let extra_members: Option<Uuid> = sqlx::query_scalar(
            "SELECT parent_id FROM layers WHERE parent_id = ANY($1) AND NOT (id = ANY($2)) LIMIT 1",
        )
        .bind(&deleted_layers)
        .bind(&layer_ids)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(group) = extra_members {
            return Ok(Some(format!(
                "{} has layers moved into it since",
                name_of(group)
            )));
        }
    }
    Ok(None)
}

/// The table's columns, other than `id`, from the catalogue (never from a request).
async fn columns(
    tx: &mut Transaction<'_, Postgres>,
    table: Table,
) -> Result<Vec<String>, sqlx::Error> {
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name::text FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = $1 AND column_name <> 'id' \
         ORDER BY ordinal_position",
    )
    .bind(table.name())
    .fetch_all(&mut **tx)
    .await?;
    let safe = |name: &String| {
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    };
    if !columns.iter().all(safe) {
        return Err(sqlx::Error::Protocol(format!(
            "unexpected column name in {}",
            table.name()
        )));
    }
    Ok(columns)
}

async fn update_row(
    tx: &mut Transaction<'_, Postgres>,
    table: Table,
    columns: &[String],
    id: Uuid,
    row: &Value,
) -> Result<(), sqlx::Error> {
    let list = columns
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let name = table.name();
    let sql = format!(
        "UPDATE public.{name} t SET ({list}) = \
           (SELECT {list} FROM jsonb_populate_record(NULL::public.{name}, $1)) WHERE t.id = $2"
    );
    // AssertSqlSafe audit (sqlx 0.9): `name` is one of two literals, and `list` holds the table's
    // own column names from information_schema, checked to be [a-z0-9_] and quoted.
    sqlx::query(AssertSqlSafe(sql))
        .bind(row)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn insert_row(
    tx: &mut Transaction<'_, Postgres>,
    table: Table,
    row: &Value,
) -> Result<(), sqlx::Error> {
    match table {
        Table::Layers => {
            sqlx::query("INSERT INTO layers SELECT * FROM jsonb_populate_record(NULL::layers, $1)")
                .bind(row)
                .execute(&mut **tx)
                .await?
        }
        Table::Elements => {
            sqlx::query(
                "INSERT INTO layer_elements \
                 SELECT * FROM jsonb_populate_record(NULL::layer_elements, $1)",
            )
            .bind(row)
            .execute(&mut **tx)
            .await?
        }
    };
    Ok(())
}

/// Puts every changed row in its `direction` state. Call [`blocked`] first.
///
/// The order keeps the foreign keys and the cascades happy: new layers first (outside any group,
/// which may not exist yet), then the elements, then every layer's full row (its group included),
/// then the deletions: elements, then the layers, which hold nothing else by then.
pub async fn apply(
    tx: &mut Transaction<'_, Postgres>,
    changes: &[Change],
    direction: Direction,
) -> Result<(), sqlx::Error> {
    let target = |change: &Change| direction.sides(change).1.clone();
    let existing_layers = current_rows(
        tx,
        Table::Layers,
        &changes
            .iter()
            .filter(|change| change.table == Table::Layers)
            .map(|change| change.id)
            .collect::<Vec<_>>(),
    )
    .await?;
    let existing_elements = current_rows(
        tx,
        Table::Elements,
        &changes
            .iter()
            .filter(|change| change.table == Table::Elements)
            .map(|change| change.id)
            .collect::<Vec<_>>(),
    )
    .await?;
    let layer_columns = columns(tx, Table::Layers).await?;
    let element_columns = columns(tx, Table::Elements).await?;

    for change in changes.iter().filter(|c| c.table == Table::Layers) {
        if let Some(mut row) = target(change)
            && !existing_layers.contains_key(&change.id)
        {
            if let Some(map) = row.as_object_mut() {
                map.insert("parent_id".into(), Value::Null);
            }
            insert_row(tx, Table::Layers, &row).await?;
        }
    }
    for change in changes.iter().filter(|c| c.table == Table::Elements) {
        if let Some(mut row) = target(change) {
            if let Some(now) = existing_elements.get(&change.id) {
                keep_pipeline_fields(Table::Elements, &mut row, now);
                update_row(tx, Table::Elements, &element_columns, change.id, &row).await?;
            } else {
                insert_row(tx, Table::Elements, &row).await?;
            }
        }
    }
    for change in changes.iter().filter(|c| c.table == Table::Layers) {
        if let Some(mut row) = target(change) {
            if let Some(now) = existing_layers.get(&change.id) {
                keep_pipeline_fields(Table::Layers, &mut row, now);
            }
            update_row(tx, Table::Layers, &layer_columns, change.id, &row).await?;
        }
    }
    let gone = |table: Table| -> Vec<Uuid> {
        changes
            .iter()
            .filter(|change| change.table == table && target(change).is_none())
            .map(|change| change.id)
            .collect()
    };
    sqlx::query("DELETE FROM layer_elements WHERE id = ANY($1)")
        .bind(gone(Table::Elements))
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM layers WHERE id = ANY($1)")
        .bind(gone(Table::Layers))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// One stored action, as the editor shows it.
#[derive(Debug, Clone)]
pub struct Op {
    pub id: Uuid,
    pub kind: String,
    pub label: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub changes: Vec<Change>,
}

/// The action Undo would undo (the newest one not undone), or Redo would redo (the oldest undone).
pub async fn next_op(
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
    direction: Direction,
) -> Result<Option<Op>, sqlx::Error> {
    let row: Option<(Uuid, String, String, chrono::DateTime<chrono::Utc>, Value)> = match direction
    {
        Direction::Undo => {
            sqlx::query_as(
                "SELECT id, kind, label, created_at, changes FROM layer_ops \
                 WHERE page_id = $1 AND NOT undone ORDER BY seq DESC LIMIT 1",
            )
            .bind(page_id)
            .fetch_optional(&mut **tx)
            .await?
        }
        Direction::Redo => {
            sqlx::query_as(
                "SELECT id, kind, label, created_at, changes FROM layer_ops \
                 WHERE page_id = $1 AND undone ORDER BY seq ASC LIMIT 1",
            )
            .bind(page_id)
            .fetch_optional(&mut **tx)
            .await?
        }
    };
    Ok(row.map(|(id, kind, label, created_at, changes)| Op {
        id,
        kind,
        label,
        created_at,
        changes: parse_changes(&changes),
    }))
}

/// Marks the action undone (after Undo) or not (after Redo).
pub async fn mark(
    tx: &mut Transaction<'_, Postgres>,
    op: Uuid,
    direction: Direction,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE layer_ops SET undone = $2 WHERE id = $1")
        .bind(op)
        .bind(direction == Direction::Undo)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// What the editor's Undo and Redo buttons show: the next action each way, and why it cannot be
/// applied, if it cannot.
pub async fn status(
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
) -> Result<Value, sqlx::Error> {
    let mut sides = serde_json::Map::new();
    for (key, direction) in [("undo", Direction::Undo), ("redo", Direction::Redo)] {
        let entry = match next_op(tx, page_id, direction).await? {
            None => Value::Null,
            Some(op) => {
                let reason = blocked(tx, &op.changes, direction).await?;
                json!({
                    "id": op.id,
                    "kind": op.kind,
                    "label": op.label,
                    "createdAt": op.created_at,
                    "blocked": reason,
                })
            }
        };
        sides.insert(key.into(), entry);
    }
    let (done, undone): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*) FILTER (WHERE NOT undone), COUNT(*) FILTER (WHERE undone) \
         FROM layer_ops WHERE page_id = $1",
    )
    .bind(page_id)
    .fetch_one(&mut **tx)
    .await?;
    sides.insert("undoCount".into(), json!(done));
    sides.insert("redoCount".into(), json!(undone));
    sides.insert("depth".into(), json!(DEPTH));
    Ok(Value::Object(sides))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(table: Table, n: u128) -> (Table, Uuid) {
        (table, Uuid::from_u128(n))
    }

    #[test]
    fn a_diff_keeps_only_what_this_transaction_changed() {
        let mut before = Snapshot::new();
        before.insert(key(Table::Layers, 1), (json!({"z": 1}), false));
        before.insert(key(Table::Layers, 2), (json!({"z": 2}), false));
        before.insert(key(Table::Elements, 3), (json!({"t": "a"}), false));
        before.insert(key(Table::Elements, 4), (json!({"t": "b"}), false));
        let mut after = Snapshot::new();
        // Ours, changed.
        after.insert(key(Table::Layers, 1), (json!({"z": 5}), true));
        // Ours, rewritten with the same values.
        after.insert(key(Table::Layers, 2), (json!({"z": 2}), true));
        // Someone else's autosave, committed mid-action.
        after.insert(key(Table::Elements, 3), (json!({"t": "edited"}), false));
        // Element 4 deleted; element 5 added.
        after.insert(key(Table::Elements, 5), (json!({"t": "new"}), true));
        let changes = diff(&before, &after);
        let summary: Vec<(Table, u128, bool, bool)> = changes
            .iter()
            .map(|c| {
                (
                    c.table,
                    c.id.as_u128(),
                    c.before.is_some(),
                    c.after.is_some(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (Table::Layers, 1, true, true),
                (Table::Elements, 4, true, false),
                (Table::Elements, 5, false, true),
            ]
        );
    }

    #[test]
    fn two_requests_of_one_reorder_make_one_action() {
        let change = |id: u128, before: i64, after: i64| Change {
            table: Table::Layers,
            id: Uuid::from_u128(id),
            before: Some(json!({ "z": before })),
            after: Some(json!({ "z": after })),
        };
        let merged = combine(
            vec![change(1, 1, 2)],
            vec![change(2, 2, 1), change(1, 2, 2)],
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].before, Some(json!({"z": 1})));
        assert_eq!(merged[0].after, Some(json!({"z": 2})));
        // A row that ends where it started is no change.
        let back = combine(vec![change(1, 1, 2)], vec![change(1, 2, 1)]);
        assert!(back.is_empty());
    }

    #[test]
    fn the_pipelines_own_rewrites_do_not_count_as_edits() {
        let layer = |modified: &str| json!({"visible": true, "metadata_json": {"layer_name": "TL", "last_modified": modified}});
        assert_eq!(
            comparable(Table::Layers, &layer("a")),
            comparable(Table::Layers, &layer("b"))
        );
        assert_eq!(
            comparable(Table::Elements, &json!({"text": "x", "size": 12.0})),
            comparable(Table::Elements, &json!({"text": "x", "size": 14.5}))
        );
        assert_ne!(
            comparable(Table::Elements, &json!({"text": "x"})),
            comparable(Table::Elements, &json!({"text": "y"}))
        );
    }

    #[test]
    fn changes_survive_storage() {
        let change = Change {
            table: Table::Elements,
            id: Uuid::from_u128(7),
            before: None,
            after: Some(json!({"text": "hi"})),
        };
        assert_eq!(Change::from_json(&change.to_json()), Some(change));
    }
}
