//! ZIP helpers shared by the import endpoints (Java used ZipInputStream inline).
//!
//! Entry filtering mirrors SeriesController/PageController: skip directories,
//! `__MACOSX`, dotfiles and dot-directories; collect only image extensions; keep
//! `project.json` aside for project restores.

use std::collections::BTreeMap;
use std::io::Read;

pub const IMAGE_EXTENSIONS: [&str; 5] = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

pub struct ArchiveContents {
    /// name → bytes, in archive order (only kept entries).
    pub entries: BTreeMap<String, Vec<u8>>,
    pub project_json: Option<Vec<u8>>,
    /// Image entries sorted by filename (the import order Java relied on).
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

    contents.images_sorted.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(contents)
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
