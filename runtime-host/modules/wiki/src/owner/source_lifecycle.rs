use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use chrono::Local;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio_util::sync::CancellationToken;

use crate::{
    application::commands::{WikiSourceTaskRunPlan, WikiStagedImportSource},
    domain::{
        RAW_SOURCES_DIR, WIKI_MEDIA_DIR, WIKI_SOURCES_DIR, WikiApplyGeneratedPagesInput,
        WikiApplyGeneratedPagesReceipt, WikiDeleteSourceInput, WikiDeleteSourceReceipt,
        WikiFailure, WikiProjectSelector, WikiRevision, WikiSourceMoveReceipt, WikiSourceTask,
        WikiSourceTaskKind, WikiSourceTaskStatus, WikiSourceTasksReceipt, WikiSourceWatchConfig,
        WikiWriteReceipt, normalize_relative_path, now_ms, resolve_project_path,
        stable_content_hash, system_time_ms,
    },
    ingest::{parser::is_safe_ingest_path, prompts, write as ingest_write},
    ports::{
        WikiIngestLlm, WikiIngestLlmMessage, WikiIngestLlmModelLimits, WikiIngestLlmOptions,
        WikiIngestLlmRequest, WikiIngestLlmRole,
    },
};

const FILE_SNAPSHOT: &str = ".llm-wiki/file-snapshot.json";
const FILE_CHANGE_QUEUE: &str = ".llm-wiki/file-change-queue.json";
pub(super) const SOURCE_TASKS_FILE: &str = ".llm-wiki/source-tasks.json";
const SOURCE_TASKS_LOCK_FILE: &str = ".llm-wiki/source-tasks.lock";
pub(super) const SOURCE_CACHE_FILE: &str = ".llm-wiki/source-cache.json";
pub(super) const RAW_PARSED_DIR: &str = "raw/parsed";
const SOURCE_WATCH_CONFIG_FILE: &str = ".llm-wiki/source-watch-config.json";
const INGEST_WARNINGS_LOG: &str = ".llm-wiki/ingest-warnings.log";
pub(super) const INGESTABLE_SOURCE_EXTENSIONS: &[&str] = &[
    "md", "mdx", "txt", "org", "pdf", "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm",
    "ppsx", "ppsm", "xls", "xlsx", "xlsm", "xlsb", "odt", "odp", "ods", "rtf", "html", "htm",
    "csv", "json", "xml", "yaml", "yml", "epub", "mobi",
];
pub(super) const DEFAULT_WATCH_INCLUDE_EXTENSIONS: &[&str] = &[
    "md", "mdx", "txt", "org", "pdf", "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm",
    "ppsx", "ppsm", "xls", "xlsx", "xlsm", "xlsb", "odt", "odp", "ods", "rtf", "html", "htm",
    "csv",
];
pub(super) const DEFAULT_WATCH_EXCLUDE_EXTENSIONS: &[&str] = &[
    "tmp",
    "temp",
    "bak",
    "swp",
    "part",
    "partial",
    "crdownload",
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "iso",
    "dmg",
];
pub(super) const DEFAULT_WATCH_EXCLUDE_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    ".obsidian",
    ".idea",
    ".vscode",
    "node_modules",
    ".cache",
    "__pycache__",
];
pub(super) const DEFAULT_WATCH_EXCLUDE_GLOBS: &[&str] =
    &["~$*", ".~lock.*#", "*.draft.*", "draft-*", "*.private.*"];
pub(super) const DEFAULT_WATCH_MAX_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceCache {
    pub entries: BTreeMap<String, SourceCacheEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceCacheEntry {
    pub hash: String,
    pub timestamp: u64,
    pub files_written: Vec<String>,
}

pub(super) fn staged_raw_source(
    project_id: &str,
    root: &Path,
    source_path: PathBuf,
    source_relative_path: String,
    task_kind: WikiSourceTaskKind,
) -> Result<WikiStagedImportSource, WikiFailure> {
    let source_identity = source_identity(&source_relative_path).to_owned();
    let slug = source_summary_slug(&source_identity);
    Ok(WikiStagedImportSource {
        project_id: project_id.to_owned(),
        project_root: root.to_path_buf(),
        import_id: slug.clone(),
        source_path,
        source_relative_path,
        source_identity,
        page_relative_path: format!("{WIKI_SOURCES_DIR}/{slug}.md"),
        task_kind,
        task_id: String::new(),
        execution: None,
    })
}

pub(super) fn source_identity(source_relative_path: &str) -> &str {
    source_relative_path
        .strip_prefix("raw/sources/")
        .unwrap_or(source_relative_path)
}

pub(super) fn source_reference_identity(source_reference: &str) -> String {
    let normalized = source_reference.trim().replace('\\', "/");
    let key = normalized.to_ascii_lowercase();
    if key.starts_with("raw/sources/") {
        return normalized["raw/sources/".len()..].to_owned();
    }
    if let Some(index) = key.find("/raw/sources/") {
        return normalized[index + "/raw/sources/".len()..].to_owned();
    }
    normalized
}

pub(super) fn source_summary_slug(identity: &str) -> String {
    let without_ext = identity.trim_end_matches(extension_suffix(identity));
    let parts = without_ext
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() <= 1 {
        return parts.first().copied().unwrap_or("source").to_owned();
    }

    let hash = stable_slug_hash(identity);
    let mut slug = parts
        .iter()
        .map(|part| {
            let readable = readable_slug_part(part);
            format!("{}-{readable}", readable.chars().count().max(1))
        })
        .collect::<Vec<_>>()
        .join("--");
    slug.push_str("--");
    slug.push_str(&hash);
    if slug.len() <= 120 {
        return slug;
    }
    let readable_limit = 120usize.saturating_sub(hash.len() + 2);
    let prefix = slug[..slug.len().min(readable_limit)]
        .trim_end_matches('-')
        .to_owned();
    format!(
        "{}--{hash}",
        if prefix.is_empty() { "source" } else { &prefix }
    )
}

pub(super) fn source_content_hash(text: &str) -> String {
    stable_content_hash(text.as_bytes())
}

pub(super) fn is_ingestable_source_path(relative_path: &str, watch_include: bool) -> bool {
    let normalized = relative_path.replace('\\', "/");
    let path = Path::new(&normalized);
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return false;
    };
    let extension = extension.to_ascii_lowercase();
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
        || normalized.contains("/.cache/")
    {
        return false;
    }
    let allowed = if watch_include {
        DEFAULT_WATCH_INCLUDE_EXTENSIONS
    } else {
        INGESTABLE_SOURCE_EXTENSIONS
    };
    allowed.contains(&extension.as_str())
}

pub(super) fn is_default_watch_allowed_source_path(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/");
    if !normalized.starts_with("raw/sources/") || !is_ingestable_source_path(&normalized, true) {
        return false;
    }
    source_watch_path_allowed(&normalized)
}

pub(super) fn is_default_watch_tracked_file(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/");
    if is_snapshot_ignored(&normalized) || !source_watch_path_allowed(&normalized) {
        return false;
    }
    normalized == "purpose.md"
        || normalized == "schema.md"
        || (normalized.starts_with("wiki/") && normalized.ends_with(".md"))
        || is_default_watch_allowed_source_path(&normalized)
}

pub(super) fn is_default_watch_descend_dir(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/");
    if normalized.is_empty() {
        return true;
    }
    if is_snapshot_ignored(&normalized)
        || normalized
            .split('/')
            .any(|part| DEFAULT_WATCH_EXCLUDE_DIRS.contains(&part))
    {
        return false;
    }
    normalized == "raw"
        || normalized == "raw/sources"
        || normalized.starts_with("raw/sources/")
        || normalized == "wiki"
        || normalized.starts_with("wiki/")
}

pub(super) fn is_deleted_wiki_page_path(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    if !lower.starts_with("wiki/") || !lower.ends_with(".md") || lower.starts_with("wiki/media/") {
        return false;
    }
    !matches!(
        Path::new(&lower).file_name().and_then(|name| name.to_str()),
        Some("index.md" | "log.md" | "overview.md")
    )
}

fn source_watch_path_allowed(normalized: &str) -> bool {
    let path = Path::new(normalized);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if name.is_empty() || name.starts_with('.') {
        return false;
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if DEFAULT_WATCH_EXCLUDE_EXTENSIONS.contains(&extension.as_str()) {
        return false;
    }
    if normalized
        .split('/')
        .any(|part| DEFAULT_WATCH_EXCLUDE_DIRS.contains(&part))
    {
        return false;
    }
    !DEFAULT_WATCH_EXCLUDE_GLOBS
        .iter()
        .any(|pattern| glob_match(pattern, normalized) || glob_match(pattern, name))
}

pub(super) fn is_deleted_raw_source_path(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/");
    normalized.starts_with("raw/sources/")
        && !normalized.contains("/.cache/")
        && Path::new(&normalized)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| !name.starts_with('.'))
}

pub(super) fn is_sensitive_config_source_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "env" | "json" | "toml" | "yaml" | "yml" | "xml"
    ) && path.components().any(|component| {
        let part = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        matches!(
            part.as_str(),
            ".claude" | ".codex" | ".cursor" | ".gemini" | ".mcp"
        )
    })
}

pub(super) fn collect_regular_files(
    directory: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), WikiFailure> {
    for entry in std::fs::read_dir(directory)
        .map_err(|error| WikiFailure::io(path_text(directory), error))?
    {
        let entry = entry.map_err(|error| WikiFailure::io(path_text(directory), error))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| WikiFailure::io(path_text(&path), error))?;
        if metadata.is_dir() {
            collect_regular_files(&path, out)?;
        } else if metadata.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

pub(super) fn identify_source_moves(
    deleted: &[(String, String, u64)],
    created_or_modified: &[(String, WikiSourceTaskKind)],
    current_entries: &BTreeMap<String, (String, u64)>,
) -> Vec<(String, String)> {
    let mut deleted_by_hash: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (path, revision, size) in deleted {
        if *size >= 32 && !revision.is_empty() {
            deleted_by_hash.entry(revision).or_default().push(path);
        }
    }
    let mut created_by_hash: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (path, kind) in created_or_modified {
        if !matches!(kind, WikiSourceTaskKind::Created) {
            continue;
        }
        if let Some((revision, size)) = current_entries.get(path) {
            if *size >= 32 && !revision.is_empty() {
                created_by_hash.entry(revision).or_default().push(path);
            }
        }
    }
    deleted_by_hash
        .into_iter()
        .filter_map(|(hash, old_paths)| {
            let new_paths = created_by_hash.get(hash)?;
            (old_paths.len() == 1 && new_paths.len() == 1)
                .then(|| (old_paths[0].to_owned(), new_paths[0].to_owned()))
        })
        .collect()
}

pub(super) fn read_source_cache(root: &Path) -> Result<SourceCache, WikiFailure> {
    read_json(root.join(SOURCE_CACHE_FILE))
}

pub(super) fn write_source_cache_entry(
    root: &Path,
    identity: &str,
    entry: SourceCacheEntry,
) -> Result<(), WikiFailure> {
    let mut cache = read_source_cache(root)?;
    cache.entries.insert(identity.to_owned(), entry);
    write_json(root.join(SOURCE_CACHE_FILE), &cache)
}

pub(super) fn remove_source_cache_entry(root: &Path, identity: &str) -> Result<(), WikiFailure> {
    let mut cache = read_source_cache(root)?;
    cache.entries.remove(identity);
    if let Some(base) = Path::new(identity)
        .file_name()
        .and_then(|name| name.to_str())
    {
        cache.entries.remove(base);
    }
    write_json(root.join(SOURCE_CACHE_FILE), &cache)
}

pub(super) fn move_source_cache_entry(
    root: &Path,
    old_identity: &str,
    new_identity: &str,
    moved_summary: Option<(&str, &str)>,
) -> Result<(), WikiFailure> {
    let mut cache = read_source_cache(root)?;
    if let Some(mut entry) = cache.entries.remove(old_identity) {
        if let Some((old_path, new_path)) = moved_summary {
            for written in &mut entry.files_written {
                if written == old_path {
                    *written = new_path.to_owned();
                }
            }
        }
        cache.entries.insert(new_identity.to_owned(), entry);
    }
    write_json(root.join(SOURCE_CACHE_FILE), &cache)
}

pub(super) fn append_source_tasks(
    root: &Path,
    project_id: &str,
    imports: &mut [WikiStagedImportSource],
    execute: bool,
) -> Result<(), WikiFailure> {
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    recover_source_tasks_unlocked(root, &mut tasks)?;
    for import in imports {
        let lock = super::source_execution::try_source_execution_lock(root, &import.source_relative_path)?
            .ok_or_else(|| WikiFailure::state("source already has an active execution"))?;
        let now = now_ms();
        let task_id = unique_source_task_id(&tasks, project_id, &import.source_relative_path, now);
        tasks.retain(|task| !(task.project_id() == project_id
            && task.source_path() == import.source_relative_path && task_is_open(task)));
        let mut task = WikiSourceTask::new(
            task_id,
            project_id.to_owned(),
            import.source_relative_path.clone(),
            import.task_kind.clone(),
            WikiSourceTaskStatus::Pending,
            now, now, 0, None,
        );
        import.task_id = task.id().to_owned();
        if execute {
            task.mark_pending(Some("queued".to_owned()));
            import.execution = Some(super::source_execution::SourceExecution::new(lock, root, import.task_id.clone()));
        }
        tasks.push(task);
    }
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)
}

