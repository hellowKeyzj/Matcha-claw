mod ebook;
mod images;
mod office;

use std::any::Any;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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

static PDFIUM: OnceLock<Result<pdfium_render::prelude::Pdfium, String>> = OnceLock::new();
static PDFIUM_LOCK: Mutex<()> = Mutex::new(());
static RESOURCE_DIR_HINT: OnceLock<PathBuf> = OnceLock::new();

pub async fn read_source_text(path: PathBuf, include_images: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_guarded("read_source_text", || {
            read_source_text_blocking(&path, include_images)
        })
    })
    .await
    .map_err(|error| format!("read_source_text blocking task join error: {error}"))?
}

pub async fn preprocess_source(path: PathBuf) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        run_guarded("preprocess_source", || preprocess_source_blocking(&path))
    })
    .await
    .map_err(|error| format!("preprocess_source blocking task join error: {error}"))?
}

pub fn set_resource_dir_hint(dir: PathBuf) {
    let _ = RESOURCE_DIR_HINT.set(dir);
}

pub(crate) fn write_source_text_cache(path: &Path, text: &str) -> Result<(), String> {
    write_cache(path, text)
}

fn read_source_text_blocking(path: &Path, include_images: bool) -> Result<String, String> {
    let ext = extension(path);

    if let Some(cached) = read_cache(path) {
        return Ok(cached);
    }

    match ext.as_str() {
        "pdf" => extract_pdf_text(path, include_images),
        "org" => extract_org_text(path),
        e if OFFICE_EXTS.contains(&e) => office::extract_office_text(path_str(path)?, e),
        e if EBOOK_EXTS.contains(&e) => ebook::extract_ebook_text(path_str(path)?, e),
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
    let text = match ext.as_str() {
        "pdf" => extract_pdf_text(path, false)?,
        "org" => extract_org_text(path)?,
        e if OFFICE_EXTS.contains(&e) => office::extract_office_text(path_str(path)?, e)?,
        e if EBOOK_EXTS.contains(&e) => ebook::extract_ebook_text(path_str(path)?, e)?,
        _ => return Ok("no preprocessing needed".to_string()),
    };

    write_cache(path, &text)?;
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
    let original_modified = fs::metadata(original).ok()?.modified().ok()?;
    let cache_modified = fs::metadata(&cache_path).ok()?.modified().ok()?;
    if cache_modified >= original_modified {
        fs::read_to_string(&cache_path).ok()
    } else {
        None
    }
}

fn write_cache(original: &Path, text: &str) -> Result<(), String> {
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
    fs::write(&cache_path, text).map_err(|error| format!("Failed to write cache: {error}"))?;
    if uses_anydoc_cache(original) {
        mark_app_write_path(&format_path);
        fs::write(&format_path, OFFICE_CACHE_FORMAT).map_err(|error| {
            format!("Failed to write preprocessing cache format marker: {error}")
        })?;
    }
    Ok(())
}

fn extract_org_text(path: &Path) -> Result<String, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read Org file '{}': {}", path.display(), error))?;
    Ok(org_to_markdown(&content))
}

fn org_to_markdown(content: &str) -> String {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut output = Vec::new();
    let mut block_end: Option<&'static str> = None;

    for line in normalized.lines() {
        let trimmed = line.trim();
        let upper = trimmed.to_ascii_uppercase();
        if let Some(end) = block_end {
            if upper == end {
                output.push("```".to_string());
                block_end = None;
            } else {
                output.push(line.to_string());
            }
            continue;
        }

        if upper.starts_with("#+BEGIN_SRC") {
            let language = trimmed[11..].split_whitespace().next().unwrap_or("");
            output.push(format!("```{language}"));
            block_end = Some("#+END_SRC");
            continue;
        }
        if upper == "#+BEGIN_EXAMPLE" {
            output.push("```text".to_string());
            block_end = Some("#+END_EXAMPLE");
            continue;
        }
        if upper == "#+BEGIN_QUOTE" {
            output.push("```text".to_string());
            block_end = Some("#+END_QUOTE");
            continue;
        }

        if let Some((key, value)) = parse_org_keyword(trimmed) {
            if key == "TITLE" {
                output.push(format!("# {value}"));
            } else if !matches!(key.as_str(), "OPTIONS" | "PROPERTY" | "SETUPFILE") {
                output.push(format!("**{}:** {}", title_case_ascii(&key), value));
            }
            continue;
        }

        if let Some((level, heading)) = parse_org_heading(line) {
            output.push(format!(
                "{} {}",
                "#".repeat(level.min(6)),
                convert_org_links(heading)
            ));
            continue;
        }

        if trimmed.starts_with('|')
            && trimmed.ends_with('|')
            && trimmed.contains('+')
            && trimmed
                .chars()
                .all(|character| matches!(character, '|' | '+' | '-' | ':' | ' '))
        {
            output.push(trimmed.replace('+', "|"));
            continue;
        }

        output.push(convert_org_links(line));
    }
    if block_end.is_some() {
        output.push("```".to_string());
    }
    output.join("\n")
}

