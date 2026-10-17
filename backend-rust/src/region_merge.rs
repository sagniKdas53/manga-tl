//! Geometry and text for merging OCR fragments into one text block (the Reader's "Merge regions").
//!
//! Pure functions so the order rules are testable without a database. The route that applies a
//! merge lives in `routes::page::merge_ocr_regions`.

/// One fragment as the merge sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct Fragment {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub text: String,
}

/// How much of the narrower fragment two fragments must share across the reading axis to sit in
/// the same column (vertical text) or line (horizontal text).
const SAME_LINE_SHARE: f64 = 0.5;

/// Is this block set vertically? Longer side weighted, like the worker's orientation vote, so one
/// long column outweighs a few square glyphs.
pub fn is_vertical(fragments: &[Fragment]) -> bool {
    let (mut vertical, mut horizontal) = (0i64, 0i64);
    for f in fragments {
        if f.h > f.w {
            vertical += f.h.max(f.w) as i64;
        } else {
            horizontal += f.h.max(f.w) as i64;
        }
    }
    vertical > horizontal
}

fn overlap(a0: i32, a1: i32, b0: i32, b1: i32) -> f64 {
    let shared = (a1.min(b1) - a0.max(b0)).max(0) as f64;
    let narrower = ((a1 - a0).min(b1 - b0)).max(1) as f64;
    shared / narrower
}

/// Indices in reading order.
///
/// Vertical text (manga's default) reads columns right to left and each column top to bottom, so
/// an OCR column split in two — ブラ above イダルなんて — rejoins as ブライダルなんて before the
/// next column starts. Horizontal text reads lines top to bottom, each left to right.
pub fn reading_order(fragments: &[Fragment]) -> Vec<usize> {
    let vertical = is_vertical(fragments);
    // (across-axis span, member indices)
    let mut lines: Vec<((i32, i32), Vec<usize>)> = Vec::new();
    let mut by_across: Vec<usize> = (0..fragments.len()).collect();
    by_across.sort_by_key(|&i| {
        let f = &fragments[i];
        if vertical { -(f.x + f.w) } else { f.y }
    });
    for i in by_across {
        let f = &fragments[i];
        let span = if vertical {
            (f.x, f.x + f.w)
        } else {
            (f.y, f.y + f.h)
        };
        match lines
            .iter_mut()
            .find(|(line, _)| overlap(line.0, line.1, span.0, span.1) >= SAME_LINE_SHARE)
        {
            Some((line, members)) => {
                line.0 = line.0.min(span.0);
                line.1 = line.1.max(span.1);
                members.push(i);
            }
            None => lines.push((span, vec![i])),
        }
    }
    if vertical {
        lines.sort_by_key(|(span, _)| -span.1);
    } else {
        lines.sort_by_key(|(span, _)| span.0);
    }
    lines
        .into_iter()
        .flat_map(|(_, mut members)| {
            members.sort_by_key(|&i| {
                if vertical {
                    fragments[i].y
                } else {
                    fragments[i].x
                }
            });
            members
        })
        .collect()
}

/// Is this language written without spaces between words?
fn unspaced(language: &str) -> bool {
    let language = language.to_ascii_lowercase();
    ["ja", "zh", "th"]
        .iter()
        .any(|code| language.starts_with(code))
}

/// The block's source text: fragments in reading order, joined without a separator for
/// Japanese/Chinese/Thai and with one space otherwise (Korean spaces its words).
pub fn joined_text(fragments: &[Fragment], order: &[usize], language: &str) -> String {
    let separator = if unspaced(language) { "" } else { " " };
    order
        .iter()
        .map(|&i| fragments[i].text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(separator)
}

/// `(x, y, w, h)` of the smallest box holding every given box.
pub fn union_box(
    boxes: impl IntoIterator<Item = (i32, i32, i32, i32)>,
) -> Option<(i32, i32, i32, i32)> {
    let mut acc: Option<(i32, i32, i32, i32)> = None;
    for (x, y, w, h) in boxes {
        acc = Some(match acc {
            None => (x, y, x + w, y + h),
            Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x + w), y1.max(y + h)),
        });
    }
    acc.map(|(x0, y0, x1, y1)| (x0, y0, x1 - x0, y1 - y0))
}

/// Pieces of text agree on an angle when they are this close (E0's agreement, degrees).
pub const AGREE_DEGREES: f64 = 6.0;