pub(super) fn append_source_task_paths(
    root: &Path,
    project_id: &str,
    paths: &[String],
    kind: WikiSourceTaskKind,
) -> Result<(), WikiFailure> {
    if paths.is_empty() {
        return Ok(());
    }
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    let now = now_ms();
    for source_path in paths {
        let _execution_lock = super::source_execution::try_source_execution_lock(root, source_path)?
            .ok_or_else(|| WikiFailure::state("source already has an active execution"))?;
        upsert_source_task(&mut tasks, project_id, source_path, kind.clone(), now);
    }
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)
}

fn upsert_source_task(
    tasks: &mut Vec<WikiSourceTask>,
    project_id: &str,
    source_path: &str,
    kind: WikiSourceTaskKind,
    now: u64,
) {
    let task_id = unique_source_task_id(tasks, project_id, source_path, now);
    tasks.retain(|task| !(task.project_id() == project_id && task.source_path() == source_path && task_is_open(task)));
    tasks.push(WikiSourceTask::new(
        task_id,
        project_id.to_owned(),
        source_path.to_owned(),
        kind,
        WikiSourceTaskStatus::Pending,
        now,
        now,
        0,
        None,
    ));
}

pub(super) fn begin_generated_source_execution(
    root: &Path,
    project_id: &str,
    source_path: &str,
) -> Result<Arc<super::source_execution::SourceExecution>, WikiFailure> {
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    recover_source_tasks_unlocked(root, &mut tasks)?;
    let lock = super::source_execution::try_source_execution_lock(root, source_path)?
        .ok_or_else(|| WikiFailure::state("source already has an active execution"))?;
    let task_id = match latest_source_task_mut(&mut tasks, project_id, source_path) {
        Some(task) if task.is_paused() => return Err(WikiFailure::cancelled()),
        Some(task) if task_is_open(task) => {
            task.mark_pending(Some("queued".to_owned()));
            task.id().to_owned()
        }
        _ => {
            let now = now_ms();
            let task_id = unique_source_task_id(&tasks, project_id, source_path, now);
            let mut task = WikiSourceTask::new(task_id.clone(), project_id.to_owned(), source_path.to_owned(),
                WikiSourceTaskKind::Generated, WikiSourceTaskStatus::Pending, now, now, 0, None);
            task.mark_pending(Some("queued".to_owned()));
            tasks.push(task);
            task_id
        }
    };
    let execution = super::source_execution::SourceExecution::new(lock, root, task_id);
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)?;
    Ok(execution)
}

pub(super) fn mark_source_task_running(
    root: &Path,
    task_id: &str,
    stage: &str,
    counts: Option<(usize, usize)>,
) -> Result<(), WikiFailure> {
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    let task = tasks.iter_mut().find(|task| task.id() == task_id)
        .ok_or_else(|| WikiFailure::state("source task no longer exists"))?;
    if !task_is_active(task) || task.is_paused() || task.cancel_requested() {
        return Err(WikiFailure::cancelled());
    }
    task.mark_running(stage, counts);
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)
}

pub(super) fn source_task_cancel_requested(
    root: &Path,
    task_id: &str,
) -> Result<bool, WikiFailure> {
    let _tasks_lock = lock_source_tasks(root)?;
    Ok(read_source_tasks_unlocked(root)?.iter().find(|task| task.id() == task_id)
        .is_none_or(|task| task.is_paused() || task.cancel_requested()
            || task.status() == &WikiSourceTaskStatus::Cancelled))
}

pub(super) fn request_source_task_cancel(
    root: &Path,
    project_id: &str,
    source_relative_path: &str,
) -> Result<WikiSourceTasksReceipt, WikiFailure> {
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    if let Some(task) = latest_source_task_mut(&mut tasks, project_id, source_relative_path)
        && task_is_active(task)
    {
        if super::source_execution::try_source_execution_lock(root, task.source_path())?.is_none() {
            task.request_cancel();
        } else {
            task.mark_cancelled();
        }
    }
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)?;
    drop(_tasks_lock);
    source_tasks(
        root,
        WikiProjectSelector {
            project_id: Some(project_id.to_owned()),
        },
    )
}

fn lock_source_mutations(root: &Path, project_id: &str, paths: &[&str]) -> Result<(Vec<std::fs::File>, Option<String>), WikiFailure> {
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    let mut locks = Vec::new();
    for path in paths.iter().copied().collect::<BTreeSet<_>>() {
        locks.push(super::source_execution::try_source_execution_lock(root, path)?
            .ok_or_else(|| WikiFailure::state("source already has an active execution"))?);
    }
    let task_id = paths.last().and_then(|path| latest_source_task_mut(&mut tasks, project_id, path))
        .map(|task| task.id().to_owned());
    Ok((locks, task_id))
}

fn mark_source_task_done(
    root: &Path,
    task_id: Option<&str>,
) -> Result<(), WikiFailure> {
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    if let Some(task) = tasks.iter_mut().find(|task| Some(task.id()) == task_id)
        && task_is_open(task)
        && !task.is_paused()
    {
        task.mark_done();
    }
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)
}

pub(super) fn finish_source_execution(
    root: &Path,
    task_id: &str,
    error: Option<&WikiFailure>,
) -> Result<(), WikiFailure> {
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    let task = tasks.iter_mut().find(|task| task.id() == task_id)
        .ok_or_else(|| WikiFailure::state("source task no longer exists"))?;
    if !task_is_active(task) {
        return Ok(());
    }
    let cancelled = task.is_paused() || task.cancel_requested()
        || error.is_some_and(WikiFailure::is_cancelled);
    if !task.is_paused() {
        if cancelled {
            task.mark_cancelled();
        } else if let Some(error) = error {
            task.mark_failed(format!("{error:?}"));
        } else {
            task.mark_done();
        }
    }
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)?;
    if cancelled && error.is_none() {
        return Err(WikiFailure::cancelled());
    }
    Ok(())
}

pub(super) fn retry_source_task(
    root: &Path,
    project_id: &str,
    source_path: &str,
) -> Result<WikiSourceTaskRunPlan, WikiFailure> {
    update_source_task_for_run(root, project_id, source_path, |task| {
        matches!(
            task.status(),
            WikiSourceTaskStatus::Failed | WikiSourceTaskStatus::Cancelled
        )
    })
}

pub(super) fn resume_source_task(
    root: &Path,
    project_id: &str,
    source_path: &str,
) -> Result<WikiSourceTaskRunPlan, WikiFailure> {
    update_source_task_for_run(root, project_id, source_path, WikiSourceTask::is_paused)
}

pub(super) fn pause_source_task(
    root: &Path,
    project_id: &str,
    source_path: &str,
) -> Result<WikiSourceTasksReceipt, WikiFailure> {
    let source_relative_path = source_relative_path(root, source_path)?;
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    if let Some(task) = latest_source_task_mut(&mut tasks, project_id, &source_relative_path)
        && matches!(
            task.status(),
            WikiSourceTaskStatus::Pending | WikiSourceTaskStatus::Running
        )
    {
        task.pause();
    }
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)?;
    drop(_tasks_lock);
    source_tasks(
        root,
        WikiProjectSelector {
            project_id: Some(project_id.to_owned()),
        },
    )
}

pub(super) fn reorder_source_task(
    root: &Path,
    project_id: &str,
    source_path: &str,
    before_source_path: Option<&str>,
    after_source_path: Option<&str>,
) -> Result<WikiSourceTasksReceipt, WikiFailure> {
    let relative_source_path = source_relative_path(root, source_path)?;
    let before = before_source_path
        .map(|path| source_relative_path(root, path))
        .transpose()?;
    let after = after_source_path
        .map(|path| source_relative_path(root, path))
        .transpose()?;
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    let Some(current_index) = tasks.iter().position(|task| {
        task.project_id() == project_id
            && task.source_path() == relative_source_path
            && task.status() == &WikiSourceTaskStatus::Pending
            && !task.is_paused()
    }) else {
        drop(_tasks_lock);
        return source_tasks(
            root,
            WikiProjectSelector {
                project_id: Some(project_id.to_owned()),
            },
        );
    };
    let task = tasks.remove(current_index);
    let insert_index = if let Some(before) = before {
        tasks
            .iter()
            .position(|task| {
                task.project_id() == project_id
                    && task.source_path() == before
                    && task.status() == &WikiSourceTaskStatus::Pending
                    && !task.is_paused()
            })
            .unwrap_or(tasks.len())
    } else if let Some(after) = after {
        tasks
            .iter()
            .position(|task| {
                task.project_id() == project_id
                    && task.source_path() == after
                    && task.status() == &WikiSourceTaskStatus::Pending
                    && !task.is_paused()
            })
            .map_or(tasks.len(), |index| index + 1)
    } else {
        tasks.len()
    };
    tasks.insert(insert_index.min(tasks.len()), task);
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)?;
    drop(_tasks_lock);
    source_tasks(
        root,
        WikiProjectSelector {
            project_id: Some(project_id.to_owned()),
        },
    )
}

pub(super) fn source_tasks(
    root: &Path,
    input: WikiProjectSelector,
) -> Result<WikiSourceTasksReceipt, WikiFailure> {
    let project_id = input.project_id;
    let tasks = read_source_tasks(root)?
        .into_iter()
        .filter(|task| {
            project_id
                .as_deref()
                .is_none_or(|id| task.project_id() == id)
        })
        .collect();
    Ok(WikiSourceTasksReceipt::new(tasks))
}

pub(super) async fn delete_source(
    root: &Path,
    project_id: &str,
    input: WikiDeleteSourceInput,
) -> Result<WikiDeleteSourceReceipt, WikiFailure> {
    let source_relative_path = source_relative_path(root, &input.source_path)?;
    let (_execution_locks, task_id) = lock_source_mutations(root, project_id, &[&source_relative_path])?;
    let identity = source_identity(&source_relative_path).to_owned();
    if !input.file_already_deleted {
        let path = resolve_project_path(root, &source_relative_path)?;
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(WikiFailure::io(path_text(&path), error)),
        }
    }
    remove_parsed_markdown(root, &source_relative_path)?;
    remove_preprocess_cache(root, &source_relative_path)?;
    remove_source_cache_entry(root, &identity)?;
    let today = Local::now().format("%Y-%m-%d").to_string();
    let log_updated = append_log_entries(
        root,
        &[format!("## [{today}] source deleted | {identity}")],
        &today,
        false,
    )?;

    let mut deleted_pages = Vec::new();
    let mut updated_pages = Vec::new();
    for page_path in wiki_markdown_files(root)? {
        let relative_page = page_path
            .strip_prefix(root)
            .map(normalize_relative_path)
            .unwrap_or_else(|_| path_text(&page_path));
        let content = std::fs::read_to_string(&page_path)
            .map_err(|error| WikiFailure::io(path_text(&page_path), error))?;
        let sources = parse_frontmatter_array(&content, "sources");
        if sources.is_empty() {
            continue;
        }
        let survivors = sources
            .iter()
            .filter(|source| !source_matches_identity(source, &identity))
            .cloned()
            .collect::<Vec<_>>();
        if survivors.len() == sources.len() {
            continue;
        }
        if survivors.is_empty() {
            std::fs::remove_file(&page_path)
                .map_err(|error| WikiFailure::io(path_text(&page_path), error))?;
            let page_id = stable_content_hash(relative_page.as_bytes());
            let _ = crate::vector::delete_page(root, &page_id).await;
            deleted_pages.push(relative_page);
        } else {
            let next = write_frontmatter_array(&content, "sources", &survivors);
            write_wiki_page(root, &relative_page, &next)?;
            updated_pages.push(relative_page);
        }
    }
    let media = root
        .join(WIKI_MEDIA_DIR)
        .join(source_summary_slug(&identity));
    let mut deleted_media = Vec::new();
    match std::fs::remove_dir_all(&media) {
        Ok(()) => deleted_media.push(
            media
                .strip_prefix(root)
                .map(normalize_relative_path)
                .unwrap_or_else(|_| path_text(&media)),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(WikiFailure::io(path_text(&media), error)),
    }
    mark_source_task_done(root, task_id.as_deref())?;
    let mut snapshot_paths = vec![source_relative_path.as_str()];
    if log_updated {
        snapshot_paths.push("wiki/log.md");
    }
    snapshot_paths.extend(updated_pages.iter().map(String::as_str));
    snapshot_paths.extend(deleted_pages.iter().map(String::as_str));
    refresh_file_snapshot(root, &snapshot_paths)?;
    Ok(WikiDeleteSourceReceipt::new(
        source_relative_path,
        deleted_pages,
        updated_pages,
        deleted_media,
    ))
}

