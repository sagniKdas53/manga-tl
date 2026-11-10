//! #182: where two texts' drawn lines collide after a pipeline render, the smaller one gives way.
//!
//! The owner's rules (2026-11-08):
//! - A hand-edited box keeps its shape: a person already chose it. Two hand-edited boxes are left
//!   for review, and a page edited by hand is not touched at all (machine QA leaves it alone too).
//! - Otherwise the bigger one keeps its shape, by a ladder: first the source text's footprint (its
//!   OCR box), and when those are about the same, the one with more translated text.
//! - The other is trimmed back from it on whichever side keeps the most of it. Never moved.
//! - Review instead of a trim: rotated text on either side (line boxes are before rotation, so
//!   they don't say where rotated text is), a trim that leaves too little box, or one whose text
//!   would come out tiny (the drawn px scaled by the share of box area kept).
//!
//! Collisions come from the renderer's `line_boxes`, so only text that is drawn on top of other
//! text counts, not boxes that overlap in their padding. Only renders the pipeline queued
//! (`collisionTrim` in the job payload, set by `coordinator::enqueue_snapshot_render`) are
//! trimmed: never an editor render. The trimmed page is snapshotted and rendered once more,
//! without the flag, so a trim never leads to another trim. Each trim and review is written to
//! the render job's `diagnostics_json` (`text-collision-trimmed` with the old box and the
//! keeper, `text-collision` with the reason). `COLLISION_TRIM=off` turns it off.
//!
//! `scripts/quality/predict_collisions.py` predicts the same thing from a snapshot; keep the two
//! in step. `tests/fixtures/collision-trim.json` holds its output on the test stack's geometry.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::models::Page;
use crate::state::AppState;

const GAP_PX: f64 = 4.0;
/// About the same footprint: within this share of the smaller.
const SAME_FOOTPRINT: f64 = 0.15;
/// A trim must keep this share of the box and this many px on each side, or it goes to review.
const KEEP_AT_LEAST: f64 = 0.4;
const MIN_SIDE_PX: f64 = 24.0;
/// Under this share of the page width, text counts as tiny (as the layout ledger counts it).
const TINY_SHARE: f64 = 0.015;

pub type Rect = [f64; 4];

