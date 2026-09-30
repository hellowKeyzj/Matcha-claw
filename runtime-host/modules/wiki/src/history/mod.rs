mod model;
mod store;

use std::{fs, path::Path, sync::Mutex};

use crate::domain::{
    WikiFailure, WikiReadReceipt, WikiRevision, resolve_project_path, system_time_ms,
};

pub use model::{
    WikiFileHistoryEntry, WikiFileHistoryInput, WikiFileHistoryReceipt, WikiFileHistorySettings,
    WikiFileHistorySettingsInput, WikiFileHistoryStats, WikiRestoreFileHistoryInput,
};

// ponytail: serialize the bounded history store; use per-project locks if contention is measured.
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn list(root: &Path, path: &str) -> Result<Vec<WikiFileHistoryEntry>, WikiFailure> {
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| WikiFailure::state("File history lock unavailable"))?;
    let root = store::checked_root(root)?;
    let file = store::checked_file(&root, path)?;
    store::directory(&root, false)?;
    let mut entries = store::read_entries(&store::history_path(&root, &file)?)?;
    entries.reverse();
    Ok(entries)
}

pub(crate) fn settings(root: &Path) -> Result<WikiFileHistorySettings, WikiFailure> {
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| WikiFailure::state("File history lock unavailable"))?;
    let root = store::checked_root(root)?;
    Ok(store::read_settings(&root)?.unwrap_or_default())
}

pub(crate) fn update_settings(
    root: &Path,
    settings: WikiFileHistorySettings,
) -> Result<WikiFileHistorySettings, WikiFailure> {
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| WikiFailure::state("File history lock unavailable"))?;
    let root = store::checked_root(root)?;
    let mut settings = settings.normalized();
    if settings.enabled && settings.max_versions_per_file == 0 {
        settings.max_versions_per_file = WikiFileHistorySettings::default().max_versions_per_file;
    }
    let previous = store::read_settings(&root)?;
    store::write_settings(&root, &settings)?;
    if previous
        .is_none_or(|previous| settings.max_versions_per_file < previous.max_versions_per_file)
    {
        store::prune_entries(&root, settings.max_versions_per_file)?;
    }
    Ok(settings)
}

pub(crate) fn stats(root: &Path) -> Result<WikiFileHistoryStats, WikiFailure> {
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| WikiFailure::state("File history lock unavailable"))?;
    let root = store::checked_root(root)?;
    let files = store::files(&root)?;
    let mut stats = WikiFileHistoryStats {
        bytes: files.iter().map(|(_, bytes, _)| *bytes).sum(),
        files: files.len(),
        entries: 0,
    };
    for (path, _, _) in files {
        stats.entries += store::read_entries(&path)?.len();
    }
    Ok(stats)
}

pub(crate) fn clear(root: &Path) -> Result<(), WikiFailure> {
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| WikiFailure::state("File history lock unavailable"))?;
    store::clear(&store::checked_root(root)?)
}

pub(crate) fn record(root: &Path, path: &str, author: &str, tool: &str) -> Result<(), WikiFailure> {
    let candidate = resolve_project_path(root, path)?;
    let relative = candidate.strip_prefix(root).expect("resolved project path");
    if relative.starts_with(".llm-wiki") {
        return Ok(());
    }
    match fs::symlink_metadata(root.join(".llm-wiki")) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(store::io(root, error)),
    }
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| WikiFailure::state("File history lock unavailable"))?;
    let root = store::checked_root(root)?;
    let settings = store::read_settings(&root)?.unwrap_or_default();
    if !settings.enabled || settings.max_versions_per_file == 0 {
        return Ok(());
    }
    let candidate = resolve_project_path(&root, path)?;
    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(store::io(&candidate, error)),
    };
    if metadata.file_type().is_symlink() {
        return Err(WikiFailure::invalid_path(path));
    }
    if !metadata.is_file() || metadata.len() > store::MAX_CONTENT_BYTES {
        return Ok(());
    }
    let file = store::checked_file(&root, path)?;
    let bytes = fs::read(&file).map_err(|error| store::io(&file, error))?;
    if bytes.len() as u64 > store::MAX_CONTENT_BYTES {
        return Ok(());
    }
    let Ok(content) = String::from_utf8(bytes) else {
        return Ok(());
    };
    store::directory(&root, true)?;
    let history_path = store::history_path(&root, &file)?;
    let mut entries = store::read_entries(&history_path)?;
    if entries.last().is_some_and(|entry| entry.content == content) {
        return Ok(());
    }
    entries.push(store::entry(
        store::relative_path(&root, &file),
        author,
        tool,
        content,
    ));
    store::retain(&mut entries, settings.max_versions_per_file);
    store::write_entries(&history_path, &entries)?;
    store::prune_store(&root, &history_path)
}

pub(crate) fn restore(
    root: &Path,
    path: &str,
    version_id: &str,
) -> Result<WikiReadReceipt, WikiFailure> {
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| WikiFailure::state("File history lock unavailable"))?;
    let root = store::checked_root(root)?;
    let file = store::checked_file(&root, path)?;
    store::directory(&root, false)?;
    let history_path = store::history_path(&root, &file)?;
    let mut entries = store::read_entries(&history_path)?;
    let selected = entries
        .iter()
        .find(|entry| entry.id == version_id)
        .cloned()
        .ok_or_else(|| WikiFailure::invalid_input("versionId", "History entry not found"))?;
    let current = fs::read(&file).map_err(|error| store::io(&file, error))?;
    if current.len() as u64 > store::MAX_CONTENT_BYTES {
        return Err(WikiFailure::invalid_input(
            "path",
            "Current file is too large to back up safely before restore (maximum 524288 bytes)",
        ));
    }
    let current = String::from_utf8(current).map_err(|_| WikiFailure::NotText {
        path: path.to_owned(),
    })?;
    let relative = store::relative_path(&root, &file);
    if current != selected.content && !entries.last().is_some_and(|entry| entry.content == current)
    {
        entries.push(store::entry(
            relative.clone(),
            "human",
            "before.history.restore",
            current,
        ));
        let retention = store::read_settings(&root)?
            .unwrap_or_default()
            .max_versions_per_file
            .max(1);
        store::retain(&mut entries, retention);
        store::write_entries(&history_path, &entries)?;
        store::prune_store(&root, &history_path)?;
    }
    fs::write(&file, selected.content.as_bytes()).map_err(|error| store::io(&file, error))?;
    let metadata = fs::metadata(&file).map_err(|error| store::io(&file, error))?;
    let revision = WikiRevision::for_bytes(
        selected.content.as_bytes(),
        metadata.modified().map(system_time_ms).unwrap_or_default(),
    );
    Ok(WikiReadReceipt::new(relative, selected.content, revision))
}