pub(super) async fn cleanup_deleted_wiki_pages(
    root: &Path,
    relative_paths: &[String],
) -> Result<(), WikiFailure> {
    let deleted_keys = relative_paths
        .iter()
        .filter_map(|path| wiki_page_stem(path))
        .filter(|slug| !slug.starts_with('.'))
        .flat_map(|slug| [normalize_wiki_ref_key(&slug)])
        .collect::<BTreeSet<_>>();
    if deleted_keys.is_empty() {
        return Ok(());
    }

    for relative_path in relative_paths {
        if let Some(slug) = wiki_page_stem(relative_path) {
            let page_id = stable_content_hash(relative_path.as_bytes());
            let _ = crate::vector::delete_page(root, &page_id).await;
            let media = root.join(WIKI_MEDIA_DIR).join(slug);
            match std::fs::remove_dir_all(&media) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(WikiFailure::io(path_text(&media), error)),
            }
        }
    }

    let mut refreshed = Vec::new();
    for page_path in wiki_markdown_files(root)? {
        let relative_path = page_path
            .strip_prefix(root)
            .map(normalize_relative_path)
            .unwrap_or_else(|_| path_text(&page_path));
        let content = match std::fs::read_to_string(&page_path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let mut updated = content.clone();
        if relative_path == "wiki/index.md"
            || page_path.file_name().and_then(|name| name.to_str()) == Some("index.md")
        {
            updated = clean_index_listing(&updated, &deleted_keys);
        }
        updated = strip_deleted_wikilinks(&updated, &deleted_keys);
        let related = parse_frontmatter_array(&updated, "related");
        if !related.is_empty() {
            let filtered = related
                .into_iter()
                .filter(|related| !deleted_keys.contains(&normalize_wiki_ref_key(related)))
                .collect::<Vec<_>>();
            updated = write_frontmatter_array(&updated, "related", &filtered);
        }
        if updated != content {
            write_wiki_page(root, &relative_path, &updated)?;
            refreshed.push(relative_path);
        }
    }
    let snapshot_paths = refreshed.iter().map(String::as_str).collect::<Vec<_>>();
    refresh_file_snapshot(root, &snapshot_paths)
}

pub(super) fn migrate_source_path(
    root: &Path,
    project_id: &str,
    old_source_relative_path: &str,
    new_source_relative_path: &str,
) -> Result<WikiSourceMoveReceipt, WikiFailure> {
    let (_execution_locks, task_id) = lock_source_mutations(root, project_id, &[old_source_relative_path, new_source_relative_path])?;
    let old_identity = source_identity(old_source_relative_path).to_owned();
    let new_identity = source_identity(new_source_relative_path).to_owned();
    if old_identity == new_identity {
        return Ok(WikiSourceMoveReceipt::new(
            old_source_relative_path.to_owned(),
            new_source_relative_path.to_owned(),
            Vec::new(),
            None,
        ));
    }
    let old_summary = format!(
        "{WIKI_SOURCES_DIR}/{}.md",
        source_summary_slug(&old_identity)
    );
    let new_summary = format!(
        "{WIKI_SOURCES_DIR}/{}.md",
        source_summary_slug(&new_identity)
    );
    let old_summary_path = root.join(&old_summary);
    let new_summary_path = root.join(&new_summary);
    let should_move_summary = old_summary != new_summary && old_summary_path.is_file();
    if should_move_summary && new_summary_path.exists() {
        return Err(WikiFailure::invalid_input(
            "newSourcePath",
            "target source summary already exists",
        ));
    }

    if should_move_summary {
        crate::history::record(root, &old_summary, "baseline", "before.wiki.write_page")?;
    }
    let can_migrate_legacy_basename = can_migrate_legacy_basename(root, &old_identity)?;
    let mut page_updates = Vec::new();
    for page_path in wiki_markdown_files(root)? {
        let content = std::fs::read_to_string(&page_path)
            .map_err(|error| WikiFailure::io(path_text(&page_path), error))?;
        let sources = parse_frontmatter_array(&content, "sources");
        if sources.is_empty() {
            continue;
        }
        let mut changed = false;
        let migrated = sources
            .into_iter()
            .map(|source| {
                if source_matches_identity_strict(&source, &old_identity)
                    || (can_migrate_legacy_basename
                        && source_matches_identity_with_legacy_basename(
                            &source,
                            &old_identity,
                            true,
                        ))
                {
                    changed = true;
                    new_identity.clone()
                } else {
                    source
                }
            })
            .collect::<Vec<_>>();
        if changed {
            let next =
                write_frontmatter_array(&content, "sources", &dedupe_case_insensitive(migrated));
            page_updates.push((
                page_path.clone(),
                page_path
                    .strip_prefix(root)
                    .map(normalize_relative_path)
                    .unwrap_or_else(|_| path_text(&page_path)),
                content,
                next,
            ));
        }
    }

    let mut updated_pages = Vec::new();
    for (_, relative_path, original, next) in &page_updates {
        if let Err(error) = write_wiki_page(root, relative_path, next) {
            rollback_page_updates(root, &page_updates, &updated_pages);
            return Err(error);
        }
        updated_pages.push(relative_path.clone());
        let _ = original;
    }

    let mut moved_summary = None;
    if should_move_summary {
        if let Some(parent) = new_summary_path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                rollback_page_updates(root, &page_updates, &updated_pages);
                return Err(WikiFailure::io(path_text(parent), error));
            }
        }
        if let Err(error) = std::fs::rename(&old_summary_path, &new_summary_path) {
            rollback_page_updates(root, &page_updates, &updated_pages);
            return Err(WikiFailure::io(path_text(&new_summary_path), error));
        }
        moved_summary = Some(new_summary.clone());
    }
    if let Err(error) = move_source_cache_entry(
        root,
        &old_identity,
        &new_identity,
        moved_summary
            .as_ref()
            .map(|new_path| (old_summary.as_str(), new_path.as_str())),
    ) {
        rollback_source_summary_move(
            &old_summary_path,
            &new_summary_path,
            moved_summary.is_some(),
        );
        rollback_page_updates(root, &page_updates, &updated_pages);
        return Err(error);
    }
    if let Err(error) = move_source_media(root, &old_identity, &new_identity) {
        rollback_source_cache_move(
            root,
            &old_identity,
            &new_identity,
            moved_summary.as_deref(),
            &old_summary,
        );
        rollback_source_summary_move(
            &old_summary_path,
            &new_summary_path,
            moved_summary.is_some(),
        );
        rollback_page_updates(root, &page_updates, &updated_pages);
        return Err(error);
    }
    if let Err(error) =
        move_parsed_markdown(root, old_source_relative_path, new_source_relative_path)
    {
        let _ = move_source_media(root, &new_identity, &old_identity);
        rollback_source_cache_move(
            root,
            &old_identity,
            &new_identity,
            moved_summary.as_deref(),
            &old_summary,
        );
        rollback_source_summary_move(
            &old_summary_path,
            &new_summary_path,
            moved_summary.is_some(),
        );
        rollback_page_updates(root, &page_updates, &updated_pages);
        return Err(error);
    }
    if let Err(error) = mark_source_task_done(root, task_id.as_deref()) {
        let _ = move_source_media(root, &new_identity, &old_identity);
        let _ = move_parsed_markdown(root, new_source_relative_path, old_source_relative_path);
        rollback_source_cache_move(
            root,
            &old_identity,
            &new_identity,
            moved_summary.as_deref(),
            &old_summary,
        );
        rollback_source_summary_move(
            &old_summary_path,
            &new_summary_path,
            moved_summary.is_some(),
        );
        rollback_page_updates(root, &page_updates, &updated_pages);
        return Err(error);
    }
    let mut snapshot_paths = vec![old_source_relative_path, new_source_relative_path];
    snapshot_paths.extend(updated_pages.iter().map(String::as_str));
    if let Some(summary) = moved_summary.as_deref() {
        record_written_wiki_page(root, summary);
        snapshot_paths.push(&old_summary);
        snapshot_paths.push(summary);
    }
    refresh_file_snapshot(root, &snapshot_paths)?;
    Ok(WikiSourceMoveReceipt::new(
        old_source_relative_path.to_owned(),
        new_source_relative_path.to_owned(),
        updated_pages,
        moved_summary,
    ))
}

fn rollback_page_updates(
    root: &Path,
    page_updates: &[(PathBuf, String, String, String)],
    updated_pages: &[String],
) {
    for (page_path, relative_path, original, _) in page_updates {
        if updated_pages.iter().any(|updated| updated == relative_path) {
            if std::fs::write(page_path, original.as_bytes()).is_ok() {
                record_written_wiki_page(root, relative_path);
            }
        }
    }
}

fn rollback_source_summary_move(old_summary_path: &Path, new_summary_path: &Path, moved: bool) {
    if moved && new_summary_path.exists() && !old_summary_path.exists() {
        let _ = std::fs::rename(new_summary_path, old_summary_path);
    }
}

fn rollback_source_cache_move(
    root: &Path,
    old_identity: &str,
    new_identity: &str,
    moved_summary: Option<&str>,
    old_summary: &str,
) {
    let _ = move_source_cache_entry(
        root,
        new_identity,
        old_identity,
        moved_summary.map(|new_summary| (new_summary, old_summary)),
    );
}

pub(super) async fn apply_generated_pages(
    root: &Path,
    _project_id: &str,
    input: WikiApplyGeneratedPagesInput,
    source_summary_fallback: Option<String>,
    source_hash: Option<String>,
    ingest_llm: Option<Arc<dyn WikiIngestLlm>>,
    generation_model_ref: Option<&str>,
    cancellation: Option<CancellationToken>,
    task_id: &str,
) -> Result<WikiApplyGeneratedPagesReceipt, WikiFailure> {
    let source_relative_path = source_relative_path(root, &input.source_path)?;
    let identity = source_identity(&source_relative_path).to_owned();
    let source_summary_path = format!("{WIKI_SOURCES_DIR}/{}.md", source_summary_slug(&identity));
    let today = Local::now().format("%Y-%m-%d").to_string();
    let reviews = input.reviews;
    let schema_routing = load_schema_routing(root);
    let target_language = read_apply_target_language(root);
    let mut warnings = Vec::new();
    if let Some(warning) =
        migrate_legacy_source_summary_if_safe(root, &identity, &source_summary_path)
    {
        warnings.push(warning);
    }

    let mut total = input.files
        .iter()
        .filter(|file| {
            let path = file.path.trim().replace('\\', "/");
            !is_log_path(&path) && !is_app_managed_path(&path)
        })
        .count();
    let report_write = |processed, total| {
        if cancellation.as_ref().is_some_and(CancellationToken::is_cancelled)
            || source_task_cancel_requested(root, task_id)?
        {
            return Err(WikiFailure::cancelled());
        }
        mark_source_task_running(
            root,
            task_id,
            "write",
            Some((processed, total)),
        )
    };
    let mut processed = 0;
    let mut written = Vec::new();
    let mut log_entries = Vec::new();
    let mut content_drop = false;
    let mut content_written = false;
    let mut index_candidates = Vec::new();
    report_write(0, total)?;
    for file in input.files {
        let mut relative_path = normalized_wiki_write_path(&file.path)?;
        if relative_path.starts_with("wiki/sources/") {
            relative_path = source_summary_path.clone();
        }
        if cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(WikiFailure::cancelled());
        }
        let mut content = ingest_write::sanitize_ingested_file_content(&file.content);
        if is_log_path(&relative_path) {
            log_entries.push(content);
            continue;
        }
        if is_app_managed_path(&relative_path) {
            warnings.push(format!(
                "Ignored model-generated \"{relative_path}\"; aggregate navigation is maintained by the application."
            ));
            continue;
        }
        content = stamp_frontmatter_dates(&content, &today);
        content = canonicalize_sources_field(&content, &identity);
        if relative_path == source_summary_path {
            content = source_summary_media_refs(&content);
        }
        relative_path =
            rewrite_ingest_path_from_title(&relative_path, &content, target_language.as_deref());
        if let Some(message) = validate_schema_routing(&relative_path, &content, &schema_routing) {
            warnings.push(format!("Dropped \"{relative_path}\" — {message}"));
            content_drop = true;
            processed += 1;
            report_write(processed, total)?;
            continue;
        }
        if should_drop_for_target_language(&relative_path, &content, target_language.as_deref()) {
            warnings.push(format!(
                "Dropped \"{relative_path}\" — body language doesn't match target {}.",
                target_language.as_deref().unwrap_or_default()
            ));
            content_drop = true;
            processed += 1;
            report_write(processed, total)?;
            continue;
        }

        let path = resolve_project_path(root, &relative_path)?;
        let existing = std::fs::read_to_string(&path).ok();
        if let Some(existing) = existing.as_deref() {
            content = merge_existing_page_content(
                root,
                ingest_llm.as_ref(),
                &relative_path,
                &identity,
                content,
                existing,
                &today,
                generation_model_ref,
                cancellation.clone(),
            )
            .await?;
        }
        if relative_path == source_summary_path {
            content = source_summary_media_refs(&preserve_embedded_images_block(
                &content,
                existing.as_deref(),
            ));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| WikiFailure::io(path_text(parent), error))?;
        }
        write_wiki_page(root, &relative_path, &content)?;
        let metadata =
            std::fs::metadata(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
        written.push(WikiWriteReceipt::new(
            relative_path.clone(),
            WikiRevision::for_bytes(
                content.as_bytes(),
                metadata.modified().map(system_time_ms).unwrap_or_default(),
            ),
        ));
        content_written = true;
        index_candidates.push(relative_path);
        processed += 1;
        report_write(processed, total)?;
    }
    if let Some(mut content) = source_summary_fallback.filter(|_| {
        !written.iter().any(|receipt| receipt.relative_path() == source_summary_path)
    }) {
        total += 1;
        report_write(processed, total)?;
        if cancellation.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return Err(WikiFailure::cancelled());
        }
        let path = resolve_project_path(root, &source_summary_path)?;
        if let Ok(existing) = std::fs::read_to_string(&path) {
            content = merge_existing_page_content(
                root,
                ingest_llm.as_ref(),
                &source_summary_path,
                &identity,
                content,
                &existing,
                &today,
                generation_model_ref,
                cancellation.clone(),
            )
            .await?;
            content = preserve_embedded_images_block(&content, Some(&existing));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| WikiFailure::io(path_text(parent), error))?;
        }
        write_wiki_page(root, &source_summary_path, &source_summary_media_refs(&content))?;
        written.push(write_receipt_for_path(root, &source_summary_path)?);
        content_written = true;
        index_candidates.push(source_summary_path.clone());
        processed += 1;
        report_write(processed, total)?;
    }
    let cache_hash = source_hash;
    let deterministic_log = log_entries.is_empty() && (cache_hash.is_some() || content_written);
    if deterministic_log {
        log_entries.push(format!("## [{today}] ingest | {identity}"));
    }
    if append_log_entries(root, &log_entries, &today, deterministic_log)? {
        written.push(write_receipt_for_path(root, "wiki/log.md")?);
    }
    mark_source_task_running(root, task_id, "index", None)?;
    match crate::archive::update_recent_wiki_index(root, &index_candidates) {
        Ok(true) => written.push(write_receipt_for_path(root, "wiki/index.md")?),
        Ok(false) => {}
        Err(error) => warnings.push(format!("Failed to update wiki/index.md: {error}")),
    }
    append_ingest_warnings(root, &identity, &warnings);

    let written_paths = written
        .iter()
        .map(|receipt| receipt.relative_path().to_owned())
        .collect::<Vec<_>>();
    if let Some(cache_hash) = cache_hash.filter(|_| !content_drop) {
        let mut cache_paths = written_paths.clone();
        if !cache_paths.iter().any(|path| path == &source_summary_path) {
            cache_paths.push(source_summary_path);
        }
        write_source_cache_entry(
            root,
            &identity,
            SourceCacheEntry {
                hash: cache_hash,
                timestamp: now_ms(),
                files_written: cache_paths,
            },
        )?;
    }
    super::review_lifecycle::append_review_items(root, reviews)?;
    let snapshot_paths = written_paths.iter().map(String::as_str).collect::<Vec<_>>();
    refresh_file_snapshot(root, &snapshot_paths)?;
    Ok(WikiApplyGeneratedPagesReceipt::new(written))
}

