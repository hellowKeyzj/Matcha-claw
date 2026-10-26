use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use pdfium_render::prelude::*;

use crate::{
    Anchor, Asset, BlockKind, BoundingBox, CoverageReason, CoverageStatus, Document, FailureKind,
    ParseFailure, ParseRequest, SourceMapEntry, Target, digest,
};

struct LoadedPdfium {
    parser: Pdfium,
    fingerprint: String,
}

static PDFIUM: OnceLock<Result<LoadedPdfium, ParseFailure>> = OnceLock::new();
static PDFIUM_LOCK: Mutex<()> = Mutex::new(());
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
static EXACT_PDFIUM: OnceLock<Option<(PathBuf, String)>> = OnceLock::new();

/// Trusted process initialization, never document options. None disables native PDF parsing.
pub fn set_exact_pdfium(selection: Option<(&Path, &str)>) -> Result<(), ParseFailure> {
    let _guard = PDFIUM_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if PDFIUM.get().is_some()
        || EXACT_PDFIUM
            .set(selection.map(|(path, digest)| (path.to_owned(), digest.to_owned())))
            .is_err()
    {
        return Err(ParseFailure::caused(
            FailureKind::ParserUnavailable,
            std::io::Error::from(std::io::ErrorKind::AlreadyExists),
        ));
    }
    if selection.is_some() {
        pdfium()?;
    }
    Ok(())
}

pub fn set_resource_dir_hint(directory: PathBuf) {
    let _ = RESOURCE_DIR.set(directory);
}

