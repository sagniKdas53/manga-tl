//! WebP thumbnail generation — the replacement for Java's ImageIO + webp-imageio pipeline.
//!
//! PARITY (PageService.generateThumbnail):
//!   * target width fixed at 512 px, height derived from the aspect ratio
//!   * pixels converted to RGB (alpha dropped — thumbnails are opaque)
//!   * lossy WebP at quality 0.85 (Java's 0..1 float == libwebp's 0..100)
//!   * Java upscales small images too (no minimum-size guard), mirrored here
//!
//! What we GAIN by leaving Java:
//!   * no JNI: `webp` crate links a vendored libwebp compiled by cargo itself — the whole
//!     Dockerfile "compile musl .so and put it on java.library.path" stage disappears.
//!   * no WEBP_LOCK: the JNI codec wasn't thread-safe so Java serialized every WebP write;
//!     native bindings here are safe to call concurrently.
//!
//! Rust refresher:
//! - `image::load_from_memory` sniffs the format from magic bytes (JPEG/PNG/WebP/BMP).
//! - `DynamicImage` is an owned decoded image; geometry lives in `.dimensions()`.
//! - Our error enum implements `std::error::Error` manually so you can see the trait at work.

use std::fmt;

/// Fixed on the Java side (`int targetWidth = 512`).
pub const THUMBNAIL_WIDTH: u32 = 512;
/// Java used `setCompressionQuality(0.85f)` on a 0..1 scale; libwebp wants 0..100.
pub const THUMBNAIL_QUALITY: f32 = 85.0;

#[derive(Debug)]
pub enum ThumbnailError {
    /// The source bytes are not a decodable image.
    Decode(image::ImageError),
    /// libwebp refused to encode (effectively never happens with valid RGBA data).
    Encode(String),
}

impl fmt::Display for ThumbnailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode(err) => write!(f, "cannot decode thumbnail source: {err}"),
            Self::Encode(reason) => write!(f, "webp encode failed: {reason}"),
        }
    }
}

impl std::error::Error for ThumbnailError {}

impl From<image::ImageError> for ThumbnailError {
    fn from(err: image::ImageError) -> Self {
        Self::Decode(err)
    }
}

#[derive(Debug)]
/// A finished thumbnail plus the source dimensions (Java persists those separately —
/// the reader overlay needs them even when encoding fails).
pub struct ThumbnailOutput {
    pub webp_bytes: Vec<u8>,
    pub original_width: u32,
    pub original_height: u32,
}

/// Decodes any supported upload format and encodes a width-512 lossy WebP thumbnail.
pub fn generate_thumbnail(original: &[u8]) -> Result<ThumbnailOutput, ThumbnailError> {
    let img = image::load_from_memory(original)?;

    let (original_width, original_height) = (img.width(), img.height());
    let target_height =
        ((original_height as f64 / original_width as f64) * THUMBNAIL_WIDTH as f64).round() as u32;

    // Triangle filter ≈ Java's SCALE_SMOOTH area averaging; RGB drops alpha like TYPE_INT_RGB.
    let resized = img.resize_exact(
        THUMBNAIL_WIDTH,
        target_height.max(1),
        image::imageops::FilterType::Triangle,
    );
    let rgba = resized.to_rgb8();

    let encoder = webp::Encoder::from_rgb(rgba.as_raw(), THUMBNAIL_WIDTH, target_height.max(1));
    let encoded = encoder.encode(THUMBNAIL_QUALITY);
    if encoded.is_empty() {
        return Err(ThumbnailError::Encode("libwebp returned zero bytes".into()));
    }

    Ok(ThumbnailOutput {
        webp_bytes: encoded.to_vec(),
        original_width,
        original_height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    /// Builds a synthetic gradient PNG without any fixture files.
    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        });
        let mut cursor = std::io::Cursor::new(Vec::new());
        img.write_to(&mut cursor, image::ImageFormat::Png).unwrap();
        cursor.into_inner()
    }

    fn decoded_dimensions(bytes: &[u8]) -> (u32, u32) {
        // WebP is among image's enabled decode features, giving us an independent check.
        image::load_from_memory(bytes)
            .expect("thumbnail must decode")
            .dimensions()
    }

    #[test]
    fn portrait_page_gets_512_width_and_preserved_ratio() {
        let out = generate_thumbnail(&png_bytes(1024, 2048)).unwrap(); // manga page shape
        assert_eq!(out.original_width, 1024);
        assert_eq!(out.original_height, 2048);
        let (w, h) = decoded_dimensions(&out.webp_bytes);
        assert_eq!((w, h), (512, 1024));
    }

    #[test]
    fn landscape_image_keeps_ratio() {
        let out = generate_thumbnail(&png_bytes(2000, 500)).unwrap();
        let (w, h) = decoded_dimensions(&out.webp_bytes);
        assert_eq!((w, h), (512, 128));
    }

    #[test]
    fn tiny_images_are_upscaled_like_java_scale_smooth() {
        let out = generate_thumbnail(&png_bytes(64, 64)).unwrap();
        let (w, h) = decoded_dimensions(&out.webp_bytes);
        assert_eq!((w, h), (512, 512));
    }

    #[test]
    fn jpeg_sources_work_too() {
        let img = image::RgbImage::from_fn(800, 600, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 200])
        });
        let mut cursor = std::io::Cursor::new(Vec::new());
        img.write_to(&mut cursor, image::ImageFormat::Jpeg).unwrap();
        let out = generate_thumbnail(cursor.get_ref()).unwrap();
        let (w, _) = decoded_dimensions(&out.webp_bytes);
        assert_eq!(w, 512);
    }

    #[test]
    fn garbage_input_is_a_decode_error() {
        let err = generate_thumbnail(b"definitely not an image").unwrap_err();
        assert!(matches!(err, ThumbnailError::Decode(_)));
        assert!(err.to_string().contains("decode"));
    }
}