fn preserve_embedded_images_block(content: &str, existing: Option<&str>) -> String {
    let Some(existing_block) = existing.and_then(embedded_images_block) else {
        return content.to_owned();
    };
    if let Some(incoming_block) = embedded_images_block(content) {
        return content.replacen(incoming_block, existing_block, 1);
    }
    format!("{}\n\n{}", content.trim_end(), existing_block.trim())
}

pub(super) fn embedded_images_block(content: &str) -> Option<&str> {
    const START: &str = "<!-- llm-wiki:embedded-images -->";
    const END: &str = "<!-- /llm-wiki:embedded-images -->";
    let start = content.find(START)?;
    let after_start = start + START.len();
    if let Some(end) = content[after_start..]
        .find(END)
        .map(|index| after_start + index + END.len())
    {
        return Some(&content[start..end]);
    }
    let end = content[after_start..]
        .find(START)
        .map(|index| after_start + index + START.len())?;
    Some(&content[start..end])
}

async fn merge_existing_page_content(
    root: &Path,
    llm: Option<&Arc<dyn WikiIngestLlm>>,
    relative_path: &str,
    identity: &str,
    incoming: String,
    existing: &str,
    today: &str,
    generation_model_ref: Option<&str>,
    cancellation: Option<CancellationToken>,
) -> Result<String, WikiFailure> {
    if incoming == existing {
        return Ok(existing.to_owned());
    }
    let array_merged = ingest_write::merge_array_fields_into_content(
        &incoming,
        Some(existing),
        ingest_write::UNION_FRONTMATTER_FIELDS,
    );
    let array_merged = ingest_write::apply_locked_frontmatter_fields(
        &array_merged,
        existing,
        ingest_write::LOCKED_FRONTMATTER_FIELDS,
    );
    if is_owned_only_by_source(existing, identity) {
        backup_existing_page(root, relative_path, existing);
        return Ok(canonicalize_sources_field(
            &ingest_write::set_frontmatter_scalar(&array_merged, "updated", today),
            identity,
        ));
    }
    let existing_body = page_body(existing);
    let array_merged_body = page_body(&array_merged);
    if existing_body.trim() == array_merged_body.trim() {
        return Ok(canonicalize_sources_field(&array_merged, identity));
    }
    let Some(llm) = llm else {
        backup_existing_page(root, relative_path, existing);
        return Ok(canonicalize_sources_field(&array_merged, identity));
    };
    let merged = match merge_page_with_llm(
        llm,
        existing,
        &array_merged,
        identity,
        generation_model_ref,
        cancellation.clone(),
    )
    .await
    {
        Ok(merged) => merged,
        Err(error) if error.is_cancelled() => return Err(error),
        Err(_) => {
            backup_existing_page(root, relative_path, existing);
            return Ok(canonicalize_sources_field(&array_merged, identity));
        }
    };
    let merged_frontmatter = parse_merge_frontmatter(&merged);
    if !merged_frontmatter.has_frontmatter {
        backup_existing_page(root, relative_path, existing);
        return Ok(canonicalize_sources_field(&array_merged, identity));
    }
    let threshold = existing_body.len().max(array_merged_body.len()) as f64 * 0.7;
    if (merged_frontmatter.body.len() as f64) < threshold {
        backup_existing_page(root, relative_path, existing);
        return Ok(canonicalize_sources_field(&array_merged, identity));
    }
    let merged = ingest_write::merge_array_fields_into_content(
        &merged,
        Some(&array_merged),
        ingest_write::UNION_FRONTMATTER_FIELDS,
    );
    let merged = ingest_write::apply_locked_frontmatter_fields(
        &merged,
        existing,
        ingest_write::LOCKED_FRONTMATTER_FIELDS,
    );
    let merged = ingest_write::set_frontmatter_scalar(&merged, "updated", today);
    Ok(canonicalize_sources_field(
        &strip_body_wikilink_path_prefixes(&merged),
        identity,
    ))
}

async fn merge_page_with_llm(
    llm: &Arc<dyn WikiIngestLlm>,
    existing: &str,
    incoming: &str,
    identity: &str,
    generation_model_ref: Option<&str>,
    cancellation: Option<CancellationToken>,
) -> Result<String, WikiFailure> {
    let user = [
        "## Existing version on disk",
        "",
        existing,
        "",
        "---",
        "",
        &format!("## Newly generated version (from {identity})"),
        "",
        incoming,
        "",
        "---",
        "",
        "Now output the merged file. Start with `---` on the first line.",
    ]
    .join("\n");
    let limits = llm
        .model_limits(generation_model_ref)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let request = WikiIngestLlmRequest {
        model_ref: generation_model_ref.map(str::to_owned),
        messages: vec![
            WikiIngestLlmMessage {
                role: WikiIngestLlmRole::System,
                content: prompts::build_page_merge_system_prompt(),
            },
            WikiIngestLlmMessage {
                role: WikiIngestLlmRole::User,
                content: user,
            },
        ],
        options: WikiIngestLlmOptions {
            max_output_tokens: Some(output_token_budget(
                prompts::compute_ingest_generation_max_tokens(
                    limits.context_window.and_then(u64_to_usize),
                ),
                limits,
            )),
            temperature: Some(0.1),
        },
    };
    match cancellation {
        Some(cancellation) => llm.generate_cancellable(request, cancellation).await,
        None => llm.generate(request).await,
    }
    .map(|response| response.text)
}

fn output_token_budget(target: usize, limits: WikiIngestLlmModelLimits) -> u32 {
    let capped = limits
        .max_tokens
        .and_then(u64_to_usize)
        .map_or(target, |max_tokens| target.min(max_tokens));
    capped.min(u32::MAX as usize) as u32
}

fn u64_to_usize(value: u64) -> Option<usize> {
    (value <= usize::MAX as u64).then_some(value as usize)
}

fn is_owned_only_by_source(content: &str, identity: &str) -> bool {
    let sources = parse_frontmatter_array(content, "sources");
    !sources.is_empty()
        && sources
            .iter()
            .all(|source| source_matches_identity_strict(source, identity))
}

fn page_body(content: &str) -> Cow<'_, str> {
    parse_merge_frontmatter(content).body
}

struct MergeFrontmatter<'a> {
    has_frontmatter: bool,
    body: Cow<'a, str>,
}

fn parse_merge_frontmatter(content: &str) -> MergeFrontmatter<'_> {
    let Some((raw_start, payload_start, payload_end, raw_end)) = locate_frontmatter_block(content)
    else {
        return MergeFrontmatter {
            has_frontmatter: false,
            body: Cow::Borrowed(content),
        };
    };
    let payload = &content[payload_start..payload_end];
    if serde_yaml::from_str::<serde_yaml::Value>(payload)
        .or_else(|_| serde_yaml::from_str::<serde_yaml::Value>(&repair_wikilink_lists(payload)))
        .ok()
        .and_then(|value| value.as_mapping().cloned())
        .is_none()
    {
        return MergeFrontmatter {
            has_frontmatter: false,
            body: Cow::Borrowed(&content[raw_end..]),
        };
    }
    MergeFrontmatter {
        has_frontmatter: true,
        body: strip_leading_yaml_fence_close(&content[..raw_start], &content[raw_end..]),
    }
}

pub(crate) fn locate_frontmatter_block(content: &str) -> Option<(usize, usize, usize, usize)> {
    if let Some(bounds) = frontmatter_block_at(content, 0) {
        return Some(bounds);
    }
    for (line_index, line_start) in line_starts(content).take(6).enumerate().skip(1) {
        if line_index < 6 && content[line_start..].starts_with("---") {
            if let Some(bounds) = frontmatter_block_at(content, line_start) {
                return Some(bounds);
            }
        }
    }
    None
}

fn frontmatter_block_at(content: &str, start: usize) -> Option<(usize, usize, usize, usize)> {
    let (opening, payload_start) = line_at(content, start)?;
    if opening.trim() != "---" {
        return None;
    }
    let mut cursor = payload_start;
    while let Some((line, next)) = line_at(content, cursor) {
        if line.trim() == "---" {
            let payload_end = if cursor > payload_start && content[..cursor].ends_with("\r\n") {
                cursor - 2
            } else if cursor > payload_start && content[..cursor].ends_with('\n') {
                cursor - 1
            } else {
                cursor
            };
            return Some((start, payload_start, payload_end, next));
        }
        cursor = next;
    }
    None
}

fn strip_leading_yaml_fence_close<'a>(prefix: &str, body: &'a str) -> Cow<'a, str> {
    let prefix = prefix.trim();
    if !prefix.eq_ignore_ascii_case("```yaml")
        && !prefix.eq_ignore_ascii_case("```yml")
        && prefix != "```"
    {
        return Cow::Borrowed(body);
    }
    let trimmed =
        body.trim_start_matches(|character| matches!(character, ' ' | '\t' | '\r' | '\n'));
    let Some(rest) = trimmed.strip_prefix("```") else {
        return Cow::Borrowed(body);
    };
    let rest = rest.trim_start_matches(|character| matches!(character, ' ' | '\t'));
    if let Some(rest) = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
    {
        return Cow::Owned(rest.to_owned());
    }
    if rest.is_empty() {
        return Cow::Owned(String::new());
    }
    Cow::Borrowed(body)
}