/// One drawn text object, as the planner sees it.
#[derive(Debug, Clone)]
pub struct TextObject {
    pub id: String,
    /// The box the text is fitted into: `[x, y, width, height]`.
    pub rect: Rect,
    /// The source text's footprint (its OCR box's area); the box's own area when it has none.
    pub source_area: f64,
    /// Translated text length, in characters.
    pub text_len: usize,
    pub hand: bool,
    pub rotated: bool,
    /// The drawn font px.
    pub px: Option<f64>,
    /// The drawn lines, `[x, y, width, height]` each, before rotation.
    pub lines: Vec<Rect>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Trim {
    pub id: String,
    pub keeper: String,
    pub from: Rect,
    pub to: Rect,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Review {
    pub pair: (String, String),
    pub reason: &'static str,
}

fn area(r: &Rect) -> f64 {
    r[2].max(0.0) * r[3].max(0.0)
}

fn area_shared(a: &Rect, b: &Rect) -> f64 {
    let w = (a[0] + a[2]).min(b[0] + b[2]) - a[0].max(b[0]);
    let h = (a[1] + a[3]).min(b[1] + b[3]) - a[1].max(b[1]);
    w.max(0.0) * h.max(0.0)
}

/// Pairs of objects (ids in order) whose drawn lines share any area.
pub fn collisions(objects: &[TextObject]) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    for i in 0..objects.len() {
        for j in i + 1..objects.len() {
            let shared: f64 = objects[i]
                .lines
                .iter()
                .flat_map(|a| objects[j].lines.iter().map(move |b| area_shared(a, b)))
                .sum();
            if shared > 0.0 {
                pairs.push(if objects[i].id <= objects[j].id {
                    (i, j)
                } else {
                    (j, i)
                });
            }
        }
    }
    pairs.sort_by(|a, b| {
        (&objects[a.0].id, &objects[a.1].id).cmp(&(&objects[b.0].id, &objects[b.1].id))
    });
    pairs
}

/// The index of the object that keeps its shape, or None when neither may give way.
fn keeps_its_shape(objects: &[TextObject], a: usize, b: usize) -> Option<usize> {
    let (oa, ob) = (&objects[a], &objects[b]);
    match (oa.hand, ob.hand) {
        (true, true) => return None,
        (true, false) => return Some(a),
        (false, true) => return Some(b),
        _ => {}
    }
    let (fa, fb) = (oa.source_area, ob.source_area);
    if fa.max(fb) > (1.0 + SAME_FOOTPRINT) * fa.min(fb) {
        return Some(if fa > fb { a } else { b });
    }
    if oa.text_len != ob.text_len {
        return Some(if oa.text_len > ob.text_len { a } else { b });
    }
    Some(if fa >= fb { a } else { b })
}

/// The loser's box cut back from the keeper's on one side, or None if every cut leaves too little.
fn trimmed(loser: &Rect, keeper: &Rect) -> Option<Rect> {
    let [x, y, w, h] = *loser;
    let [kx, ky, kw, kh] = *keeper;
    let mut options = Vec::new();
    if kx > x {
        options.push([x, y, kx - GAP_PX - x, h]);
    }
    if kx + kw < x + w {
        let left = kx + kw + GAP_PX;
        options.push([left, y, x + w - left, h]);
    }
    if ky > y {
        options.push([x, y, w, ky - GAP_PX - y]);
    }
    if ky + kh < y + h {
        let top = ky + kh + GAP_PX;
        options.push([x, top, w, y + h - top]);
    }
    // The first of equal areas wins, as Python's max() does.
    options
        .into_iter()
        .filter(|o| {
            o[2] >= MIN_SIDE_PX
                && o[3] >= MIN_SIDE_PX
                && area(o) >= KEEP_AT_LEAST * area(loser)
                && area_shared(o, keeper) == 0.0
        })
        .fold(None, |best: Option<Rect>, o| match best {
            Some(b) if area(&b) >= area(&o) => Some(b),
            _ => Some(o),
        })
}

fn would_be_tiny(object: &TextObject, cut: &Rect, page_width: f64) -> bool {
    let Some(px) = object.px.filter(|px| *px > 0.0) else {
        return false;
    };
    if page_width <= 0.0 {
        return false;
    }
    let tiny = TINY_SHARE * page_width;
    let original = area(&object.rect);
    px >= tiny && px * area(cut) / if original > 0.0 { original } else { 1.0 } < tiny
}

/// The trims and reviews for one page's drawn text.
pub fn plan(objects: &[TextObject], page_width: f64) -> (Vec<Trim>, Vec<Review>) {
    let mut rects: Vec<Rect> = objects.iter().map(|o| o.rect).collect();
    let mut pairs = collisions(objects);
    // Biggest overlap first, so a box that gives way to two neighbours does so for the worst one
    // first. Stable, so equal overlaps keep id order.
    pairs.sort_by(|p, q| {
        area_shared(&rects[q.0], &rects[q.1]).total_cmp(&area_shared(&rects[p.0], &rects[p.1]))
    });
    let mut trims: BTreeMap<usize, Trim> = BTreeMap::new();
    let mut review = Vec::new();
    let pair_ids = |a: usize, b: usize| (objects[a].id.clone(), objects[b].id.clone());
    for (a, b) in pairs {
        if area_shared(&rects[a], &rects[b]) == 0.0 {
            continue; // an earlier trim already parted them
        }
        let Some(keeper) = keeps_its_shape(objects, a, b) else {
            review.push(Review {
                pair: pair_ids(a, b),
                reason: "both hand-edited",
            });
            continue;
        };
        let loser = if keeper == a { b } else { a };
        if objects[a].rotated || objects[b].rotated {
            review.push(Review {
                pair: pair_ids(a, b),
                reason: "rotated",
            });
            continue;
        }
        let Some(cut) = trimmed(&rects[loser], &rects[keeper]) else {
            review.push(Review {
                pair: pair_ids(a, b),
                reason: "too little would be left",
            });
            continue;
        };
        if would_be_tiny(&objects[loser], &cut, page_width) {
            review.push(Review {
                pair: pair_ids(a, b),
                reason: "text would be tiny",
            });
            continue;
        }
        rects[loser] = cut;
        trims
            .entry(loser)
            .and_modify(|t| {
                t.to = cut;
                t.keeper = objects[keeper].id.clone();
            })
            .or_insert(Trim {
                id: objects[loser].id.clone(),
                keeper: objects[keeper].id.clone(),
                from: objects[loser].rect,
                to: cut,
            });
    }
    (trims.into_values().collect(), review)
}

fn enabled() -> bool {
    !matches!(
        std::env::var("COLLISION_TRIM")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "off" | "0" | "false" | "no"
    )
}

/// Each layout object's drawn font px and lines, by element id (`text-<uuid>` objects only).
fn drawn_lines(layout: &Value) -> HashMap<Uuid, (Option<f64>, Vec<Rect>)> {
    let mut out = HashMap::new();
    for object in layout.as_array().into_iter().flatten() {
        let Some(id) = object
            .get("object_id")
            .and_then(Value::as_str)
            .and_then(|id| id.strip_prefix("text-"))
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            continue;
        };
        let px = object.get("font_size").and_then(Value::as_f64);
        let lines = object
            .get("line_boxes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|line| {
                let v: Vec<f64> = line.as_array()?.iter().filter_map(Value::as_f64).collect();
                (v.len() == 4 && v.iter().all(|n| n.is_finite())).then(|| [v[0], v[1], v[2], v[3]])
            })
            .collect();
        out.insert(id, (px, lines));
    }
    out
}

