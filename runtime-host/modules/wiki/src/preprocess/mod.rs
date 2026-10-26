mod images;

use std::any::Any;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

pub use images::{
    ExtractOptions, ExtractedImage, SavedImage, extract_and_save_office_images,
    extract_and_save_pdf_images, extract_office_images, extract_pdf_images,
};

const OFFICE_EXTS: &[&str] = &[
    "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm", "xls", "xlsx",
    "xlsm", "xlsb", "odt", "ods", "odp", "rtf",
];
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif", "avif", "heic", "heif", "svg",
];
const MEDIA_EXTS: &[&str] = &[
    "mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "m4v", "mp3", "wav", "ogg", "flac", "aac",
    "m4a", "wma",
];
const EBOOK_EXTS: &[&str] = &["epub", "mobi"];
const LEGACY_DOC_EXTS: &[&str] = &["pages", "numbers", "key"];
const OFFICE_CACHE_FORMAT: &str = "anydoc-0.1.9-v2";

pub async fn read_source_text(path: PathBuf, include_images: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || read_source_text_guarded(&path, include_images))
        .await
        .map_err(|error| format!("read_source_text blocking task join error: {error}"))?
}

pub(crate) fn read_source_text_guarded(
    path: &Path,
    include_images: bool,
) -> Result<String, String> {
    run_guarded("read_source_text", || {
        read_source_text_blocking(path, include_images)
    })
}

pub async fn preprocess_source(path: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_guarded("preprocess_source", || preprocess_source_blocking(&path))
    })
    .await
    .map_err(|error| format!("preprocess_source blocking task join error: {error}"))?
}

pub fn set_resource_dir_hint(dir: PathBuf) {
    document_parser::set_resource_dir_hint(dir);
}

pub(crate) fn write_source_text_cache(
    path: &Path,
    text: &str,
    source_revision: &str,
) -> Result<(), String> {
    write_cache(path, text, source_revision)
}

fn read_source_text_blocking(path: &Path, include_images: bool) -> Result<String, String> {
    let ext = extension(path);

    if let Some(cached) = read_cache(path) {
        return Ok(cached);
    }

    match ext.as_str() {
        "pdf" => extract_pdf_text(path, include_images),
        "org" => extract_org_text(path),
        e if OFFICE_EXTS.contains(&e) => parse_markdown(path, e),
        e if EBOOK_EXTS.contains(&e) => parse_markdown(path, e),
        e if IMAGE_EXTS.contains(&e) => {
            let size = fs::metadata(path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            Ok(format!(
                "[Image: {} ({:.1} KB)]",
                file_label(path),
                size as f64 / 1024.0
            ))
        }
        e if MEDIA_EXTS.contains(&e) => {
            let size = fs::metadata(path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            Ok(format!(
                "[Media: {} ({:.1} MB)]",
                file_label(path),
                size as f64 / 1048576.0
            ))
        }
        e if LEGACY_DOC_EXTS.contains(&e) => Ok(format!(
            "[Document: {} — text extraction not supported for .{} format]",
            file_label(path),
            e
        )),
        _ => match fs::read_to_string(path) {
            Ok(content) => Ok(content),
            Err(_) if !path.exists() => Err(format!("File does not exist: '{}'", path.display())),
            Err(error) => Err(format!(
                "Failed to read file '{}' as text: {} (likely binary, locked, or non-UTF-8)",
                path.display(),
                error,
            )),
        },
    }
}

fn preprocess_source_blocking(path: &Path) -> Result<String, String> {
    let ext = extension(path);
    if !matches!(ext.as_str(), "pdf" | "org")
        && !OFFICE_EXTS.contains(&ext.as_str())
        && !EBOOK_EXTS.contains(&ext.as_str())
    {
        return Ok("no preprocessing needed".to_string());
    }
    let source_revision = source_revision(path)?;
    let text = match ext.as_str() {
        "pdf" => extract_pdf_text(path, false)?,
        "org" => extract_org_text(path)?,
        e if OFFICE_EXTS.contains(&e) => parse_markdown(path, e)?,
        e if EBOOK_EXTS.contains(&e) => parse_markdown(path, e)?,
        _ => return Ok("no preprocessing needed".to_string()),
    };

    write_cache(path, &text, &source_revision)?;
    Ok(text)
}

fn cache_path_for(original: &Path) -> PathBuf {
    let parent = original.parent().unwrap_or(Path::new("."));
    let cache_dir = parent.join(".cache");
    let file_name = original.file_name().unwrap_or_default().to_string_lossy();
    cache_dir.join(format!("{}.txt", file_name))
}

fn cache_format_path_for(original: &Path) -> PathBuf {
    let cache_path = cache_path_for(original);
    cache_path.with_extension("txt.parser")
}

fn uses_anydoc_cache(original: &Path) -> bool {
    original
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            let extension = extension.to_ascii_lowercase();
            OFFICE_EXTS.contains(&extension.as_str())
        })
        .unwrap_or(false)
}

