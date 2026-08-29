//! ZIP helpers shared by the import endpoints (Java used ZipInputStream inline).
//!
//! Entry filtering mirrors SeriesController/PageController: skip directories,
//! `__MACOSX`, dotfiles and dot-directories; collect only image extensions; keep
//! `project.json` aside for project restores.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::io::Read;

pub const IMAGE_EXTENSIONS: [&str; 5] = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

pub struct ArchiveContents {
    /// name → bytes, in archive order (only kept entries).
    pub entries: BTreeMap<String, Vec<u8>>,
    pub project_json: Option<Vec<u8>>,
    /// Image entries in reading order (see [`natural_cmp`]).
    pub images_sorted: Vec<(String, Vec<u8>)>,
    /// The "original" image per the worker's export convention.
    pub original_image: Option<(String, Vec<u8>)>,
}

fn keep(name: &str) -> bool {
    let lower = name.to_lowercase();
    !(lower.contains("__macosx") || lower.contains("/.") || name.starts_with('.'))
}

fn is_image(name: &str) -> bool {
    let lower = name.to_lowercase();
    IMAGE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Reads a ZIP (or ePub — same container format) from raw bytes.
pub fn read_archive(bytes: &[u8]) -> Result<ArchiveContents, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("unreadable archive: {e}"))?;

    let mut contents = ArchiveContents {
        entries: BTreeMap::new(),
        project_json: None,
        images_sorted: Vec::new(),
        original_image: None,
    };

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("unreadable entry {index}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().trim_end_matches('/').to_string();
        if !keep(&name) {
            continue;
        }

        let mut buffer = Vec::new();
        entry
            .read_to_end(&mut buffer)
            .map_err(|e| format!("failed reading {name}: {e}"))?;

        let lower = name.to_lowercase();
        if name == "project.json" || lower.ends_with("project.json") {
            contents.project_json = Some(buffer);
            continue;
        }
        if is_image(&name) {
            // First image wins unless a later one is literally named/contains "original"
            // (matches the Java condition chain exactly).
            let is_original = name == "original.png" || lower.contains("original");
            if is_original || contents.original_image.is_none() {
                contents.original_image = Some((name.clone(), buffer.clone()));
            }
            contents.images_sorted.push((name.clone(), buffer.clone()));
        }
        contents.entries.insert(name, buffer);
    }

    contents
        .images_sorted
        .sort_by(|a, b| natural_cmp(&a.0, &b.0));
    Ok(contents)
}

/// Orders names the way a reader expects, comparing runs of digits by value.
///
/// Archives are routinely published with unpadded filenames (`1.webp` … `45.webp`).
/// Comparing those as plain text puts `10.webp` second and `2.webp` twelfth, which
/// scrambles a whole imported chapter.
///
/// Comparison is case-insensitive for ASCII, with the exact name as a tie-breaker so
/// the ordering stays total (`01.png` and `1.png` are equal by value but not equal).
pub fn natural_cmp(left: &str, right: &str) -> Ordering {
    // UTF-8 never places an ASCII byte inside a multi-byte character, so scanning bytes
    // is safe: a digit byte is always a real digit, and byte order matches code-point order.
    let l = left.as_bytes();
    let r = right.as_bytes();
    let (mut i, mut j) = (0usize, 0usize);

    while i < l.len() && j < r.len() {
        let (a, b) = (l[i], r[j]);
        match (a.is_ascii_digit(), b.is_ascii_digit()) {
            (true, true) => {
                let a_end = end_of_digits(l, i);
                let b_end = end_of_digits(r, j);
                match cmp_digit_runs(&l[i..a_end], &r[j..b_end]) {
                    Ordering::Equal => {
                        i = a_end;
                        j = b_end;
                    }
                    other => return other,
                }
            }
            // A digit and a letter have no numeric relationship; fall back to the raw
            // bytes so the ordering stays deterministic.
            (true, false) | (false, true) => return a.cmp(&b),
            (false, false) => match a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()) {
                Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                other => return other,
            },
        }
    }

    // Whatever is left decides: the shorter name first, then the exact text so that
    // names differing only in padding or case still have a stable order.
    (l.len() - i)
        .cmp(&(r.len() - j))
        .then_with(|| left.cmp(right))
}

fn end_of_digits(bytes: &[u8], from: usize) -> usize {
    let mut end = from;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    end
}

/// Compares two runs of digits by value without parsing them, so a run longer than any
/// integer type still orders correctly.
fn cmp_digit_runs(left: &[u8], right: &[u8]) -> Ordering {
    let l = strip_leading_zeros(left);
    let r = strip_leading_zeros(right);
    l.len().cmp(&r.len()).then_with(|| l.cmp(r))
}

/// Leaves at least one digit, so an all-zero run keeps a value.
fn strip_leading_zeros(run: &[u8]) -> &[u8] {
    let mut i = 0;
    while i + 1 < run.len() && run[i] == b'0' {
        i += 1;
    }
    &run[i..]
}