type ElementRow = (
    Uuid,
    f64,
    f64,
    Option<i32>,
    Option<i32>,
    Option<f64>,
    bool,
    String,
    Option<i32>,
    Option<i32>,
);

/// Called by `handle_render_callback` once a render is current. True when it trimmed boxes and
/// queued the page's next render, which then queues QA or completes the pipeline instead of this
/// one. Any failure leaves the page as it was, and is logged.
pub async fn after_render(state: &AppState, job_id: Option<&str>, layout: &Value) -> bool {
    let Some(job_id) = job_id.filter(|id| !id.is_empty()) else {
        return false;
    };
    if !enabled() {
        return false;
    }
    match trim(state, job_id, layout).await {
        Ok(trimmed) => trimmed,
        Err(err) => {
            tracing::warn!("#182 collision trim after render job {job_id} skipped: {err}");
            false
        }
    }
}

async fn trim(state: &AppState, job_id: &str, layout: &Value) -> Result<bool, String> {
    let payload: Option<String> = sqlx::query_scalar("SELECT payload FROM jobs WHERE id = $1")
        .bind(job_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    let payload: Value = payload
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    if payload.get("collisionTrim").and_then(Value::as_bool) != Some(true) {
        return Ok(false);
    }
    let Some((page_id, revision)): Option<(Uuid, i32)> =
        sqlx::query_as("SELECT page_id, page_revision FROM page_render_jobs WHERE job_id = $1")
            .bind(job_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| e.to_string())?
    else {
        return Ok(false);
    };
    let page: Page = sqlx::query_as("SELECT * FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    if page.scene_revision != revision || page.hand_edited_at.is_some() {
        return Ok(false);
    }

    let drawn = drawn_lines(layout);
    if drawn.len() < 2 {
        return Ok(false);
    }
    let ids: Vec<Uuid> = drawn.keys().copied().collect();
    let rows: Vec<ElementRow> = sqlx::query_as(
        "SELECT e.id, e.x, e.y, e.max_width, e.max_height, e.rotation, \
                COALESCE(e.is_manually_edited, FALSE), COALESCE(e.text, ''), r.bbox_w, r.bbox_h \
         FROM layer_elements e JOIN layers l ON l.id = e.layer_id \
         LEFT JOIN ocr_regions r ON r.id = e.region_id \
         WHERE l.page_id = $1 AND e.id = ANY($2)",
    )
    .bind(page_id)
    .bind(&ids)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut objects: Vec<TextObject> = rows
        .into_iter()
        .filter_map(|(id, x, y, w, h, rotation, hand, text, bw, bh)| {
            let (px, lines) = drawn.get(&id)?.clone();
            let rect = [
                x,
                y,
                w.unwrap_or(1).max(1) as f64,
                h.unwrap_or(1).max(1) as f64,
            ];
            let source_area = match (bw, bh) {
                (Some(bw), Some(bh)) if bw > 0 && bh > 0 => (bw as f64) * (bh as f64),
                _ => area(&rect),
            };
            Some(TextObject {
                id: format!("text-{id}"),
                rect,
                source_area,
                text_len: text.chars().count(),
                hand,
                rotated: rotation.is_some_and(|r| r.is_finite() && r != 0.0),
                px,
                lines,
            })
        })
        .collect();
    objects.sort_by(|a, b| a.id.cmp(&b.id));
    let page_width: Option<i32> = sqlx::query_scalar("SELECT width FROM images WHERE id = $1")
        .bind(page.image_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    // Unknown width: the tiny-text guard can't judge, so nothing is trimmed.
    let Some(page_width) = page_width.filter(|w| *w > 0).map(f64::from) else {
        return Ok(false);
    };
    let (trims, review) = plan(&objects, page_width);
    if trims.is_empty() && review.is_empty() {
        return Ok(false);
    }

    let mut notes: Vec<Value> = trims
        .iter()
        .map(|t| {
            json!({"code": "text-collision-trimmed", "objectId": t.id, "keeperObjectId": t.keeper,
                   "from": t.from, "to": t.to})
        })
        .collect();
    notes.extend(review.iter().map(|r| {
        json!({"code": "text-collision", "objectId": r.pair.0, "otherObjectId": r.pair.1,
               "reason": r.reason})
    }));

    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    let current: i32 =
        sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1 FOR UPDATE")
            .bind(page_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    if current != revision {
        tx.rollback().await.map_err(|e| e.to_string())?;
        return Ok(false); // edited meanwhile; the newer revision renders on its own
    }
    sqlx::query(
        "UPDATE page_render_jobs SET diagnostics_json = diagnostics_json || $2::jsonb \
         WHERE job_id = $1",
    )
    .bind(job_id)
    .bind(Value::Array(notes))
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    let mut applied = 0;
    for t in &trims {
        let id =
            t.id.strip_prefix("text-")
                .and_then(|id| Uuid::parse_str(id).ok());
        let Some(id) = id else { continue };
        // Floor the size so the gap to the keeper stays at least GAP_PX.
        let done = sqlx::query(
            "UPDATE layer_elements SET x = $2, y = $3, max_width = $4, max_height = $5 \
             WHERE id = $1 AND COALESCE(is_manually_edited, FALSE) = FALSE",
        )
        .bind(id)
        .bind(t.to[0])
        .bind(t.to[1])
        .bind(t.to[2].floor() as i32)
        .bind(t.to[3].floor() as i32)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        applied += done.rows_affected();
    }
    if applied == 0 {
        tx.commit().await.map_err(|e| e.to_string())?;
        return Ok(false);
    }
    crate::page_scene_builder::snapshot_pipeline_scene(state, &mut tx, page_id).await?;
    tx.commit().await.map_err(|e| e.to_string())?;

    // The next render carries this one's QA intent, and no collisionTrim: it never trims again.
    let mut extra = Map::new();
    for key in ["finalPass", "completesPipeline"] {
        if let Some(flag) = payload.get(key).and_then(Value::as_bool) {
            extra.insert(key.into(), json!(flag));
        }
    }
    let page: Page = sqlx::query_as("SELECT * FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    crate::jobs::recovery::enqueue_current_snapshot_render(state, &page, extra).await?;
    tracing::info!(
        "#182: page {page_id} revision {revision}: trimmed {applied} colliding text box(es), {} left for review; rendering again",
        review.len()
    );
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(id: &str, rect: Rect) -> TextObject {
        TextObject {
            id: id.into(),
            rect,
            source_area: area(&rect),
            text_len: 10,
            hand: false,
            rotated: false,
            px: None,
            // One line filling the box: its text collides wherever the boxes overlap.
            lines: vec![rect],
        }
    }

    #[test]
    fn a_hand_edited_box_always_keeps_its_shape() {
        let mut small = object("a", [0.0, 0.0, 50.0, 50.0]);
        small.hand = true;
        let big = object("b", [0.0, 0.0, 400.0, 400.0]);
        assert_eq!(
            keeps_its_shape(&[small.clone(), big.clone()], 0, 1),
            Some(0)
        );
        assert_eq!(keeps_its_shape(&[big, small], 0, 1), Some(1));
    }

    #[test]
    fn the_bigger_source_footprint_wins_before_the_longer_text() {
        let mut big = object("a", [0.0, 0.0, 100.0, 100.0]);
        big.source_area = 20_000.0;
        big.text_len = 5;
        let mut small = object("b", [0.0, 0.0, 100.0, 100.0]);
        small.source_area = 10_000.0;
        small.text_len = 80;
        assert_eq!(keeps_its_shape(&[big, small], 0, 1), Some(0));
    }

    #[test]
    fn about_the_same_footprint_goes_to_the_longer_text() {
        let mut a = object("a", [0.0, 0.0, 100.0, 100.0]);
        a.text_len = 20;
        let mut b = object("b", [0.0, 0.0, 100.0, 100.0]);
        b.source_area = 10_800.0;
        b.text_len = 60;
        assert_eq!(keeps_its_shape(&[a, b], 0, 1), Some(1));
    }

    #[test]
    fn boxes_that_overlap_only_in_their_padding_are_left_alone() {
        let mut a = object("a", [0.0, 0.0, 200.0, 300.0]);
        let mut b = object("b", [180.0, 0.0, 100.0, 300.0]);
        a.lines = vec![[10.0, 10.0, 150.0, 20.0]];
        b.lines = vec![[200.0, 10.0, 60.0, 20.0]];
        assert_eq!(plan(&[a, b], 1000.0), (vec![], vec![]));
    }

    #[test]
    fn the_smaller_one_is_cut_back_from_the_keeper_never_moved() {
        let a = object("a", [0.0, 0.0, 200.0, 300.0]);
        let b = object("b", [180.0, 0.0, 100.0, 300.0]);
        let (trims, review) = plan(&[a, b], 1000.0);
        assert!(review.is_empty());
        assert_eq!(
            trims,
            vec![Trim {
                id: "b".into(),
                keeper: "a".into(),
                from: [180.0, 0.0, 100.0, 300.0],
                to: [204.0, 0.0, 76.0, 300.0],
            }]
        );
    }

    #[test]
    fn rotated_text_on_either_side_goes_to_review() {
        for rotated in [0, 1] {
            let mut objects = vec![
                object("a", [0.0, 0.0, 200.0, 300.0]),
                object("b", [180.0, 0.0, 100.0, 300.0]),
            ];
            objects[rotated].rotated = true;
            let (trims, review) = plan(&objects, 1000.0);
            assert!(trims.is_empty());
            assert_eq!(review[0].reason, "rotated");
        }
    }

    #[test]
    fn two_hand_edited_boxes_go_to_review() {
        let mut a = object("a", [0.0, 0.0, 200.0, 300.0]);
        let mut b = object("b", [180.0, 0.0, 100.0, 300.0]);
        a.hand = true;
        b.hand = true;
        let (trims, review) = plan(&[a, b], 1000.0);
        assert!(trims.is_empty());
        assert_eq!(review[0].reason, "both hand-edited");
    }

    #[test]
    fn a_trim_whose_text_would_come_out_tiny_goes_to_review() {
        let mut keeper = object("a", [55.0, 0.0, 200.0, 300.0]);
        keeper.source_area = 120_000.0;
        let mut loser = object("b", [0.0, 0.0, 100.0, 300.0]);
        loser.px = Some(25.0);
        let (trims, review) = plan(&[keeper.clone(), loser.clone()], 1000.0);
        assert!(trims.is_empty());
        assert_eq!(review[0].reason, "text would be tiny");
        loser.px = Some(40.0);
        assert_eq!(plan(&[keeper, loser], 1000.0).0.len(), 1);
    }

    #[test]
    fn line_boxes_are_read_from_the_renderer_layout() {
        let id = Uuid::new_v4();
        let layout = json!([
            {"object_id": format!("text-{id}"), "font_size": 20, "lines": ["x"],
             "line_boxes": [[1.0, 2.0, 3.0, 4.0], [1.0, "bad", 3.0, 4.0]]},
            {"object_id": "manual-x", "font_size": 9, "line_boxes": [[0, 0, 1, 1]]},
        ]);
        let drawn = drawn_lines(&layout);
        assert_eq!(drawn.len(), 1);
        assert_eq!(drawn[&id], (Some(20.0), vec![[1.0, 2.0, 3.0, 4.0]]));
    }

    /// The test stack's geometry (no text), with predict_collisions.py's output on it.
    #[test]
    fn agrees_with_the_python_prediction_on_the_test_stack() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/collision-trim.json")).unwrap();
        let rect = |v: &Value| -> Rect {
            let n: Vec<f64> = v
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_f64().unwrap())
                .collect();
            [n[0], n[1], n[2], n[3]]
        };
        let round = |r: Rect| r.map(|v| (v * 10.0).round() / 10.0);
        let (mut trims_seen, mut review_seen) = (0, 0);
        for page in fixture["pages"].as_array().unwrap() {
            let objects: Vec<TextObject> = page["objects"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| TextObject {
                    id: o["id"].as_str().unwrap().into(),
                    rect: rect(&o["box"]),
                    source_area: area(&rect(&o["bbox"])),
                    text_len: o["text_len"].as_u64().unwrap() as usize,
                    hand: o["hand"].as_bool().unwrap(),
                    rotated: o["rotation"].as_f64().unwrap() != 0.0,
                    px: o["px"].as_f64(),
                    lines: o["lines"].as_array().unwrap().iter().map(rect).collect(),
                })
                .collect();
            let name = page["page"].as_str().unwrap();
            let found: Vec<Value> = collisions(&objects)
                .into_iter()
                .map(|(a, b)| json!([objects[a].id, objects[b].id]))
                .collect();
            assert_eq!(
                Value::Array(found),
                page["collisions"],
                "{name}: collisions"
            );
            if page["hand_edited"].as_bool().unwrap() {
                continue;
            }
            let (trims, review) = plan(&objects, page["width"].as_f64().unwrap());
            let trims: Map<String, Value> = trims
                .into_iter()
                .map(|t| (t.id, json!(round(t.to))))
                .collect();
            let expected = page["expected"]["trims"].as_object().unwrap();
            assert_eq!(trims.len(), expected.len(), "{name}: trims");
            for (id, to) in expected {
                let to = round(rect(to));
                assert_eq!(
                    trims.get(id).map(|t| round(rect(t))),
                    Some(to),
                    "{name}: {id}"
                );
            }
            let review: Vec<Value> = review
                .into_iter()
                .map(|r| json!([r.pair.0, r.pair.1, r.reason]))
                .collect();
            assert_eq!(
                Value::Array(review.clone()),
                page["expected"]["review"],
                "{name}: review"
            );
            trims_seen += expected.len();
            review_seen += review.len();
        }
        assert_eq!((trims_seen, review_seen), (8, 39));
    }
}
