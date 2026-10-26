//! Wiki image projections and output writes. Format decoding is owned by document-parser.

use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use document_parser::{Anchor, Document, ParseOptions, ParseRequest, Target};
use serde::Serialize;

/// Filter knobs. The defaults mirror the existing import pipeline.
#[derive(Debug, Clone)]
pub struct ExtractOptions {
    /// Skip images smaller than this on EITHER axis. 100×100 catches
    /// the vast majority of icons / logos / page-corner decorations
    /// without dropping legitimate small chart insets.
    pub min_width: u32,
    pub min_height: u32,
    /// Hard cap on the number of images returned per document. A
    /// pathological 5000-image PDF would otherwise blow up memory
    /// (each image base64'd is ~MB-scale) AND blow up downstream VLM
    /// cost during Phase 3.
    pub max_images: usize,
    /// Skip raster image objects that cover most of a PDF page when the page
    /// already has meaningful extractable text. Pure scanned pages, and scans
    /// with only a page number or watermark text layer, keep their full-page
    /// raster because that image is the only reliable content. Searchable OCR
    /// scans with a full text layer may be treated as text pages; this is an
    /// intentional default tradeoff to avoid importing every PDF page as a
    /// large duplicate PNG.
    pub skip_full_page_images: bool,
    /// Fraction of page width and height an image must cover to be considered
    /// page-sized. Values are clamped to 0.5..=1.0 before use.
    pub full_page_coverage_ratio: f32,
    /// Minimum non-whitespace text characters before a page is treated as a
    /// text page for page-sized image filtering.
    pub full_page_min_text_chars: usize,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            min_width: 100,
            min_height: 100,
            max_images: 500,
            skip_full_page_images: true,
            full_page_coverage_ratio: 0.90,
            full_page_min_text_chars: 80,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedImage {
    /// 1-based index in document order. Stable across re-extractions.
    /// Stability assumes the same extraction options; changing filters can
    /// shift subsequent indices.
    /// Used as the filename suffix when the caller writes images to
    /// `wiki/media/<slug>/img-<index>.<ext>`.
    pub index: u32,
    /// MIME type ("image/png" / "image/jpeg" / etc.). PNG for any
    /// image we re-encode (PDFs always); pass-through for office docs
    /// where the original bytes are already in a web-friendly format.
    pub mime_type: String,
    /// 1-based page number for PDFs / 1-based slide number for PPTX.
    /// `None` for DOCX (which doesn't have a per-image page concept
    /// at extraction time without parsing document.xml position
    /// markers, which is more work than this phase needs).
    pub page: Option<u32>,
    pub width: u32,
    pub height: u32,
    /// Image bytes, base64-encoded. JSON IPC can't carry raw binary.
    pub data_base64: String,
    /// SHA-256 hex of the *encoded* bytes (same encoding as
    /// `data_base64` decodes to). Used by the Phase 3 caption cache
    /// to dedupe identical images across files.
    pub sha256: String,
}

fn parse(
    path: &str,
    options: &ExtractOptions,
    office: bool,
    extract_assets: bool,
) -> Result<Document, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read preprocessing source: {error}"))?;
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let settings = ParseOptions {
        extract_assets,
        images: document_parser::ImageOptions {
            min_width: options.min_width,
            min_height: options.min_height,
            // Office preserves all originals; Wiki applies its historical raster-only cap below.
            max_images: if office {
                usize::MAX
            } else {
                options.max_images
            },
            skip_full_page_images: options.skip_full_page_images,
            full_page_coverage_ratio: options.full_page_coverage_ratio,
            full_page_min_text_chars: options.full_page_min_text_chars,
        },
    };
    let request = ParseRequest {
        bytes: &bytes,
        extension,
        display_name: Path::new(path).file_name().and_then(|name| name.to_str()),
        options: &settings,
        cancellation: None,
    };
    let document = if office {
        document_parser::parse_office_assets(request)
    } else {
        document_parser::parse(request)
    }
    .map_err(|error| error.to_string())?;
    if platform::trace::enabled() {
        eprintln!(
            "[document-parser] coverage={:?}, diagnostics={:?}",
            document.coverage, document.diagnostics
        );
    }
    Ok(document)
}

fn page(document: &Document, asset_id: u32) -> Option<u32> {
    document
        .source_map
        .iter()
        .filter(|entry| matches!(entry.target, Target::Asset { asset_id: id } if id == asset_id))
        .find_map(|entry| match &entry.anchor {
            Anchor::Pdf { page, .. } => Some(*page),
            Anchor::PackagePart { part, .. } => part
                .strip_prefix("ppt/slides/slide")
                .and_then(|name| name.strip_suffix(".xml"))
                .and_then(|number| number.parse().ok()),
            _ => None,
        })
}

fn raster(asset: &document_parser::Asset) -> bool {
    matches!(
        asset.media_type.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp"
    ) && asset.width.is_some()
        && asset.height.is_some()
}

fn extracted(document: Document, options: &ExtractOptions) -> Vec<ExtractedImage> {
    document
        .assets
        .iter()
        .filter(|asset| raster(asset))
        .take(options.max_images)
        .enumerate()
        .map(|(index, asset)| ExtractedImage {
            index: index as u32 + 1,
            mime_type: asset.media_type.clone(),
            page: page(&document, asset.id),
            width: asset.width.unwrap(),
            height: asset.height.unwrap(),
            data_base64: B64.encode(&asset.bytes),
            sha256: asset.sha256.clone(),
        })
        .collect()
}