pub(crate) fn repair_wikilink_lists(payload: &str) -> String {
    payload
        .lines()
        .map(|line| {
            let Some((prefix, rest)) = wikilink_list_line(line) else {
                return line.to_owned();
            };
            format!(
                "{prefix}[{}]",
                rest.split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(|item| format!("\"{item}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn wikilink_list_line(line: &str) -> Option<(&str, &str)> {
    let colon = line.find(':')?;
    let key = line[..colon].trim();
    if key.is_empty()
        || !key
            .chars()
            .next()
            .is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        || !key.chars().all(|character| {
            character == '_' || character == '-' || character.is_ascii_alphanumeric()
        })
    {
        return None;
    }
    let rest_with_space = &line[colon + 1..];
    let trim_len = rest_with_space.len() - rest_with_space.trim_start().len();
    let prefix = &line[..colon + 1 + trim_len];
    let rest = rest_with_space.trim();
    let parts = rest.split(',').map(str::trim).collect::<Vec<_>>();
    (parts.len() >= 2
        && parts
            .iter()
            .all(|part| part.starts_with("[[") && part.ends_with("]]")))
    .then_some((prefix, rest))
}

pub(crate) fn strip_body_wikilink_path_prefixes(content: &str) -> String {
    let Some((_, _, _, body_start)) = frontmatter_block_at(content, 0) else {
        return content.to_owned();
    };
    format!(
        "{}{}",
        &content[..body_start],
        normalize_wikilinks_outside_code(&content[body_start..])
    )
}

fn normalize_wikilinks_outside_code(body: &str) -> String {
    let mut output = String::with_capacity(body.len());
    let mut fence: Option<(char, usize)> = None;
    for line in body.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        if let Some((marker, length)) = fence_marker(content) {
            match fence {
                None => fence = Some((marker, length)),
                Some((open_marker, open_length))
                    if marker == open_marker
                        && length >= open_length
                        && content[marker_prefix_len(content)..].trim().is_empty() =>
                {
                    fence = None;
                }
                _ => {}
            }
            output.push_str(line);
        } else if fence.is_some() || content.starts_with("    ") || content.starts_with('\t') {
            output.push_str(line);
        } else {
            output.push_str(&replace_outside_inline_code(line));
        }
    }
    output
}

fn replace_outside_inline_code(text: &str) -> String {
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(opening) = text[cursor..].find('`').map(|index| cursor + index) {
        output.push_str(&replace_wikilink_prefixes(&text[cursor..opening]));
        let run_end = text[opening..]
            .find(|character| character != '`')
            .map(|index| opening + index)
            .unwrap_or(text.len());
        let delimiter = &text[opening..run_end];
        let Some(closing) = text[run_end..].find(delimiter).map(|index| run_end + index) else {
            output.push_str(&replace_wikilink_prefixes(&text[opening..run_end]));
            cursor = run_end;
            continue;
        };
        let end = closing + delimiter.len();
        output.push_str(&text[opening..end]);
        cursor = end;
    }
    output.push_str(&replace_wikilink_prefixes(&text[cursor..]));
    output
}

fn replace_wikilink_prefixes(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        output.push_str(&rest[..start]);
        let before = &rest[..start];
        let after_open = start + 2;
        let Some(end) = rest[after_open..]
            .find("]]")
            .map(|index| after_open + index)
        else {
            output.push_str(&rest[start..]);
            return output;
        };
        let matched = &rest[start..end + 2];
        let target = &rest[after_open..end];
        if before.ends_with('!') || before.chars().rev().take_while(|c| *c == '\\').count() % 2 == 1
        {
            output.push_str(matched);
        } else if target.contains('\n') {
            output.push_str(matched);
        } else {
            let (page, alias) = target.split_once('|').unwrap_or((target, ""));
            match wikilink_leaf(page.trim()) {
                Some(leaf) if leaf != page.trim() => {
                    output.push_str("[[");
                    output.push_str(&leaf);
                    if target.contains('|') {
                        output.push('|');
                        output.push_str(alias);
                    }
                    output.push_str("]]");
                }
                _ => output.push_str(matched),
            }
        }
        rest = &rest[end + 2..];
    }
    output.push_str(rest);
    output
}

fn line_starts(content: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(content.match_indices('\n').map(|(index, _)| index + 1))
}

fn line_at(content: &str, start: usize) -> Option<(&str, usize)> {
    if start >= content.len() {
        return None;
    }
    let rest = &content[start..];
    if let Some(offset) = rest.find('\n') {
        let end = start + offset;
        let line_end = if end > start && content.as_bytes()[end - 1] == b'\r' {
            end - 1
        } else {
            end
        };
        Some((&content[start..line_end], end + 1))
    } else {
        Some((rest, content.len()))
    }
}

fn fence_marker(content: &str) -> Option<(char, usize)> {
    let space_count = content
        .chars()
        .take_while(|character| *character == ' ')
        .count();
    if space_count > 3 {
        return None;
    }
    let trimmed = &content[space_count..];
    let marker = trimmed.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let length = trimmed
        .chars()
        .take_while(|character| *character == marker)
        .count();
    (length >= 3).then_some((marker, length))
}

fn marker_prefix_len(content: &str) -> usize {
    let spaces = content
        .chars()
        .take_while(|character| *character == ' ')
        .count()
        .min(3);
    spaces
        + content[spaces..]
            .chars()
            .take_while(|character| *character == '`' || *character == '~')
            .map(char::len_utf8)
            .sum::<usize>()
}

fn wikilink_leaf(target: &str) -> Option<String> {
    if target.is_empty()
        || target.starts_with('#')
        || !target.contains('/')
        || is_uri_like_target(target)
    {
        return None;
    }
    let (page, fragment) = target.split_once('#').unwrap_or((target, ""));
    let leaf = page.replace('\\', "/").rsplit('/').next()?.to_owned();
    if leaf.is_empty() {
        return None;
    }
    let extension_index = leaf.rfind('.');
    if extension_index.is_some_and(|index| !leaf[index..].eq_ignore_ascii_case(".md")) {
        return None;
    }
    if fragment.is_empty() {
        Some(leaf)
    } else {
        Some(format!("{leaf}#{fragment}"))
    }
}

fn is_uri_like_target(target: &str) -> bool {
    let Some(colon) = target.find(':') else {
        return false;
    };
    let scheme = &target[..colon];
    !scheme.is_empty()
        && scheme
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
        && scheme.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')
        })
}

fn wiki_page_stem(relative_path: &str) -> Option<String> {
    Path::new(relative_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_owned)
}

pub(super) fn normalize_wiki_ref_key(value: &str) -> String {
    let normalized = value.trim().replace('\\', "/");
    let leaf = normalized.rsplit('/').next().unwrap_or(&normalized);
    let lowercase = leaf.to_lowercase();
    let without_md = lowercase.strip_suffix(".md").unwrap_or(&lowercase);
    without_md
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '-' | '_'))
        .collect()
}