/// Writes a ZIP from (name, bytes) pairs into a Vec<u8>.
pub fn write_zip(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        writer
            .start_file(name.clone(), options)
            .map_err(|e| format!("zip write failed: {e}"))?;
        std::io::Write::write_all(&mut writer, bytes)
            .map_err(|e| format!("zip write failed: {e}"))?;
    }
    let cursor = writer
        .finish()
        .map_err(|e| format!("zip finish failed: {e}"))?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(names: &[&str]) -> Vec<String> {
        let mut owned: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        owned.sort_by(|a, b| natural_cmp(a, b));
        owned
    }

    #[test]
    fn unpadded_numbers_sort_by_value() {
        // The archive that exposed this: nhentai-style dumps name pages 1..45 unpadded.
        let names: Vec<String> = (1..=45).rev().map(|i| format!("{i}.webp")).collect();
        let mut owned = names.clone();
        owned.sort_by(|a, b| natural_cmp(a, b));

        let expected: Vec<String> = (1..=45).map(|i| format!("{i}.webp")).collect();
        assert_eq!(owned, expected);
    }

    #[test]
    fn plain_text_ordering_would_have_scrambled_them() {
        let mut lexicographic = vec!["1.webp".to_string(), "2.webp".into(), "10.webp".into()];
        lexicographic.sort();
        assert_eq!(lexicographic, ["1.webp", "10.webp", "2.webp"]);

        assert_eq!(
            sorted(&["1.webp", "2.webp", "10.webp"]),
            ["1.webp", "2.webp", "10.webp"]
        );
    }

    #[test]
    fn padded_and_unpadded_numbers_compare_by_value() {
        assert_eq!(natural_cmp("007.png", "8.png"), Ordering::Less);
        assert_eq!(natural_cmp("7.png", "008.png"), Ordering::Less);
        assert_eq!(natural_cmp("010.png", "9.png"), Ordering::Greater);
        // Equal by value, so the exact text breaks the tie rather than reporting equality.
        assert_ne!(natural_cmp("007.png", "7.png"), Ordering::Equal);
    }

    #[test]
    fn numbers_inside_directories_sort_too() {
        assert_eq!(
            sorted(&["ch1/10.jpg", "ch1/2.jpg", "ch10/1.jpg", "ch2/1.jpg"]),
            ["ch1/2.jpg", "ch1/10.jpg", "ch2/1.jpg", "ch10/1.jpg"]
        );
    }

    #[test]
    fn ascii_case_is_ignored_but_names_stay_distinct() {
        assert_eq!(
            sorted(&["Page10.png", "page2.png", "PAGE1.png"]),
            ["PAGE1.png", "page2.png", "Page10.png"]
        );
        assert_ne!(natural_cmp("a.png", "A.png"), Ordering::Equal);
    }

    #[test]
    fn digit_runs_longer_than_any_integer_still_order() {
        let small = "9999999999999999999999999999999999999999.png";
        let big = "99999999999999999999999999999999999999999.png";
        assert_eq!(natural_cmp(small, big), Ordering::Less);
        assert_eq!(natural_cmp(big, small), Ordering::Greater);
    }

    #[test]
    fn non_ascii_names_do_not_panic_and_stay_ordered() {
        assert_eq!(
            sorted(&["ページ2.png", "ページ10.png", "ページ1.png"]),
            ["ページ1.png", "ページ2.png", "ページ10.png"]
        );
    }

    #[test]
    fn ordering_is_a_consistent_total_order() {
        let names = [
            "1", "01", "001", "1a", "a1", "a01", "10", "2", "0", "00", "a", "A", "", "1.png",
            "1/2", "12", "1-2", "page.png", "Page.PNG", "z9y8", "z10y1", "9", "09", "b", "B2",
            "2b", "20", "002", "a1b2", "a01b2", "x", "0x", "-1", "_1", "1_", ".1", "100", "3",
        ];
        for a in names {
            for b in names {
                assert_eq!(
                    natural_cmp(a, b),
                    natural_cmp(b, a).reverse(),
                    "antisymmetry broken for {a:?} vs {b:?}"
                );
                for c in names {
                    if natural_cmp(a, b) == Ordering::Less && natural_cmp(b, c) == Ordering::Less {
                        assert_eq!(
                            natural_cmp(a, c),
                            Ordering::Less,
                            "transitivity broken: {a:?} < {b:?} < {c:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn read_archive_returns_images_in_reading_order() {
        let shuffled = ["10.webp", "2.webp", "1.webp", "11.webp", "3.webp"];
        let entries: Vec<(String, Vec<u8>)> = shuffled
            .iter()
            .map(|n| (n.to_string(), format!("bytes for {n}").into_bytes()))
            .collect();
        let zip_bytes = write_zip(&entries).expect("zip written");

        let contents = read_archive(&zip_bytes).expect("archive read");
        let order: Vec<&str> = contents
            .images_sorted
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(order, ["1.webp", "2.webp", "3.webp", "10.webp", "11.webp"]);
    }
}