pub fn extract_pdf_images(
    path: &str,
    options: &ExtractOptions,
) -> Result<Vec<ExtractedImage>, String> {
    parse(path, options, false, true).map(|document| extracted(document, options))
}

pub fn extract_office_images(
    path: &str,
    options: &ExtractOptions,
) -> Result<Vec<ExtractedImage>, String> {
    parse(path, options, true, true).map(|document| extracted(document, options))
}

pub fn extract_pdf_markdown(
    path: &str,
    media_dest_dir: Option<&Path>,
    media_url_prefix: &str,
    options: &ExtractOptions,
) -> Result<String, String> {
    let document = parse(path, options, false, media_dest_dir.is_some())?;
    if document.coverage.entries.iter().any(|entry| {
        matches!(entry.status, document_parser::CoverageStatus::Failed)
            && matches!(
                entry.reason,
                document_parser::CoverageReason::TextUnavailable
            )
    }) {
        return Err("PDF page text extraction failed".to_owned());
    }
    let Some(destination) = media_dest_dir else {
        return Ok(document.markdown);
    };
    let mut output = String::new();
    let prefix = media_url_prefix.trim_end_matches('/');
    for block in &document.blocks {
        let Some(number) =
            document
                .source_map
                .iter()
                .find_map(|entry| match (&entry.target, &entry.anchor) {
                    (Target::Block { block_id, .. }, Anchor::Pdf { page, .. })
                        if *block_id == block.id =>
                    {
                        Some(*page)
                    }
                    _ => None,
                })
        else {
            continue;
        };
        if !output.is_empty() {
            output.push_str("\n\n");
        }
        output.push_str(&format!("## Page {number}\n\n{}\n", block.text));
        let mut images = Vec::new();
        for asset in document
            .assets
            .iter()
            .filter(|asset| page(&document, asset.id) == Some(number))
        {
            let name = format!("img-{}.png", asset.id + 1);
            if let Err(error) = save_one_image(&asset.bytes, destination, destination, &name) {
                eprintln!("[extract_pdf_markdown] image save failed: {error}");
                continue;
            }
            images.push(format!("![]({prefix}/{name})"));
        }
        if !images.is_empty() {
            output.push('\n');
            for image in images {
                output.push_str(&image);
                output.push('\n');
            }
        }
    }
    Ok(output)
}

/// Metadata for an image that's already been written to disk.
/// Mirrors `ExtractedImage` but swaps `data_base64` for `rel_path` —
/// the path the caller can embed in markdown (`![alt](rel_path)`).
///
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub index: u32,
    pub mime_type: String,
    pub page: Option<u32>,
    pub width: u32,
    pub height: u32,
    /// Path of the written file, relative to `dest_dir_relative_to`.
    /// E.g. when `dest_dir` is `<project>/wiki/media/foo` and
    /// `dest_dir_relative_to` is `<project>/wiki`, this is
    /// `media/foo/img-1.png`. The caller-provided base lets us
    /// generate paths that work inside markdown rendered from
    /// anywhere under the wiki root.
    pub rel_path: String,
    /// Absolute path on disk — the chat / file-preview UI uses this
    /// (via `convertFileSrc`) to actually load the image.
    pub abs_path: String,
    pub sha256: String,
}

fn save_one_image(
    bytes: &[u8],
    dest_dir: &Path,
    dest_dir_relative_to: &Path,
    file_name: &str,
) -> Result<(String, String), String> {
    if !dest_dir.exists() {
        std::fs::create_dir_all(dest_dir)
            .map_err(|e| format!("create_dir_all '{}': {e}", dest_dir.display()))?;
    }
    let abs = dest_dir.join(file_name);
    std::fs::write(&abs, bytes).map_err(|e| format!("write '{}': {e}", abs.display()))?;

    let rel = abs
        .strip_prefix(dest_dir_relative_to)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| file_name.to_string());
    Ok((rel, abs.to_string_lossy().to_string()))
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "bin",
    }
}

fn save(
    document: Document,
    destination: &Path,
    relative_to: &Path,
    options: &ExtractOptions,
) -> Result<Vec<SavedImage>, String> {
    document
        .assets
        .iter()
        .filter(|asset| raster(asset))
        .take(options.max_images)
        .enumerate()
        .map(|(index, asset)| {
            let index = index as u32 + 1;
            let name = format!("img-{index}.{}", ext_for_mime(&asset.media_type));
            let (rel_path, abs_path) =
                save_one_image(&asset.bytes, destination, relative_to, &name)?;
            Ok(SavedImage {
                index,
                mime_type: asset.media_type.clone(),
                page: page(&document, asset.id),
                width: asset.width.unwrap(),
                height: asset.height.unwrap(),
                rel_path,
                abs_path,
                sha256: asset.sha256.clone(),
            })
        })
        .collect()
}

pub fn extract_and_save_pdf_images(
    path: &str,
    dest_dir: &Path,
    rel_to: &Path,
    options: &ExtractOptions,
) -> Result<Vec<SavedImage>, String> {
    save(
        parse(path, options, false, true)?,
        dest_dir,
        rel_to,
        options,
    )
}

pub fn extract_and_save_office_images(
    path: &str,
    dest_dir: &Path,
    rel_to: &Path,
    options: &ExtractOptions,
) -> Result<Vec<SavedImage>, String> {
    save(parse(path, options, true, true)?, dest_dir, rel_to, options)
}