pub(super) fn clean_index_listing(content: &str, deleted_keys: &BTreeSet<String>) -> String {
    if deleted_keys.is_empty() {
        return content.to_owned();
    }
    content
        .split('\n')
        .filter(|line| {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed
                .strip_prefix('-')
                .or_else(|| trimmed.strip_prefix('*'))
            else {
                return true;
            };
            let Some(target) = rest
                .trim_start()
                .strip_prefix("[[")
                .and_then(|rest| rest.split("]]").next())
            else {
                return true;
            };
            let target = target.split('|').next().unwrap_or(target).trim();
            !deleted_keys.contains(&normalize_wiki_ref_key(target))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn strip_deleted_wikilinks(content: &str, deleted_keys: &BTreeSet<String>) -> String {
    if deleted_keys.is_empty() {
        return content.to_owned();
    }
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let link = &after[..end];
        let (target, display) = link
            .split_once('|')
            .map(|(target, display)| (target, Some(display)))
            .unwrap_or((link, None));
        if deleted_keys.contains(&normalize_wiki_ref_key(target.trim())) {
            out.push_str(display.unwrap_or(target));
        } else {
            out.push_str("[[");
            out.push_str(link);
            out.push_str("]]");
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

pub(super) fn source_relative_path(root: &Path, source_path: &str) -> Result<String, WikiFailure> {
    let normalized = source_path.trim().replace('\\', "/");
    if normalized.starts_with("raw/sources/") {
        return Ok(normalized);
    }
    let path = Path::new(source_path);
    if path.is_absolute() {
        return path
            .strip_prefix(root)
            .map(normalize_relative_path)
            .map_err(|_| WikiFailure::PathOutsideProject {
                path: source_path.to_owned(),
            });
    }
    Ok(format!(
        "raw/sources/{}",
        normalized.trim_start_matches('/')
    ))
}

fn normalized_wiki_write_path(path: &str) -> Result<String, WikiFailure> {
    let normalized = path.trim().replace('\\', "/");
    if !is_safe_ingest_path(&normalized) || normalized.starts_with("wiki/media/") {
        return Err(WikiFailure::invalid_path(path));
    }
    Ok(normalized)
}

pub(super) fn source_summary_markdown(identity: &str, text: &str) -> String {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let title = format!("Source: {identity}");
    let title_json = serde_json::to_string(&title).expect("string serialization is infallible");
    let source_json = serde_json::to_string(identity).expect("string serialization is infallible");
    format!(
        "---\ntype: source\ntitle: {title_json}\ncreated: {today}\nupdated: {today}\nsources: [{source_json}]\ntags: []\nrelated: []\n---\n\n# {title}\n\n{text}\n"
    )
}

fn stamp_frontmatter_dates(content: &str, today: &str) -> String {
    let content = ingest_write::set_frontmatter_scalar(content, "created", today);
    ingest_write::set_frontmatter_scalar(&content, "updated", today)
}

#[derive(Clone, Debug, Default)]
struct SchemaRouting {
    type_dirs: BTreeMap<String, String>,
}

fn load_schema_routing(root: &Path) -> SchemaRouting {
    std::fs::read_to_string(root.join("schema.md"))
        .map(|schema| parse_schema_routing(&schema))
        .unwrap_or_default()
}

fn parse_schema_routing(schema: &str) -> SchemaRouting {
    let lines = schema.lines().collect::<Vec<_>>();
    let Some(start) = lines.iter().position(|line| {
        let trimmed = line.trim().trim_end_matches('#').trim();
        trimmed.starts_with('#')
            && trimmed
                .trim_start_matches('#')
                .trim()
                .eq_ignore_ascii_case("Page Types")
    }) else {
        return SchemaRouting::default();
    };
    let level = lines[start]
        .trim()
        .chars()
        .take_while(|ch| *ch == '#')
        .count();
    let mut type_dirs = BTreeMap::new();
    for line in lines.into_iter().skip(start + 1) {
        let trimmed = line.trim();
        let next_level = trimmed.chars().take_while(|ch| *ch == '#').count();
        if next_level > 0 && next_level <= level {
            break;
        }
        if !trimmed.starts_with('|') {
            continue;
        }
        let cells = trimmed
            .split('|')
            .skip(1)
            .take_while(|cell| !cell.is_empty() || trimmed.ends_with('|'))
            .map(str::trim)
            .collect::<Vec<_>>();
        if cells.len() < 2 || !valid_schema_type(cells[0]) {
            continue;
        }
        let dir = cells[1].trim_end_matches('/');
        if dir == "wiki" || dir.starts_with("wiki/") {
            type_dirs.insert(cells[0].to_owned(), dir.to_owned());
        }
    }
    SchemaRouting { type_dirs }
}

fn valid_schema_type(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|ch| ch.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn validate_schema_routing(
    relative_path: &str,
    content: &str,
    routing: &SchemaRouting,
) -> Option<String> {
    if routing.type_dirs.is_empty() {
        return None;
    }
    let page_type = ingest_write::parse_frontmatter_scalar(content, "type")?;
    let page_type = page_type.trim();
    if page_type.is_empty() {
        return None;
    }
    let actual_dir = path_dir(relative_path);
    if let Some(expected_dir) = routing.type_dirs.get(page_type) {
        if actual_dir != *expected_dir {
            return Some(format!(
                "Page type \"{page_type}\" must be under \"{expected_dir}/\". Current directory: \"{actual_dir}\"."
            ));
        }
    }
    for (schema_type, dir) in &routing.type_dirs {
        if actual_dir == *dir && schema_type != page_type {
            return Some(format!(
                "Pages under \"{actual_dir}/\" must use type \"{schema_type}\", but found \"{page_type}\"."
            ));
        }
    }
    None
}

fn path_dir(relative_path: &str) -> String {
    let normalized = relative_path.replace('\\', "/");
    normalized
        .rsplit_once('/')
        .map(|(dir, _)| dir.to_owned())
        .unwrap_or_else(|| ".".to_owned())
}

fn read_apply_target_language(root: &Path) -> Option<String> {
    read_json::<WikiSourceWatchConfig>(root.join(SOURCE_WATCH_CONFIG_FILE))
        .ok()
        .and_then(|config| configured_output_language(config.output_language()).map(str::to_owned))
}

fn configured_output_language(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed != "auto").then_some(trimmed)
}

fn source_summary_media_refs(content: &str) -> String {
    content
        .replace("](./media/", "](../media/")
        .replace("](media/", "](../media/")
        .replace("src=\"./media/", "src=\"../media/")
        .replace("src=\"media/", "src=\"../media/")
        .replace("src='./media/", "src='../media/")
        .replace("src='media/", "src='../media/")
}

fn rewrite_ingest_path_from_title(
    relative_path: &str,
    content: &str,
    target_language: Option<&str>,
) -> String {
    let title = extract_generated_page_title(content);
    let should_use_cjk_filename = match target_language {
        Some(language) => is_cjk_output_language(language),
        None => title.as_deref().is_some_and(contains_cjk),
    };
    if !should_use_cjk_filename
        || is_log_path(relative_path)
        || is_listing_path(relative_path)
        || relative_path.starts_with("wiki/sources/")
    {
        return relative_path.to_owned();
    }
    let Some(title) = title.filter(|title| contains_cjk(title)) else {
        return relative_path.to_owned();
    };
    let (dir, filename) = relative_path
        .rsplit_once('/')
        .unwrap_or(("", relative_path));
    if contains_cjk(filename) {
        return relative_path.to_owned();
    }
    let slug = make_title_slug(&title);
    if !contains_cjk(&slug) {
        return relative_path.to_owned();
    }
    let next = if dir.is_empty() {
        format!("{slug}.md")
    } else {
        format!("{dir}/{slug}.md")
    };
    if is_safe_ingest_path(&next) {
        next
    } else {
        relative_path.to_owned()
    }
}

fn extract_generated_page_title(content: &str) -> Option<String> {
    ingest_write::parse_frontmatter_scalar(content, "title")
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            content.lines().find_map(|line| {
                line.trim_start()
                    .strip_prefix("# ")
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .map(str::to_owned)
            })
        })
}

fn make_title_slug(title: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in title.chars() {
        if ch.is_alphanumeric() {
            out.extend(ch.to_lowercase());
            last_dash = false;
        } else if (ch.is_whitespace() || ch == '-') && !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
        if out.chars().count() >= 50 {
            break;
        }
    }
    let out = out.trim_matches('-').to_owned();
    if out.is_empty() {
        "query".to_owned()
    } else {
        out
    }
}

fn should_drop_for_target_language(
    relative_path: &str,
    content: &str,
    target_language: Option<&str>,
) -> bool {
    let Some(target_language) = target_language else {
        return false;
    };
    if is_log_path(relative_path)
        || relative_path.starts_with("wiki/sources/")
        || relative_path.contains("/sources/")
        || relative_path.starts_with("wiki/entities/")
        || relative_path.contains("/entities/")
    {
        return false;
    }
    !content_matches_target_language(content, target_language)
}

fn content_matches_target_language(content: &str, target_language: &str) -> bool {
    let body = strip_frontmatter_code_and_math(content);
    let sample = body.chars().take(1500).collect::<String>();
    if sample.trim().chars().count() < 20 {
        return true;
    }
    let detected = detect_language_family(&sample);
    let target_is_cjk = is_cjk_output_language(target_language);
    let detected_is_cjk = is_cjk_output_language(detected);
    if target_is_cjk {
        return detected_is_cjk;
    }
    if is_distinct_non_latin(target_language) {
        return detected == target_language;
    }
    if is_distinct_non_latin(detected) {
        return same_script_family(target_language, detected);
    }
    !detected_is_cjk
}

fn strip_frontmatter_code_and_math(content: &str) -> String {
    let mut body = match content.find("\n---\n") {
        Some(index) if content.starts_with("---\n") => &content[index + 5..],
        _ => content,
    };
    let mut out = String::with_capacity(body.len());
    let mut fenced = false;
    let mut math = false;
    while let Some(line_end) = body.find('\n') {
        let line = &body[..line_end + 1];
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            fenced = !fenced;
            body = &body[line_end + 1..];
            continue;
        }
        if trimmed.starts_with("$$") {
            math = !math;
            body = &body[line_end + 1..];
            continue;
        }
        if !fenced && !math {
            out.push_str(line);
        }
        body = &body[line_end + 1..];
    }
    if !fenced && !math {
        out.push_str(body);
    }
    out
}

fn detect_language_family(text: &str) -> &'static str {
    let mut chinese = 0;
    let mut japanese = 0;
    let mut korean = 0;
    let mut arabic = 0;
    let mut persian = 0;
    let mut hebrew = 0;
    let mut thai = 0;
    let mut hindi = 0;
    let mut cyrillic = 0;
    let mut greek = 0;
    for ch in text.chars() {
        match ch as u32 {
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0xF900..=0xFAFF => chinese += 1,
            0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF65..=0xFF9F => japanese += 1,
            0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F => korean += 1,
            0x0600..=0x06FF
            | 0x0750..=0x077F
            | 0x08A0..=0x08FF
            | 0xFB50..=0xFDFF
            | 0xFE70..=0xFEFF => {
                arabic += 1;
                if matches!(ch, 'پ' | 'چ' | 'ژ' | 'گ' | 'ک' | 'ی') {
                    persian += 1;
                }
            }
            0x0590..=0x05FF | 0xFB1D..=0xFB4F => hebrew += 1,
            0x0E00..=0x0E7F => thai += 1,
            0x0900..=0x097F => hindi += 1,
            0x0400..=0x052F => cyrillic += 1,
            0x0370..=0x03FF | 0x1F00..=0x1FFF => greek += 1,
            _ => {}
        }
    }
    if japanese > 0 && chinese > 0 {
        return "Japanese";
    }
    let scripts = [
        ("Chinese", chinese),
        ("Japanese", japanese),
        ("Korean", korean),
        (
            if persian >= 3 && persian > arabic - persian {
                "Persian"
            } else {
                "Arabic"
            },
            arabic,
        ),
        ("Hebrew", hebrew),
        ("Thai", thai),
        ("Hindi", hindi),
        ("Russian", cyrillic),
        ("Greek", greek),
    ];
    scripts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .filter(|(_, count)| *count >= 2)
        .map(|(language, _)| language)
        .unwrap_or("English")
}

fn is_cjk_output_language(language: &str) -> bool {
    matches!(
        language,
        "Chinese" | "Traditional Chinese" | "Japanese" | "Korean"
    )
}

fn contains_cjk(text: &str) -> bool {
    text.chars().any(|ch| {
        matches!(
            ch as u32,
            0x3400..=0x9FFF | 0x3040..=0x30FF | 0xAC00..=0xD7AF
        )
    })
}

fn is_distinct_non_latin(language: &str) -> bool {
    matches!(language, "Arabic" | "Persian" | "Hindi" | "Thai" | "Hebrew")
}

fn same_script_family(target: &str, detected: &str) -> bool {
    !is_cjk_output_language(target) && !is_cjk_output_language(detected)
}

fn is_log_path(relative_path: &str) -> bool {
    relative_path == "wiki/log.md" || relative_path.ends_with("/log.md")
}

fn is_listing_path(relative_path: &str) -> bool {
    relative_path == "wiki/index.md"
        || relative_path.ends_with("/index.md")
        || relative_path == "wiki/overview.md"
        || relative_path.ends_with("/overview.md")
}

fn migrate_legacy_source_summary_if_safe(
    root: &Path,
    identity: &str,
    source_summary_path: &str,
) -> Option<String> {
    if !identity.contains('/') {
        return None;
    }
    let basename = Path::new(identity).file_name()?.to_str()?;
    if raw_source_basename_count(root, basename).ok()? != 1 {
        return None;
    }
    let legacy_slug = basename.trim_end_matches(extension_suffix(basename));
    let legacy_path = format!("{WIKI_SOURCES_DIR}/{legacy_slug}.md");
    if legacy_path == source_summary_path || root.join(source_summary_path).exists() {
        return None;
    }
    let legacy_full_path = root.join(&legacy_path);
    let legacy_content = std::fs::read_to_string(&legacy_full_path).ok()?;
    let basename_key = basename.to_ascii_lowercase();
    let sources = parse_frontmatter_array(&legacy_content, "sources");
    if sources.is_empty()
        || !sources.iter().all(|source| {
            let normalized = source_reference_identity(source);
            !normalized.contains('/')
                && Path::new(&normalized)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.to_ascii_lowercase() == basename_key)
        })
    {
        return None;
    }
    let canonical = canonicalize_sources_field(&legacy_content, identity);
    let canonical_path = root.join(source_summary_path);
    let parent = canonical_path.parent()?;
    if std::fs::create_dir_all(parent).is_err() {
        return Some(format!(
            "Failed to migrate legacy source summary {legacy_path} -> {source_summary_path}."
        ));
    }
    if crate::history::record(root, &legacy_path, "baseline", "before.wiki.write_page").is_err() {
        return Some(
            "Source summary migration stopped before writing: file history recording failed."
                .to_owned(),
        );
    }
    if write_wiki_page(root, source_summary_path, &canonical).is_ok()
        && std::fs::remove_file(&legacy_full_path).is_ok()
    {
        None
    } else {
        let _ = std::fs::remove_file(&canonical_path);
        Some(format!(
            "Failed to migrate legacy source summary {legacy_path} -> {source_summary_path}."
        ))
    }
}

fn raw_source_basename_count(root: &Path, basename: &str) -> Result<usize, WikiFailure> {
    let basename = basename.to_ascii_lowercase();
    Ok(raw_source_files(root)?
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.to_ascii_lowercase() == basename)
        })
        .count())
}

fn append_ingest_warnings(root: &Path, identity: &str, warnings: &[String]) {
    if warnings.is_empty() {
        return;
    }
    let path = root.join(INGEST_WARNINGS_LOG);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let timestamp = Local::now().to_rfc3339();
    let entry = format!(
        "## {timestamp} | {identity}\n{}\n",
        warnings
            .iter()
            .enumerate()
            .map(|(index, warning)| format!("{}. {warning}", index + 1))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let content = if existing.trim().is_empty() {
        entry
    } else {
        format!("{}\n\n{entry}", existing.trim_end())
    };
    if let Err(error) = std::fs::write(&path, content.as_bytes()) {
        eprintln!(
            "[wiki] failed to write ingest warning log for {}: {}",
            identity, error
        );
    }
}

fn write_wiki_page(root: &Path, relative_path: &str, content: &str) -> Result<(), WikiFailure> {
    let path = resolve_project_path(root, relative_path)?;
    crate::history::record(root, relative_path, "baseline", "before.wiki.write_page")?;
    std::fs::write(&path, content.as_bytes())
        .map_err(|error| WikiFailure::io(path_text(&path), error))?;
    record_written_wiki_page(root, relative_path);
    Ok(())
}

fn record_written_wiki_page(root: &Path, relative_path: &str) {
    if crate::history::record(root, relative_path, "agent", "wiki.write_page").is_err() {
        eprintln!("[wiki] page written; file history recording failed");
    }
}

fn backup_existing_page(root: &Path, relative_path: &str, existing: &str) {
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let sanitized = relative_path.replace(['/', '\\'], "__");
    let backup_path = root
        .join(".llm-wiki/page-history")
        .join(format!("{sanitized}-{stamp}.md"));
    if let Some(parent) = backup_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(backup_path, existing.as_bytes());
}

fn append_log_entries(
    root: &Path,
    entries: &[String],
    today: &str,
    deterministic_log: bool,
) -> Result<bool, WikiFailure> {
    let entries = entries
        .iter()
        .map(|entry| stamp_generated_log_date(entry.trim(), today))
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Ok(false);
    }
    let path = root.join("wiki/log.md");
    let mut content = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        if deterministic_log {
            "# Wiki Log".to_owned()
        } else {
            String::new()
        }
    });
    content = if content.trim().is_empty() {
        String::new()
    } else {
        format!("{}\n\n", content.trim_end())
    };
    content.push_str(&entries.join("\n\n"));
    content.push('\n');
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    write_wiki_page(root, "wiki/log.md", &content)?;
    Ok(true)
}

fn stamp_generated_log_date(entry: &str, today: &str) -> String {
    let normalized = entry.replace("YYYY-MM-DD", today);
    let mut line_start = 0;
    for line in normalized.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if let Some(after_heading) = trimmed.strip_prefix("##") {
            let heading_start = line_start + line.len() - trimmed.len();
            let after_hashes = heading_start + 2;
            let spaces = after_heading.len() - after_heading.trim_start().len();
            let date_start =
                after_hashes + spaces + usize::from(after_heading.trim_start().starts_with('['));
            let date_end = date_start + 10;
            let Some(date) = normalized.get(date_start..date_end) else {
                return normalized;
            };
            if !is_iso_date(date) {
                return normalized;
            }
            let mut out = String::with_capacity(normalized.len());
            out.push_str(&normalized[..date_start]);
            out.push_str(today);
            out.push_str(&normalized[date_end..]);
            return out;
        }
        line_start += line.len();
    }
    normalized
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn write_receipt_for_path(
    root: &Path,
    relative_path: &str,
) -> Result<WikiWriteReceipt, WikiFailure> {
    let path = root.join(relative_path);
    let bytes = std::fs::read(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    let metadata =
        std::fs::metadata(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
    Ok(WikiWriteReceipt::new(
        relative_path.to_owned(),
        WikiRevision::for_bytes(
            &bytes,
            metadata.modified().map(system_time_ms).unwrap_or_default(),
        ),
    ))
}

fn is_app_managed_path(path: &str) -> bool {
    matches!(
        path.to_ascii_lowercase().as_str(),
        "wiki/index.md" | "wiki/overview.md" | "wiki/log.md"
    )
}

fn canonicalize_sources_field(content: &str, identity: &str) -> String {
    if !content.starts_with("---\n") {
        return content.to_owned();
    }
    let identity_key = identity.replace('\\', "/").to_ascii_lowercase();
    let identity_base = Path::new(identity)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(identity)
        .to_ascii_lowercase();
    let mut sources = parse_frontmatter_array(content, "sources")
        .into_iter()
        .filter(|source| valid_source_reference(source, identity))
        .map(|source| {
            let normalized = source_reference_identity(&source);
            let key = normalized.to_ascii_lowercase();
            if key == identity_key || (!normalized.contains('/') && key == identity_base) {
                identity.to_owned()
            } else {
                normalized
            }
        })
        .collect::<Vec<_>>();
    if !sources
        .iter()
        .any(|source| source.to_ascii_lowercase() == identity_key)
    {
        sources.push(identity.to_owned());
    }
    write_frontmatter_array(content, "sources", &dedupe_case_insensitive(sources))
}

fn valid_source_reference(source: &str, identity: &str) -> bool {
    let normalized = source
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_owned();
    let key = normalized.to_ascii_lowercase();
    let bytes = normalized.as_bytes();
    let windows_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if normalized.is_empty()
        || normalized.starts_with('/')
        || windows_drive
        || normalized.split('/').any(|part| part == "..")
        || key == ".llm-wiki"
        || key.starts_with(".llm-wiki/")
    {
        return false;
    }
    source_reference_identity(&normalized).to_ascii_lowercase() == identity.to_ascii_lowercase()
        || !matches!(
            key.as_str(),
            "wiki/index.md" | "wiki/overview.md" | "wiki/log.md"
        )
}

fn source_matches_identity(source: &str, identity: &str) -> bool {
    source_matches_identity_with_legacy_basename(source, identity, true)
}

fn source_matches_identity_strict(source: &str, identity: &str) -> bool {
    source_matches_identity_with_legacy_basename(source, identity, false)
}

fn source_matches_identity_with_legacy_basename(
    source: &str,
    identity: &str,
    allow_legacy_basename: bool,
) -> bool {
    let normalized = source_reference_identity(source);
    let key = normalized.to_ascii_lowercase();
    let identity_key = identity.to_ascii_lowercase();
    if key == identity_key {
        return true;
    }
    allow_legacy_basename
        && !normalized.contains('/')
        && Path::new(identity)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|base| key == base.to_ascii_lowercase())
}

fn can_migrate_legacy_basename(root: &Path, identity: &str) -> Result<bool, WikiFailure> {
    if !identity.contains('/') {
        return Ok(false);
    }
    let Some(base) = Path::new(identity)
        .file_name()
        .and_then(|name| name.to_str())
    else {
        return Ok(false);
    };
    let base = base.to_ascii_lowercase();
    let mut matches = 0usize;
    for path in raw_source_files(root)? {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.to_ascii_lowercase() == base)
        {
            matches += 1;
            if matches > 1 {
                return Ok(false);
            }
        }
    }
    Ok(matches == 1)
}