fn read_cache(original: &Path) -> Option<String> {
    let cache_path = cache_path_for(original);
    if uses_anydoc_cache(original)
        && fs::read_to_string(cache_format_path_for(original))
            .ok()?
            .trim()
            != OFFICE_CACHE_FORMAT
    {
        return None;
    }
    let cached = fs::read_to_string(&cache_path).ok()?;
    let (header, text) = cached.split_once('\n')?;
    let revision = header
        .strip_prefix("<!-- wiki-source-revision:")?
        .strip_suffix(" -->")?;
    (source_revision(original).ok()? == revision).then(|| text.to_owned())
}

fn source_revision(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| crate::domain::stable_content_hash(&bytes))
        .map_err(|error| format!("Failed to read preprocessing source: {error}"))
}

fn write_cache(original: &Path, text: &str, revision: &str) -> Result<(), String> {
    if source_revision(original)? != revision {
        return Err(
            "Source changed during preprocessing; cached result was not published".to_owned(),
        );
    }
    let cache_path = cache_path_for(original);
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create preprocessing cache directory: {error}"))?;
    }
    mark_app_write_path(&cache_path);
    let format_path = cache_format_path_for(original);
    if uses_anydoc_cache(original) {
        let _ = fs::remove_file(&format_path);
    }
    let cached = format!("<!-- wiki-source-revision:{revision} -->\n{text}");
    crate::history::write_store(&cache_path, cached.as_bytes())
        .map_err(|_| "Failed to write preprocessing cache".to_owned())?;
    if uses_anydoc_cache(original) {
        mark_app_write_path(&format_path);
        fs::write(&format_path, OFFICE_CACHE_FORMAT).map_err(|error| {
            format!("Failed to write preprocessing cache format marker: {error}")
        })?;
    }
    Ok(())
}

fn extract_org_text(path: &Path) -> Result<String, String> {
    parse_markdown(path, "org")
}

fn parse_markdown(path: &Path, extension: &str) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read preprocessing source: {error}"))?;
    let options = document_parser::ParseOptions {
        extract_assets: false,
        ..Default::default()
    };
    let document = document_parser::parse(document_parser::ParseRequest {
        bytes: &bytes,
        extension,
        display_name: path.file_name().and_then(|name| name.to_str()),
        options: &options,
        cancellation: None,
    })
    .map_err(|error| error.to_string())?;
    if EBOOK_EXTS.contains(&extension) && document.blocks.is_empty() {
        return Err(format!(
            "{} contains no extractable text",
            extension.to_ascii_uppercase()
        ));
    }
    if document.markdown.is_empty() {
        let empty = match extension {
            "doc" => Some("[Document: no extractable text found in .doc file]"),
            "docx" => Some("[Could not extract structured text from DOCX]"),
            "pptx" => Some("[Could not extract text from PPTX]"),
            "xls" | "xlsx" | "ods" => Some("[Could not extract data from spreadsheet]"),
            "odt" | "odp" => Some("[Could not extract text from this file]"),
            _ => None,
        };
        if let Some(empty) = empty {
            return Ok(empty.to_owned());
        }
    }
    Ok(document.markdown)
}

fn extract_pdf_text(path: &Path, include_images: bool) -> Result<String, String> {
    if include_images {
        let parent = path.parent();
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("")
            .to_string();

        let parent_is_sources = parent.map(|dir| dir.ends_with("sources")).unwrap_or(false);
        let raw_dir = parent.and_then(|dir| dir.parent());
        let raw_is_raw = raw_dir.map(|dir| dir.ends_with("raw")).unwrap_or(false);
        let project_root = if parent_is_sources && raw_is_raw {
            raw_dir.and_then(|dir| dir.parent())
        } else {
            None
        };

        if let Some(root) = project_root {
            if !stem.is_empty() {
                let media_dir = root.join("wiki").join("media").join(&stem);
                let url_prefix = media_dir.to_string_lossy().replace('\\', "/");
                return images::extract_pdf_markdown(
                    path_str(path)?,
                    Some(&media_dir),
                    &url_prefix,
                    &images::ExtractOptions::default(),
                );
            }
        }
    }

    images::extract_pdf_markdown(
        path_str(path)?,
        None,
        "",
        &images::ExtractOptions::default(),
    )
}

fn run_guarded<T, F>(label: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(result) => result,
        Err(payload) => Err(report_panic(label, payload)),
    }
}

fn report_panic(label: &str, payload: Box<dyn Any + Send>) -> String {
    let message = if let Some(value) = payload.downcast_ref::<String>() {
        value.clone()
    } else if let Some(value) = payload.downcast_ref::<&str>() {
        (*value).to_string()
    } else {
        "(non-string panic payload)".to_string()
    };
    eprintln!("[preprocess_guard] '{label}' panicked: {message}");
    format!("Internal error in {label}: {message}")
}

pub(super) fn mark_app_write_path(_path: &Path) {}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

fn path_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("Path is not valid UTF-8: '{}'", path.display()))
}
