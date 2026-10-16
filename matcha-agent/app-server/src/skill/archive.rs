use std::io::{Cursor, Read};

use super::*;

pub(super) const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 2048;

pub(super) fn decode(bytes: Vec<u8>, slug: &str) -> rpc::Result<Bundle> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid())?;
    if archive.len() > MAX_ENTRIES {
        return Err(invalid());
    }
    let mut files = BTreeMap::new();
    let mut paths = BTreeSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| invalid())?;
        let name = entry.name().to_owned();
        let directory = entry.is_dir();
        let path = if directory {
            name.strip_suffix('/').ok_or_else(invalid)?
        } else {
            &name
        };
        if path.len() > 1024 {
            return Err(invalid());
        }
        resource_path(path)?;
        if !paths.insert(path.to_lowercase()) {
            return Err(invalid());
        }
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != if directory { 0o040000 } else { 0o100000 } {
                return Err(unsafe_link());
            }
        }
        if directory {
            continue;
        }
        total = total
            .checked_add(entry.size())
            .filter(|size| *size <= MAX_EXPANDED_BYTES)
            .ok_or_else(invalid)?;
        let limit = entry.size();
        let mut content = Vec::new();
        entry
            .by_ref()
            .take(limit + 1)
            .read_to_end(&mut content)
            .map_err(|_| invalid())?;
        if content.len() as u64 != limit {
            return Err(invalid());
        }
        files.insert(name, content);
    }
    // Accept a root bundle or one slug-named wrapper, never guess between bundles.
    if !files.contains_key("SKILL.md") {
        let prefix = format!("{slug}/");
        if !files.contains_key(&format!("{prefix}SKILL.md"))
            || files.keys().any(|path| !path.starts_with(&prefix))
        {
            return Err(invalid());
        }
        files = files
            .into_iter()
            .map(|(path, bytes)| (path[prefix.len()..].to_owned(), bytes))
            .collect();
    }
    let skill_md =
        String::from_utf8(files.remove("SKILL.md").ok_or_else(invalid)?).map_err(|_| invalid())?;
    let bundle = Bundle {
        skill_md,
        resources: files
            .into_iter()
            .map(|(path, bytes)| Resource { path, bytes })
            .collect(),
    };
    validate_bundle(&bundle)?;
    Ok(bundle)
}

fn invalid() -> Error {
    Error::invalid(
        "Skill archive must be a bounded ZIP of regular files with one SKILL.md and portable unique paths",
    )
}