fn parse_frontmatter_array(content: &str, field: &str) -> Vec<String> {
    if !content.starts_with("---\n") {
        return Vec::new();
    }
    let Some(end) = content[4..].find("\n---") else {
        return Vec::new();
    };
    let frontmatter = &content[4..4 + end];
    let lines = frontmatter.lines().collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let prefix = format!("{field}:");
        if !trimmed.starts_with(&prefix) {
            continue;
        }
        let rest = trimmed[prefix.len()..].trim();
        if rest.starts_with('[') && rest.ends_with(']') {
            return split_inline_array(&rest[1..rest.len() - 1]);
        }
        let mut values = Vec::new();
        for item in lines.iter().skip(index + 1) {
            let item_trimmed = item.trim_start();
            if let Some(value) = item_trimmed.strip_prefix("- ") {
                values.push(unquote(value.trim()).to_owned());
            } else if !item.starts_with(' ') {
                break;
            }
        }
        return values;
    }
    Vec::new()
}

fn write_frontmatter_array(content: &str, field: &str, values: &[String]) -> String {
    if !content.starts_with("---\n") {
        return content.to_owned();
    }
    let Some(end) = content[4..].find("\n---") else {
        return content.to_owned();
    };
    let frontmatter_end = 4 + end;
    let frontmatter = &content[4..frontmatter_end];
    let array = format!(
        "{field}: [{}]",
        values
            .iter()
            .map(|value| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let mut lines = Vec::new();
    let mut replaced = false;
    let source_lines = frontmatter.lines().collect::<Vec<_>>();
    let mut index = 0;
    while index < source_lines.len() {
        let line = source_lines[index];
        let trimmed = line.trim_start();
        if trimmed.starts_with(&format!("{field}:")) {
            lines.push(array.clone());
            replaced = true;
            index += 1;
            while index < source_lines.len()
                && source_lines[index].starts_with(' ')
                && source_lines[index].trim_start().starts_with("- ")
            {
                index += 1;
            }
            continue;
        }
        lines.push(line.to_owned());
        index += 1;
    }
    if !replaced {
        lines.push(array);
    }
    format!("---\n{}\n{}", lines.join("\n"), &content[frontmatter_end..])
}

fn split_inline_array(input: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in input.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote == Some('"') {
            escaped = true;
            continue;
        }
        if quote == Some(character) {
            quote = None;
            continue;
        }
        if quote.is_none() && (character == '"' || character == '\'') {
            quote = Some(character);
            continue;
        }
        if quote.is_none() && character == ',' {
            let value = current.trim();
            if !value.is_empty() {
                values.push(unquote(value).to_owned());
            }
            current.clear();
        } else {
            current.push(character);
        }
    }
    let value = current.trim();
    if !value.is_empty() {
        values.push(unquote(value).to_owned());
    }
    values
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn dedupe_case_insensitive(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for value in values {
        let key = value.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(value);
        }
    }
    out
}

pub(crate) fn wiki_markdown_files(root: &Path) -> Result<Vec<PathBuf>, WikiFailure> {
    if root.join("wiki").exists() {
        let wiki_root = root.join("wiki").canonicalize()
            .map_err(|error| WikiFailure::io("wiki", error))?;
        let project_root = root.canonicalize()
            .map_err(|error| WikiFailure::io("project", error))?;
        if !wiki_root.starts_with(project_root) {
            return Err(WikiFailure::invalid_path("wiki"));
        }
    }
    let mut files = Vec::new();
    collect_wiki_markdown(root, &root.join("wiki"), &mut files)?;
    Ok(files)
}

fn raw_source_files(root: &Path) -> Result<Vec<PathBuf>, WikiFailure> {
    let directory = root.join(RAW_SOURCES_DIR);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    collect_regular_files(&directory, &mut files)?;
    Ok(files)
}

fn collect_wiki_markdown(
    root: &Path,
    directory: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), WikiFailure> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(directory)
        .map_err(|error| WikiFailure::io(path_text(directory), error))?
    {
        let entry = entry.map_err(|error| WikiFailure::io(path_text(directory), error))?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map(normalize_relative_path)
            .unwrap_or_else(|_| path_text(&path));
        if relative == WIKI_MEDIA_DIR || relative.starts_with("wiki/media/") {
            continue;
        }
        let metadata = entry
            .file_type()
            .map_err(|error| WikiFailure::io(path_text(&path), error))?;
        if metadata.is_dir() {
            collect_wiki_markdown(root, &path, out)?;
        } else if metadata.is_file() && path.extension().and_then(|extension| extension.to_str()) == Some("md") {
            out.push(path);
        }
    }
    Ok(())
}

fn move_source_media(
    root: &Path,
    old_identity: &str,
    new_identity: &str,
) -> Result<(), WikiFailure> {
    let old_path = root
        .join(WIKI_MEDIA_DIR)
        .join(source_summary_slug(old_identity));
    if !old_path.is_dir() {
        return Ok(());
    }
    let new_path = root
        .join(WIKI_MEDIA_DIR)
        .join(source_summary_slug(new_identity));
    if new_path.exists() {
        return Err(WikiFailure::invalid_input(
            "newSourcePath",
            "target source media already exists",
        ));
    }
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    std::fs::rename(&old_path, &new_path)
        .map_err(|error| WikiFailure::io(path_text(&new_path), error))
}

fn remove_parsed_markdown(root: &Path, source_relative_path: &str) -> Result<(), WikiFailure> {
    let path = root
        .join(RAW_PARSED_DIR)
        .join(format!("{}.md", source_identity(source_relative_path)));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(WikiFailure::io(path_text(&path), error)),
    }
}

fn move_parsed_markdown(
    root: &Path,
    old_source_relative_path: &str,
    new_source_relative_path: &str,
) -> Result<(), WikiFailure> {
    let old_path = root
        .join(RAW_PARSED_DIR)
        .join(format!("{}.md", source_identity(old_source_relative_path)));
    if !old_path.is_file() {
        return Ok(());
    }
    let new_path = root
        .join(RAW_PARSED_DIR)
        .join(format!("{}.md", source_identity(new_source_relative_path)));
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    std::fs::rename(&old_path, &new_path)
        .map_err(|error| WikiFailure::io(path_text(&new_path), error))
}

fn remove_preprocess_cache(root: &Path, source_relative_path: &str) -> Result<(), WikiFailure> {
    let source_path = root.join(source_relative_path);
    let base = Path::new(source_relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(source_relative_path);
    let mut cache_dirs = vec![root.join(RAW_SOURCES_DIR).join(".cache")];
    if let Some(parent) = source_path.parent() {
        cache_dirs.push(parent.join(".cache"));
    }
    for cache_dir in cache_dirs {
        for suffix in ["txt", "txt.parser"] {
            let path = cache_dir.join(format!("{base}.{suffix}"));
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(WikiFailure::io(path_text(&path), error)),
            }
        }
    }
    Ok(())
}

fn lock_source_tasks(root: &Path) -> Result<std::fs::File, WikiFailure> {
    let path = root.join(SOURCE_TASKS_LOCK_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| WikiFailure::io(path_text(&path), error))?;
    lock.lock()
        .map_err(|error| WikiFailure::io(path_text(&path), error))?;
    Ok(lock)
}

fn read_source_tasks(root: &Path) -> Result<Vec<WikiSourceTask>, WikiFailure> {
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    if recover_source_tasks_unlocked(root, &mut tasks)? {
        write_json(root.join(SOURCE_TASKS_FILE), &tasks)?;
    }
    Ok(tasks)
}

pub(super) fn recover_source_tasks(root: &Path) -> Result<(), WikiFailure> {
    read_source_tasks(root).map(|_| ())
}

fn recover_source_tasks_unlocked(root: &Path, tasks: &mut [WikiSourceTask]) -> Result<bool, WikiFailure> {
    let mut changed = false;
    for task in tasks {
        if task.is_paused() || !(task.status() == &WikiSourceTaskStatus::Running
            || (task.status() == &WikiSourceTaskStatus::Pending && task.is_queued())) {
            continue;
        }
        if let Some(_execution_lock) = super::source_execution::try_source_execution_lock(root, task.source_path())? {
            if task.cancel_requested() {
                task.mark_cancelled();
            } else {
                task.mark_failed("Source execution interrupted; retry to resume.".to_owned());
            }
            changed = true;
        }
    }
    Ok(changed)
}

fn read_source_tasks_unlocked(root: &Path) -> Result<Vec<WikiSourceTask>, WikiFailure> {
    read_json(root.join(SOURCE_TASKS_FILE))
}

fn update_source_task_for_run(
    root: &Path,
    project_id: &str,
    source_path: &str,
    predicate: impl Fn(&WikiSourceTask) -> bool,
) -> Result<WikiSourceTaskRunPlan, WikiFailure> {
    let source_relative_path = source_relative_path(root, source_path)?;
    let _tasks_lock = lock_source_tasks(root)?;
    let mut tasks = read_source_tasks_unlocked(root)?;
    recover_source_tasks_unlocked(root, &mut tasks)?;
    let mut staged = None;
    let mut task_id = None;
    if let Some(task) = latest_source_task_mut(&mut tasks, project_id, &source_relative_path) {
        task_id = Some(task.id().to_owned());
        if predicate(task) {
            let lock = super::source_execution::try_source_execution_lock(root, task.source_path())?
                .ok_or_else(|| WikiFailure::state("source already has an active execution"))?;
            staged = task_staged_source(root, task)?;
            task.restart();
            if let Some(staged) = staged.as_mut() {
                staged.task_id = task.id().to_owned();
                staged.execution = Some(super::source_execution::SourceExecution::new(lock, root, staged.task_id.clone()));
                task.mark_pending(Some("queued".to_owned()));
            }
        }
    }
    write_json(root.join(SOURCE_TASKS_FILE), &tasks)?;
    Ok(WikiSourceTaskRunPlan {
        project_id: project_id.to_owned(),
        source_relative_path,
        task_id,
        staged,
    })
}

fn latest_source_task_mut<'a>(
    tasks: &'a mut [WikiSourceTask],
    project_id: &str,
    source_relative_path: &str,
) -> Option<&'a mut WikiSourceTask> {
    tasks
        .iter_mut()
        .rev()
        .find(|task| task.project_id() == project_id && task.source_path() == source_relative_path)
}

fn task_staged_source(
    root: &Path,
    task: &WikiSourceTask,
) -> Result<Option<WikiStagedImportSource>, WikiFailure> {
    if matches!(
        task.kind(),
        WikiSourceTaskKind::Created
            | WikiSourceTaskKind::Modified
            | WikiSourceTaskKind::Imported
            | WikiSourceTaskKind::Generated
    ) {
        let source_path = root.join(task.source_path());
        if !source_path.is_file() {
            return Ok(None);
        }
        return staged_raw_source(
            task.project_id(),
            root,
            source_path,
            task.source_path().to_owned(),
            task.kind().clone(),
        )
        .map(Some);
    }
    Ok(None)
}

fn task_is_open(task: &WikiSourceTask) -> bool {
    matches!(
        task.status(),
        WikiSourceTaskStatus::Pending
            | WikiSourceTaskStatus::Running
            | WikiSourceTaskStatus::Failed
    )
}

fn task_is_active(task: &WikiSourceTask) -> bool {
    matches!(task.status(), WikiSourceTaskStatus::Pending | WikiSourceTaskStatus::Running)
}