fn pdfium() -> Result<&'static LoadedPdfium, ParseFailure> {
    PDFIUM
        .get_or_init(|| {
            if let Some(selection) = EXACT_PDFIUM.get() {
                let (path, expected) = selection.as_ref()
                    .ok_or_else(|| ParseFailure::new(FailureKind::ParserUnavailable))?;
                let (bindings, fingerprint) = crate::pdf_library::bind_exact(path, expected)?;
                return Ok(LoadedPdfium {
                    parser: Pdfium::new(bindings),
                    fingerprint,
                });
            }
            let mut paths = Vec::new();
            if let Ok(path) = std::env::var("PDFIUM_DYNAMIC_LIB_PATH") {
                paths.push(PathBuf::from(path));
            }
            if let Some(directory) = RESOURCE_DIR.get() {
                resource_paths(&mut paths, directory);
            }
            if let Ok(executable) = std::env::current_exe() {
                if let Some(directory) = executable.parent() {
                    resource_paths(&mut paths, directory);
                    resource_paths(&mut paths, &directory.join("resources"));
                    #[cfg(target_os = "macos")]
                    {
                        paths.push(directory.join("../Frameworks/libpdfium.dylib"));
                        resource_paths(&mut paths, &directory.join("../Resources"));
                    }
                    #[cfg(target_os = "linux")]
                    paths.push(directory.join("../lib/libpdfium.so"));
                }
            }
            paths.push(PathBuf::from(Pdfium::pdfium_platform_library_name()));
            let mut failure = ParseFailure::new(FailureKind::ParserUnavailable);
            for path in paths {
                match crate::pdf_library::bind(&path) {
                    Ok((bindings, fingerprint)) => {
                        return Ok(LoadedPdfium {
                            parser: Pdfium::new(bindings),
                            fingerprint,
                        });
                    }
                    Err(error) => failure = error,
                }
            }
            Err(failure)
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn resource_paths(paths: &mut Vec<PathBuf>, directory: &Path) {
    #[cfg(target_os = "windows")]
    let names = ["pdfium.dll", "libpdfium.dll"];
    #[cfg(target_os = "macos")]
    let names = ["libpdfium.dylib"];
    #[cfg(target_os = "linux")]
    let names = ["libpdfium.so"];
    for name in names {
        paths.push(directory.join("pdfium").join(name));
        paths.push(directory.join(name));
    }
}

fn failure(error: PdfiumError) -> ParseFailure {
    let kind = if matches!(
        error,
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError)
    ) {
        FailureKind::Encrypted
    } else {
        FailureKind::Corrupt
    };
    ParseFailure::caused(kind, error)
}

fn bounds(rectangle: PdfRect) -> BoundingBox {
    BoundingBox {
        left: rectangle.left().value,
        bottom: rectangle.bottom().value,
        right: rectangle.right().value,
        top: rectangle.top().value,
    }
}

pub(crate) fn parse(request: &ParseRequest<'_>) -> Result<Document, ParseFailure> {
    let _guard = PDFIUM_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    request.check_cancelled()?;
    let pdfium = pdfium()?;
    let document = pdfium
        .parser
        .load_pdf_from_byte_slice(request.bytes, None)
        .map_err(failure)?;
    let mut output = Document {
        dependency_fingerprints: vec![pdfium.fingerprint.clone()],
        ..Document::default()
    };
    let options = &request.options.images;
    for index in 0..document.pages().len() {
        request.check_cancelled()?;
        let number = index as u32 + 1;
        let anchor = Anchor::Pdf {
            page: number,
            bbox: None,
        };
        let page = match document.pages().get(index) {
            Ok(page) => page,
            Err(error) => {
                output.diagnostics.push(failure(error));
                output.coverage(
                    Some(anchor),
                    CoverageStatus::Failed,
                    CoverageReason::TextUnavailable,
                );
                continue;
            }
        };
        if !output.markdown.is_empty() {
            output.markdown.push_str("\n\n");
        }
        output.markdown.push_str(&format!("## Page {number}\n\n"));
        let mut meaningful = false;
        match page.text() {
            Ok(text) => {
                let all = text.all();
                meaningful = all
                    .chars()
                    .filter(|character| !character.is_whitespace())
                    .count()
                    >= options.full_page_min_text_chars;
                output.markdown.push_str(&all);
                output.markdown.push('\n');
                let block = output.push_block(
                    None,
                    BlockKind::Paragraph,
                    all.clone(),
                    Some(anchor.clone()),
                );
                let mut search_from = 0;
                let segments = text.segments();
                for segment_index in 0..segments.len() {
                    let segment = match segments.get(segment_index) {
                        Ok(segment) => segment,
                        Err(error) => {
                            output.diagnostics.push(failure(error));
                            output.coverage(
                                Some(anchor.clone()),
                                CoverageStatus::Missing,
                                CoverageReason::LocationUnavailable,
                            );
                            continue;
                        }
                    };
                    let segment_text = segment.text();
                    if segment_text.is_empty() {
                        continue;
                    }
                    if let Some(position) = all[search_from..].find(&segment_text) {
                        let start = search_from + position;
                        let end = start + segment_text.len();
                        output.source_map.push(SourceMapEntry {
                            target: Target::Block {
                                block_id: block,
                                start: start as u64,
                                end: end as u64,
                            },
                            anchor: Anchor::Pdf {
                                page: number,
                                bbox: Some(bounds(segment.bounds())),
                            },
                        });
                        search_from = end;
                    } else {
                        output.coverage(
                            Some(anchor.clone()),
                            CoverageStatus::Missing,
                            CoverageReason::LocationUnavailable,
                        );
                    }
                }
                if all.trim().is_empty() {
                    output.coverage(
                        Some(anchor.clone()),
                        CoverageStatus::Missing,
                        CoverageReason::OcrUnavailable,
                    );
                } else {
                    output.coverage(
                        Some(anchor.clone()),
                        CoverageStatus::Processed,
                        CoverageReason::Parsed,
                    );
                }
            }
            Err(error) => {
                output.diagnostics.push(failure(error));
                output.coverage(
                    Some(anchor.clone()),
                    CoverageStatus::Failed,
                    CoverageReason::TextUnavailable,
                );
            }
        }
        if !request.options.extract_assets {
            output.coverage(
                Some(anchor),
                CoverageStatus::Missing,
                CoverageReason::AssetExtractionDisabled,
            );
            continue;
        }
        for object in page.objects().iter() {
            request.check_cancelled()?;
            let Some(image) = object.as_image_object() else {
                continue;
            };
            let image_bounds = object.bounds().ok();
            let image_anchor = Anchor::Pdf {
                page: number,
                bbox: image_bounds.map(|quad| bounds(quad.to_rect())),
            };
            let full_page = image_bounds.is_some_and(|rectangle| {
                rectangle.width().value / page.width().value
                    >= options.full_page_coverage_ratio.clamp(0.5, 1.0)
                    && rectangle.height().value / page.height().value
                        >= options.full_page_coverage_ratio.clamp(0.5, 1.0)
            });
            if options.skip_full_page_images && meaningful && full_page {
                output.coverage(
                    Some(image_anchor),
                    CoverageStatus::Missing,
                    CoverageReason::AssetFiltered,
                );
                continue;
            }
            if output.assets.len() >= options.max_images {
                output.coverage(
                    Some(image_anchor),
                    CoverageStatus::Truncated,
                    CoverageReason::ImageLimit {
                        limit: options.max_images,
                    },
                );
                continue;
            }
            let image = match image.get_raw_image() {
                Ok(image) => image,
                Err(error) => {
                    output.diagnostics.push(failure(error));
                    output.coverage(
                        Some(image_anchor),
                        CoverageStatus::Failed,
                        CoverageReason::AssetDecodeFailed,
                    );
                    continue;
                }
            };
            if image.width() < options.min_width || image.height() < options.min_height {
                output.coverage(
                    Some(image_anchor),
                    CoverageStatus::Missing,
                    CoverageReason::AssetFiltered,
                );
                continue;
            }
            let mut bytes = Vec::new();
            if let Err(error) = image.write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            ) {
                output
                    .diagnostics
                    .push(ParseFailure::caused(FailureKind::Corrupt, error));
                output.coverage(
                    Some(image_anchor),
                    CoverageStatus::Failed,
                    CoverageReason::AssetEncodeFailed,
                );
                continue;
            }
            let id = output.assets.len() as u32;
            output.assets.push(Asset {
                id,
                media_type: "image/png".into(),
                sha256: digest(&bytes),
                bytes,
                width: Some(image.width()),
                height: Some(image.height()),
                derived_from: Some(digest(request.bytes)),
            });
            output.source_map.push(SourceMapEntry {
                target: Target::Asset { asset_id: id },
                anchor: image_anchor,
            });
        }
    }
    output
        .metadata
        .insert("format_parser".into(), "pdfium-render/0.9.4".into());
    Ok(output)
}