/// E2 (#180): the box along the text of a merged block, when every merged region is set at the
/// same angle as `angle` (within [`AGREE_DEGREES`], directions wrapping at ±90°). Each input is a
/// region's text box `(x, y, w, h, degrees)`: level, drawn turned by `degrees` about its centre.
/// The result is the level box that, turned by `angle` about its own centre, covers all of them.
/// `None` when `angle` is level or the regions disagree: the merge then stays level.
pub fn merged_text_area(
    boxes: &[(f64, f64, f64, f64, f64)],
    angle: f64,
) -> Option<(f64, f64, f64, f64)> {
    let gap = |a: f64, b: f64| ((a - b + 90.0).rem_euclid(180.0) - 90.0).abs();
    if angle == 0.0 || !angle.is_finite() || boxes.is_empty() {
        return None;
    }
    if boxes.iter().any(|b| gap(b.4, angle) > AGREE_DEGREES) {
        return None;
    }
    let (sin, cos) = angle.to_radians().sin_cos();
    let (mut u0, mut u1, mut v0, mut v1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for &(x, y, w, h, degrees) in boxes {
        let (cx, cy) = (x + w / 2.0, y + h / 2.0);
        let (bs, bc) = degrees.to_radians().sin_cos();
        for (dx, dy) in [(-w, -h), (w, -h), (w, h), (-w, h)] {
            let (dx, dy) = (dx / 2.0, dy / 2.0);
            let (px, py) = (cx + dx * bc - dy * bs, cy + dx * bs + dy * bc);
            // Into the block's frame: turn by -angle.
            let (u, v) = (px * cos + py * sin, -px * sin + py * cos);
            u0 = u0.min(u);
            u1 = u1.max(u);
            v0 = v0.min(v);
            v1 = v1.max(v);
        }
    }
    let (w, h) = (u1 - u0, v1 - v0);
    let (cu, cv) = ((u0 + u1) / 2.0, (v0 + v1) / 2.0);
    let (cx, cy) = (cu * cos - cv * sin, cu * sin + cv * cos);
    Some((cx - w / 2.0, cy - h / 2.0, w, h))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_merge_of_regions_at_one_angle_keeps_a_box_along_the_text() {
        // Two 100x20 lines at 30°, 30 px apart across the text, centred on (200, 200).
        let a = 30f64.to_radians();
        let (ox, oy) = (-a.sin() * 15.0, a.cos() * 15.0);
        let line = |cx: f64, cy: f64, deg: f64| (cx - 50.0, cy - 10.0, 100.0, 20.0, deg);
        let boxes = [
            line(200.0 - ox, 200.0 - oy, 30.0),
            line(200.0 + ox, 200.0 + oy, 30.0),
        ];
        // A region 2° off still agrees.
        assert!(super::merged_text_area(&[line(0.0, 0.0, 32.0)], 30.0).is_some());
        let (x, y, w, h) = super::merged_text_area(&boxes, 30.0).expect("agree");
        assert!((x + w / 2.0 - 200.0).abs() < 0.5 && (y + h / 2.0 - 200.0).abs() < 0.5);
        assert!(
            (w - 100.0).abs() < 4.0 && (h - 50.0).abs() < 4.0,
            "{w} x {h}"
        );
    }

    #[test]
    fn a_merge_whose_regions_disagree_or_are_level_stays_level() {
        let boxes = [(0.0, 0.0, 100.0, 20.0, 30.0), (0.0, 40.0, 100.0, 20.0, 0.0)];
        assert_eq!(super::merged_text_area(&boxes, 30.0), None);
        assert_eq!(super::merged_text_area(&boxes[1..], 0.0), None);
        // Directions wrap at ±90°: -89° and +89° agree.
        let wrap = [
            (0.0, 0.0, 20.0, 100.0, -89.0),
            (40.0, 0.0, 20.0, 100.0, 89.0),
        ];
        assert!(super::merged_text_area(&wrap, 89.0).is_some());
    }

    use super::*;

    fn frag(x: i32, y: i32, w: i32, h: i32, text: &str) -> Fragment {
        Fragment {
            x,
            y,
            w,
            h,
            text: text.into(),
        }
    }

    #[test]
    fn vertical_columns_read_right_to_left_and_rejoin_a_split_column() {
        // Ch.3 p2's balloon: two columns were each split in two by OCR.
        let fragments = vec![
            frag(2026, 501, 114, 235, "ブラ"),
            frag(1936, 508, 104, 207, "アイ"),
            frag(1811, 491, 142, 726, "していなければ"),
            frag(2002, 670, 162, 626, "イダルなんて"),
            frag(1919, 677, 135, 332, "ドルを"),
        ];
        let order = reading_order(&fragments);
        assert_eq!(
            joined_text(&fragments, &order, "ja"),
            "ブライダルなんてアイドルをしていなければ"
        );
    }

    #[test]
    fn a_merged_block_joins_the_rest_of_its_balloon_in_place() {
        // The same balloon after #6 and #7 were merged on their own: picking the remaining pieces
        // plus that block, in the Reader's (OCR) numbering #3 #4 #5 #6 #8 #9, must still read as
        // one sentence, the merged block last because its column is leftmost.
        let fragments = vec![
            frag(2026, 501, 114, 235, "ブラ"),
            frag(1936, 508, 104, 207, "アイ"),
            frag(1811, 491, 142, 726, "していなければ"),
            frag(1628, 487, 232, 633, "縁が無かったでしょう："),
            frag(2002, 670, 162, 626, "イダルなんて"),
            frag(1919, 677, 135, 332, "ドルを"),
        ];
        let order = reading_order(&fragments);
        assert_eq!(order, vec![0, 4, 1, 5, 2, 3]);
        assert_eq!(
            joined_text(&fragments, &order, "ja"),
            "ブライダルなんてアイドルをしていなければ縁が無かったでしょう："
        );
    }

    #[test]
    fn horizontal_lines_read_top_to_bottom() {
        // Page 4's profile paragraph: three lines of one sentence.
        let fragments = vec![
            frag(38, 284, 235, 16, "なければ基本どのような性癖"),
            frag(37, 174, 236, 102, "課外活動まで積極的に"),
            frag(37, 309, 199, 20, "だろうと肯定してくれる"),
        ];
        let order = reading_order(&fragments);
        assert_eq!(order, vec![1, 0, 2]);
        assert_eq!(
            joined_text(&fragments, &order, "en"),
            "課外活動まで積極的に なければ基本どのような性癖 だろうと肯定してくれる"
        );
    }

    #[test]
    fn union_box_spans_every_member() {
        assert_eq!(
            union_box([(10, 20, 5, 5), (0, 30, 3, 10)]),
            Some((0, 20, 15, 20))
        );
        assert_eq!(union_box([]), None);
    }
}