fn parse_org_keyword(line: &str) -> Option<(String, &str)> {
    let rest = line.strip_prefix("#+")?;
    let (key, value) = rest.split_once(':')?;
    if key.is_empty()
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return None;
    }
    Some((key.to_ascii_uppercase(), value.trim()))
}

fn parse_org_heading(line: &str) -> Option<(usize, &str)> {
    let stars = line
        .chars()
        .take_while(|character| *character == '*')
        .count();
    if stars == 0 || line.as_bytes().get(stars) != Some(&b' ') {
        return None;
    }
    Some((stars, line[stars + 1..].trim()))
}

fn title_case_ascii(value: &str) -> String {
    let lower = value.replace('_', " ").to_ascii_lowercase();
    let mut chars = lower.chars();
    chars
        .next()
        .map(|character| character.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_default()
}

fn convert_org_links(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        if let Some((target, description)) = inner.split_once("][") {
            out.push_str(&format!("[{}]({})", description, target));
        } else {
            out.push_str(&format!("<{}>", inner));
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

pub(super) fn lock_pdfium() -> std::sync::MutexGuard<'static, ()> {
    PDFIUM_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn pdfium_candidate_paths() -> Vec<String> {
    let mut paths = Vec::new();

    if let Ok(path) = std::env::var("PDFIUM_DYNAMIC_LIB_PATH") {
        paths.push(path);
    }

    if let Some(resource_dir) = RESOURCE_DIR_HINT.get() {
        push_pdfium_resource_candidates(&mut paths, resource_dir);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            push_pdfium_exe_candidates(&mut paths, exe_dir);
        }
    }

    paths
}

fn push_path(paths: &mut Vec<String>, path: PathBuf) {
    paths.push(path.to_string_lossy().into_owned());
}

fn push_pdfium_resource_candidates(paths: &mut Vec<String>, resource_dir: &Path) {
    #[cfg(target_os = "macos")]
    {
        push_path(paths, resource_dir.join("pdfium").join("libpdfium.dylib"));
        push_path(paths, resource_dir.join("libpdfium.dylib"));
    }
    #[cfg(target_os = "windows")]
    {
        push_path(paths, resource_dir.join("pdfium").join("pdfium.dll"));
        push_path(paths, resource_dir.join("pdfium").join("libpdfium.dll"));
        push_path(paths, resource_dir.join("pdfium.dll"));
        push_path(paths, resource_dir.join("libpdfium.dll"));
    }
    #[cfg(target_os = "linux")]
    {
        push_path(paths, resource_dir.join("pdfium").join("libpdfium.so"));
        push_path(paths, resource_dir.join("libpdfium.so"));
    }
}

fn push_pdfium_exe_candidates(paths: &mut Vec<String>, exe_dir: &Path) {
    #[cfg(target_os = "macos")]
    {
        push_path(paths, exe_dir.join("../Frameworks/libpdfium.dylib"));
        push_path(paths, exe_dir.join("../Resources/pdfium/libpdfium.dylib"));
        push_path(paths, exe_dir.join("../Resources/libpdfium.dylib"));
        push_path(paths, exe_dir.join("libpdfium.dylib"));
    }

    #[cfg(target_os = "windows")]
    {
        push_path(paths, exe_dir.join("pdfium.dll"));
        push_path(paths, exe_dir.join("pdfium").join("pdfium.dll"));
        push_path(paths, exe_dir.join("libpdfium.dll"));
        push_path(paths, exe_dir.join("resources").join("pdfium.dll"));
        push_path(
            paths,
            exe_dir.join("resources").join("pdfium").join("pdfium.dll"),
        );
    }

    #[cfg(target_os = "linux")]
    {
        push_path(paths, exe_dir.join("libpdfium.so"));
        push_path(paths, exe_dir.join("pdfium").join("libpdfium.so"));
        push_path(paths, exe_dir.join("resources").join("libpdfium.so"));
        push_path(
            paths,
            exe_dir
                .join("resources")
                .join("pdfium")
                .join("libpdfium.so"),
        );
        push_path(paths, exe_dir.join("../lib/libpdfium.so"));
    }
}

pub(super) fn pdfium() -> Result<&'static pdfium_render::prelude::Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            use pdfium_render::prelude::*;
            let candidates = pdfium_candidate_paths();
            for path in &candidates {
                if let Ok(bindings) = Pdfium::bind_to_library(path) {
                    eprintln!("[pdfium] loaded dynamic library from {path}");
                    return Ok(Pdfium::new(bindings));
                }
            }
            Pdfium::bind_to_system_library()
                .map(Pdfium::new)
                .map_err(|error| {
                    format!(
                        "Failed to locate Pdfium library. Tried: {} — and the system search path. Last error: {error}",
                        if candidates.is_empty() {
                            "(no candidates)".to_string()
                        } else {
                            candidates.join(", ")
                        }
                    )
                })
        })
        .as_ref()
        .map_err(|error| error.clone())
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