fn unique_source_task_id(tasks: &[WikiSourceTask], project_id: &str, source_path: &str, mut timestamp: u64) -> String {
    loop {
        let id = source_task_id(project_id, source_path, timestamp);
        if !tasks.iter().any(|task| task.id() == id) {
            return id;
        }
        timestamp += 1;
    }
}

fn source_task_id(project_id: &str, source_path: &str, timestamp: u64) -> String {
    format!(
        "{}-{timestamp}",
        stable_content_hash(format!("{project_id}:{source_path}").as_bytes())
    )
}

fn extension_suffix(path: &str) -> &str {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| &path[path.len() - extension.len() - 1..])
        .unwrap_or("")
}

fn readable_slug_part(part: &str) -> String {
    let mut out = String::new();
    for character in part.trim().chars() {
        if character.is_alphanumeric() {
            out.extend(character.to_lowercase());
        } else if character.is_whitespace() || character == '-' {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').replace("--", "-");
    if out.is_empty() {
        "source".to_owned()
    } else {
        out
    }
}

fn stable_slug_hash(value: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for character in value.chars() {
        hash ^= character as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    to_base36(hash)
}

fn to_base36(mut value: u32) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        out.push(match digit {
            0..=9 => (b'0' + digit) as char,
            _ => (b'a' + digit - 10) as char,
        });
        value /= 36;
    }
    out.iter().rev().collect()
}

fn glob_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.to_ascii_lowercase().chars().collect::<Vec<_>>();
    let value = value.to_ascii_lowercase().chars().collect::<Vec<_>>();
    let (mut p, mut v) = (0usize, 0usize);
    let mut star = None;
    let mut match_after_star = 0usize;
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            match_after_star = v;
            p += 1;
        } else if let Some(star_pos) = star {
            p = star_pos + 1;
            match_after_star += 1;
            v = match_after_star;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

pub(super) fn refresh_file_snapshot(
    root: &Path,
    relative_paths: &[&str],
) -> Result<(), WikiFailure> {
    let mut snapshot = read_json::<FileSnapshot>(root.join(FILE_SNAPSHOT))?;
    for relative_path in relative_paths {
        if !is_default_watch_tracked_file(relative_path) {
            snapshot.entries.remove(*relative_path);
            continue;
        }
        let path = resolve_project_path(root, relative_path)?;
        if path.is_file() {
            let metadata = std::fs::metadata(&path)
                .map_err(|error| WikiFailure::io(path_text(&path), error))?;
            let bytes =
                std::fs::read(&path).map_err(|error| WikiFailure::io(path_text(&path), error))?;
            snapshot.entries.insert(
                (*relative_path).to_owned(),
                FileSnapshotEntry {
                    revision: stable_content_hash(&bytes),
                    size: metadata.len(),
                    modified_at_ms: metadata.modified().map(system_time_ms).unwrap_or_default(),
                },
            );
        } else {
            snapshot.entries.remove(*relative_path);
        }
    }
    write_json(root.join(FILE_SNAPSHOT), &snapshot)?;
    let mut changes = read_json::<Vec<FileChange>>(root.join(FILE_CHANGE_QUEUE))?;
    changes.retain(|change| {
        !relative_paths
            .iter()
            .any(|relative_path| change.relative_path == *relative_path)
    });
    write_json(root.join(FILE_CHANGE_QUEUE), &changes)
}

fn is_snapshot_ignored(relative_path: &str) -> bool {
    relative_path == ".llm-wiki"
        || relative_path.starts_with(".llm-wiki/")
        || relative_path == WIKI_MEDIA_DIR
        || relative_path.starts_with("wiki/media/")
        || relative_path == "raw/sources/.cache"
        || relative_path.starts_with("raw/sources/.cache/")
        || relative_path.contains("/.cache/")
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshot {
    entries: BTreeMap<String, FileSnapshotEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshotEntry {
    revision: String,
    size: u64,
    modified_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileChange {
    kind: String,
    relative_path: String,
    revision: String,
}

fn read_json<T: DeserializeOwned + Default>(path: impl AsRef<Path>) -> Result<T, WikiFailure> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(T::default());
    }
    let bytes = std::fs::read(path).map_err(|error| WikiFailure::io(path_text(path), error))?;
    serde_json::from_slice(&bytes).map_err(|error| WikiFailure::state(error.to_string()))
}

fn write_json(path: impl AsRef<Path>, value: &impl Serialize) -> Result<(), WikiFailure> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| WikiFailure::io(path_text(parent), error))?;
    }
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| WikiFailure::state(error.to_string()))?;
    std::fs::write(path, bytes).map_err(|error| WikiFailure::io(path_text(path), error))
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("wiki-source-lifecycle-{name}-{}", now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn schema_routing_drops_wrong_directory() {
        let routing = parse_schema_routing(
            "# Schema\n\n## Page Types\n\n| Type | Directory |\n| --- | --- |\n| source | wiki/sources |\n| concept | wiki/concepts |\n",
        );
        let message = validate_schema_routing(
            "wiki/concepts/flash.md",
            "---\ntype: source\ntitle: Flash\n---\n# Flash",
            &routing,
        )
        .unwrap();
        assert!(message.contains("type \"source\""));
        assert!(message.contains("wiki/sources/"));
    }

    #[test]
    fn target_language_guard_keeps_source_and_drops_obvious_wrong_content() {
        let chinese = "---\ntype: concept\ntitle: Demo\n---\n# Demo\n这是一个中文段落，用来明显表示内容语言不是英文。这里有足够多的中文字符触发检测。";
        assert!(should_drop_for_target_language(
            "wiki/concepts/demo.md",
            chinese,
            Some("English")
        ));
        assert!(!should_drop_for_target_language(
            "wiki/sources/demo.md",
            chinese,
            Some("English")
        ));
    }

    #[test]
    fn rewrites_cjk_title_path_and_source_summary_media_refs() {
        let content = "---\ntitle: 注意力机制\n---\n# 注意力机制\n正文";
        assert_eq!(
            rewrite_ingest_path_from_title("wiki/concepts/attention.md", content, Some("Chinese")),
            "wiki/concepts/注意力机制.md"
        );
        assert_eq!(
            source_summary_media_refs("![x](media/a.png) <img src=\"media/a.png\">"),
            "![x](../media/a.png) <img src=\"../media/a.png\">"
        );
    }

    #[test]
    fn canonicalize_sources_rejects_private_and_absolute_paths() {
        let content =
            "---\nsources: [\"C:/secret.md\", \".llm-wiki\", \"raw/sources/docs/a.md\"]\n---\n# A";
        let out = canonicalize_sources_field(content, "docs/a.md");
        assert!(!out.contains("C:/secret.md"));
        assert!(!out.contains(".llm-wiki"));
        assert!(out.contains("sources: [\"docs/a.md\"]"));
    }

    #[test]
    fn migrates_legacy_source_summary_when_basename_is_unique() {
        let root = test_root("legacy-summary");
        std::fs::create_dir_all(root.join("raw/sources/nested")).unwrap();
        std::fs::create_dir_all(root.join(WIKI_SOURCES_DIR)).unwrap();
        std::fs::write(root.join("raw/sources/nested/a.md"), "a").unwrap();
        std::fs::write(
            root.join(format!("{WIKI_SOURCES_DIR}/a.md")),
            "---\nsources: [\"a.md\"]\n---\n# A",
        )
        .unwrap();
        let target = format!("{WIKI_SOURCES_DIR}/{}", source_summary_slug("nested/a.md")) + ".md";
        assert!(migrate_legacy_source_summary_if_safe(&root, "nested/a.md", &target).is_none());
        assert!(!root.join(format!("{WIKI_SOURCES_DIR}/a.md")).exists());
        assert!(
            std::fs::read_to_string(root.join(target))
                .unwrap()
                .contains("nested/a.md")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn source_task_lifecycle_matches_restart_pause_and_reorder_semantics() {
        let root = test_root("task-lifecycle");
        std::fs::create_dir_all(root.join("raw/sources/docs")).unwrap();
        std::fs::write(root.join("raw/sources/docs/a.md"), "a").unwrap();
        std::fs::write(root.join("raw/sources/docs/b.md"), "b").unwrap();
        std::fs::write(root.join("raw/sources/docs/c.md"), "c").unwrap();
        let paths = vec![
            "raw/sources/docs/a.md".to_owned(),
            "raw/sources/docs/b.md".to_owned(),
            "raw/sources/docs/c.md".to_owned(),
        ];
        append_source_task_paths(&root, "project", &paths, WikiSourceTaskKind::Modified).unwrap();

        let tasks = read_source_tasks(&root).unwrap();
        let a_id = tasks[0].id().to_owned();
        let b_id = tasks[1].id().to_owned();
        finish_source_execution(&root, &a_id, Some(&WikiFailure::state("failed"))).unwrap();
        let retry = retry_source_task(&root, "project", "raw/sources/docs/a.md").unwrap();
        assert_eq!(
            retry.staged.as_ref().unwrap().source_relative_path,
            "raw/sources/docs/a.md"
        );
        assert!(!read_source_tasks(&root).unwrap()[0].is_paused());

        mark_source_task_running(&root, &b_id, "generate", None).unwrap();
        pause_source_task(&root, "project", "raw/sources/docs/b.md").unwrap();
        assert!(read_source_tasks(&root).unwrap()[1].is_paused());
        finish_source_execution(&root, &b_id, Some(&WikiFailure::cancelled())).unwrap();
        assert!(read_source_tasks(&root).unwrap()[1].is_paused());
        let resume = resume_source_task(&root, "project", "raw/sources/docs/b.md").unwrap();
        assert_eq!(
            resume.staged.as_ref().unwrap().source_relative_path,
            "raw/sources/docs/b.md"
        );

        reorder_source_task(
            &root,
            "project",
            "raw/sources/docs/c.md",
            Some("raw/sources/docs/b.md"),
            None,
        )
        .unwrap();
        let order = read_source_tasks(&root)
            .unwrap()
            .into_iter()
            .map(|task| task.source_path().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            vec![
                "raw/sources/docs/a.md",
                "raw/sources/docs/c.md",
                "raw/sources/docs/b.md"
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn apply_generated_pages_enforces_routing_logs_warnings_and_updates_recent_index() {
        let root = test_root("apply");
        std::fs::create_dir_all(root.join("raw/sources/docs")).unwrap();
        std::fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        std::fs::write(root.join("raw/sources/docs/a.md"), "source").unwrap();
        std::fs::write(
            root.join("schema.md"),
            "# Schema\n\n## Page Types\n\n| Type | Directory |\n| --- | --- |\n| concept | wiki/concepts |\n| source | wiki/sources |\n",
        )
        .unwrap();
        std::fs::write(root.join("wiki/index.md"), "# Wiki Index\n").unwrap();

        let mut staged = staged_raw_source("project", &root, root.join("raw/sources/docs/a.md"), "raw/sources/docs/a.md".to_owned(), WikiSourceTaskKind::Generated).unwrap();
        append_source_tasks(&root, "project", std::slice::from_mut(&mut staged), true).unwrap();
        let receipt = apply_generated_pages(
            &root,
            "project",
            WikiApplyGeneratedPagesInput {
                project_id: Some("project".to_owned()),
                source_path: "raw/sources/docs/a.md".to_owned(),
                files: vec![
                    crate::domain::WikiGeneratedPageInput {
                        path: "wiki/concepts/ok.md".to_owned(),
                        content: "---\ntype: concept\ntitle: OK\nsources: [\"raw/sources/docs/a.md\"]\n---\n# OK\nEnglish body with enough words to avoid the short-content language bypass in tests."
                            .to_owned(),
                    },
                    crate::domain::WikiGeneratedPageInput {
                        path: "wiki/concepts/wrong.md".to_owned(),
                        content: "---\ntype: source\ntitle: Wrong\n---\n# Wrong".to_owned(),
                    },
                ],
                reviews: Vec::new(),
            },
            None,
            Some("hash-a".to_owned()),
            None,
            None,
            None,
            &staged.task_id,
        )
        .await
        .unwrap();
        staged.execution.as_ref().unwrap().finish(&Ok::<(), WikiFailure>(())).unwrap();

        let written = receipt
            .written_pages()
            .iter()
            .map(|page| page.relative_path())
            .collect::<Vec<_>>();
        assert!(written.contains(&"wiki/concepts/ok.md"));
        assert!(written.contains(&"wiki/log.md"));
        assert!(written.contains(&"wiki/index.md"));
        assert!(!root.join("wiki/concepts/wrong.md").exists());
        assert!(
            std::fs::read_to_string(root.join(".llm-wiki/ingest-warnings.log"))
                .unwrap()
                .contains("Dropped \"wiki/concepts/wrong.md\"")
        );
        assert!(
            std::fs::read_to_string(root.join("wiki/log.md"))
                .unwrap()
                .contains("ingest | docs/a.md")
        );
        assert!(
            std::fs::read_to_string(root.join("wiki/index.md"))
                .unwrap()
                .contains("## Recently Updated")
        );
        let cache = read_source_cache(&root).unwrap();
        assert!(!cache.entries.contains_key("docs/a.md"));
        let _ = std::fs::remove_dir_all(root);
    }
}
