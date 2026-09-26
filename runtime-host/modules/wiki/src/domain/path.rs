use std::path::{Component, Path, PathBuf};

use super::error::WikiFailure;

pub fn absolute_clean_path(path: &str) -> Result<PathBuf, WikiFailure> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(WikiFailure::invalid_input("path", "path is empty"));
    }
    Ok(PathBuf::from(trimmed))
}

pub fn safe_relative_path(path: &str) -> Result<PathBuf, WikiFailure> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }
    let candidate = Path::new(&trimmed);
    if candidate.is_absolute() {
        return Err(WikiFailure::invalid_path(path));
    }
    let mut clean = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return Err(WikiFailure::invalid_path(path)),
        }
    }
    Ok(clean)
}

pub fn resolve_project_path(root: &Path, relative_path: &str) -> Result<PathBuf, WikiFailure> {
    Ok(root.join(safe_relative_path(relative_path)?))
}

pub fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub fn project_id_for_root(root: &Path) -> String {
    let text = root.to_string_lossy();
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("wiki-{hash:016x}")
}

pub fn title_for_root(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Wiki")
        .to_owned()
}
