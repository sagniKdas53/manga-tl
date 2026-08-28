//! Build-time prerequisites for rust-embed.
//!
//! `SpaAssets` (routes/mod.rs) embeds `../frontend/dist`, but that directory only exists
//! after a frontend build and is gitignored. A missing folder would fail every clean
//! checkout's `cargo test/build` long before anyone serves the SPA, so this script seeds a
//! one-file stub when needed; a real `npm run build` overwrites it with the full bundle.
//!
//! The Dockerfile always runs the frontend stage first, so production images embed real
//! assets; the stub ships only in dev binaries nobody serves.

use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = manifest.join("../frontend/dist");
    let index = dist.join("index.html");

    if !index.exists() {
        fs::create_dir_all(&dist).expect("create frontend/dist stub dir");
        fs::write(
            &index,
            "<!doctype html><title>manga-tl</title><p>SPA not built; run `npm run build`.</p>\n",
        )
        .expect("write stub index.html");
    }

    println!("cargo:rerun-if-changed={}", dist.display());
}
