//! Data collection for the diagnostics archive.
//!
//! The archive carries only sealed host diagnostics and bounded log projections. It deliberately does
//! not copy peer runtime config, transcripts, workspace files, package material or plugin/native
//! manifests: those are private runtime facts, not diagnostic output.

use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};

pub(super) const HOST_STATE_ENTRY: &str = "diagnostics.json";
pub(super) const ENTRY_LIMIT: usize = 64;
pub(super) const ENTRY_BYTE_LIMIT: u64 = 128 * 1024;
pub(super) const TOTAL_CONTENT_LIMIT: u64 = 512 * 1024;

const RECENT_WINDOW_MS: u128 = 72 * 60 * 60 * 1000;
const MAX_DIRECTORY_DEPTH: usize = 8;
const MAX_ARCHIVE_PATH_LENGTH: usize = 160;
const RUNTIME_PREFIX: &str = "runtime";
const APP_LOG_PREFIX: &str = "userdata/logs";
const LOG_DIRECTORY: &str = "logs";

pub(super) struct ArchiveEntry {
    pub(super) name: String,
    pub(super) content: Vec<u8>,
}

fn is_allowed_entry_name(name: &str) -> bool {
    if name.len() > MAX_ARCHIVE_PATH_LENGTH || name.starts_with('/') {
        return false;
    }
    let segments = name.split('/').collect::<Vec<_>>();
    let allowed_root = match segments.as_slice() {
        [RUNTIME_PREFIX, ..] => true,
        ["userdata", "logs", ..] => true,
        _ => false,
    };
    allowed_root
        && segments.len() <= MAX_DIRECTORY_DEPTH
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && !segment.contains(['\\', '\0'])
        })
}

struct ContainedFile {
    file: File,
}

fn read_bounded_file(collected: ContainedFile) -> Option<Vec<u8>> {
    let file = collected.file;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > ENTRY_BYTE_LIMIT
    {
        return None;
    }
    let mut content = Vec::with_capacity(metadata.len() as usize);
    file.take(ENTRY_BYTE_LIMIT + 1)
        .read_to_end(&mut content)
        .ok()?;
    (content.len() as u64 <= ENTRY_BYTE_LIMIT).then_some(content)
}

fn open_collected_file(path: &Path) -> std::io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        return OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(path);
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

        return OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path);
    }

    #[cfg(not(any(unix, windows)))]
    OpenOptions::new().read(true).open(path)
}

#[cfg(unix)]
#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;

        Some(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    fn matches(self, metadata: &Metadata) -> bool {
        Self::from_metadata(metadata) == Some(self)
    }
}

#[cfg(windows)]
#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    attributes: u32,
    created: u64,
    modified: u64,
    size: u64,
}

#[cfg(windows)]
impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Option<Self> {
        use std::os::windows::fs::MetadataExt;

        Some(Self {
            attributes: metadata.file_attributes(),
            created: metadata.creation_time(),
            modified: metadata.last_write_time(),
            size: metadata.file_size(),
        })
    }

    fn matches(self, metadata: &Metadata) -> bool {
        Self::from_metadata(metadata) == Some(self)
    }
}

#[cfg(not(any(unix, windows)))]
#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity;

#[cfg(not(any(unix, windows)))]
impl FileIdentity {
    fn from_metadata(_metadata: &Metadata) -> Option<Self> {
        Some(Self)
    }

    fn matches(self, _metadata: &Metadata) -> bool {
        true
    }
}

/// Collects the sealed Host state document plus safe projections of recent diagnostic logs.
pub(super) fn collect(
    state_root: &Path,
    app_log_root: Option<&Path>,
    host_state: Vec<u8>,
) -> Vec<ArchiveEntry> {
    let runtime = Source::new(state_root);
    let mut bundle = Bundle::new();
    bundle.push(HOST_STATE_ENTRY.to_owned(), host_state);
    bundle.collect_runtime_logs(&runtime);
    if let Some(app_log_root) = app_log_root {
        bundle.collect_app_logs(&Source::new(app_log_root));
    }
    bundle.entries
}

/// A canonical collection root. Every traversal is resolved against the root, so no collected file
/// can escape it; archive entry names are generated and never reuse native path segments.
struct Source<'root> {
    root: &'root Path,
}

impl<'root> Source<'root> {
    fn new(root: &'root Path) -> Self {
        Self { root }
    }

    fn contained_file(&self, path: &Path) -> Option<ContainedFile> {
        let path = fs::canonicalize(path).ok()?;
        let metadata = fs::metadata(&path).ok()?;
        if !path.starts_with(self.root) || !metadata.is_file() || metadata.file_type().is_symlink()
        {
            return None;
        }
        let identity = FileIdentity::from_metadata(&metadata)?;
        let file = open_collected_file(&path).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > ENTRY_BYTE_LIMIT
            || !identity.matches(&metadata)
        {
            return None;
        }
        Some(ContainedFile { file })
    }

    fn contained_directory(&self, path: &Path) -> Option<PathBuf> {
        let path = fs::canonicalize(path).ok()?;
        (path.starts_with(self.root) && path.is_dir()).then_some(path)
    }
}

struct Bundle {
    cutoff_ms: u128,
    content_bytes: u64,
    entries: Vec<ArchiveEntry>,
}

impl Bundle {
    fn new() -> Self {
        Self {
            cutoff_ms: unix_millis(SystemTime::now()).saturating_sub(RECENT_WINDOW_MS),
            content_bytes: 0,
            entries: Vec::new(),
        }
    }

    fn collect_runtime_logs(&mut self, source: &Source<'_>) {
        let logs = source.root.join(LOG_DIRECTORY);
        self.walk_logs(source, &logs, "runtime/logs");
    }

    /// The desktop shell's log directory is itself the root, so it is walked in place.
    fn collect_app_logs(&mut self, source: &Source<'_>) {
        self.walk_logs(source, source.root, APP_LOG_PREFIX);
    }

    fn walk_logs(&mut self, source: &Source<'_>, root: &Path, archive_prefix: &'static str) {
        let Some(root) = source.contained_directory(root) else {
            return;
        };
        let mut pending = vec![(root, 0_usize)];
        while let Some((directory, depth)) = pending.pop() {
            if self.is_full() {
                return;
            }
            let Ok(children) = fs::read_dir(&directory) else {
                continue;
            };
            for child in children.flatten() {
                let Ok(kind) = child.file_type() else {
                    continue;
                };
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    if depth + 1 < MAX_DIRECTORY_DEPTH {
                        pending.push((child.path(), depth + 1));
                    }
                    continue;
                }
                if !kind.is_file()
                    || !child
                        .metadata()
                        .is_ok_and(|metadata| Recency::Recent.admits(&metadata, self.cutoff_ms))
                {
                    continue;
                }
                self.push_log_summary(source, &child.path(), archive_prefix);
            }
        }
    }

    fn push_log_summary(&mut self, source: &Source<'_>, path: &Path, archive_prefix: &'static str) {
        if self.is_full() {
            return;
        }
        let Some(file) = source.contained_file(path) else {
            return;
        };
        let Some(content) = read_bounded_file(file) else {
            return;
        };
        let index = self
            .entries
            .iter()
            .filter(|entry| entry.name.starts_with(archive_prefix))
            .count();
        self.push(
            format!("{archive_prefix}/log-{index:03}.txt"),
            project_log_summary(&content),
        );
    }

    fn push(&mut self, name: String, content: Vec<u8>) {
        if self.is_full()
            || (name != HOST_STATE_ENTRY && !is_allowed_entry_name(&name))
            || content.len() as u64 > ENTRY_BYTE_LIMIT
            || self.content_bytes.saturating_add(content.len() as u64) > TOTAL_CONTENT_LIMIT
        {
            return;
        }
        self.content_bytes = self.content_bytes.saturating_add(content.len() as u64);
        self.entries.push(ArchiveEntry { name, content });
    }

    fn is_full(&self) -> bool {
        self.entries.len() >= ENTRY_LIMIT
    }
}

#[derive(Clone, Copy)]
enum Recency {
    Recent,
}

impl Recency {
    fn admits(self, metadata: &Metadata, cutoff_ms: u128) -> bool {
        match self {
            Self::Recent => metadata
                .modified()
                .is_ok_and(|modified| unix_millis(modified) >= cutoff_ms),
        }
    }
}

fn project_log_summary(raw: &[u8]) -> Vec<u8> {
    let (utf8, lines) = match std::str::from_utf8(raw) {
        Ok(text) => (true, text.lines().count()),
        Err(_) => (false, 0),
    };
    format!(
        "redacted=true\nkind=diagnosticLog\nbytes={}\nlines={}\nutf8={}\n",
        raw.len(),
        lines,
        utf8
    )
    .into_bytes()
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::diagnostics::archive::tests::{fixture_root, write_runtime_fixture};

    #[test]
    fn runtime_bundle_carries_only_host_state_and_log_projections() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let state_root = fs::canonicalize(&state_root).unwrap();

        let entries = collected(&state_root, None);

        assert!(entries.contains_key(HOST_STATE_ENTRY));
        assert!(
            entries
                .keys()
                .any(|name| name == "runtime/logs/log-000.txt")
        );
        assert!(
            entries
                .keys()
                .any(|name| name == "runtime/logs/log-001.txt")
        );
        for name in entries.keys() {
            assert!(
                name == HOST_STATE_ENTRY || name.starts_with("runtime/logs/log-"),
                "unexpected diagnostics entry {name}"
            );
        }
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn runtime_bundle_excludes_private_runtime_sources_and_oversized_logs() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let oversized = vec![b'x'; ENTRY_BYTE_LIMIT as usize + 1];
        fs::write(state_root.join("logs").join("oversized.log"), oversized).unwrap();
        let state_root = fs::canonicalize(&state_root).unwrap();

        let entries = collected(&state_root, None);

        for excluded in [
            "openclaw.json",
            "agents",
            "sessions",
            "workspace",
            "workspace-subagents",
            "executions",
            "packages",
            "extensions",
            "private.env",
            "oversized",
        ] {
            assert!(
                !entries.keys().any(|name| name.contains(excluded)),
                "unexpected private entry containing {excluded}"
            );
        }
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn runtime_config_credentials_are_not_collected() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let state_root = fs::canonicalize(&state_root).unwrap();

        let entries = collected(&state_root, None);
        let rendered = render_entries(&entries);

        assert!(!entries.contains_key("runtime/openclaw.json"));
        assert!(!rendered.contains("config-token-canary"));
        assert!(!rendered.contains("nested-secret-canary"));
        assert!(!rendered.contains("configured"));
        assert!(!rendered.contains("8080"));
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn log_projection_never_includes_raw_diagnostic_content() {
        let raw = br#"pid=4321 argv=["runtime-host", "--token=argv-token"] path=C:\private\runtime token=log-token secret=log-secret payload={"native":true}"#;

        let safe = String::from_utf8(project_log_summary(raw)).unwrap();

        for forbidden in [
            "4321",
            "runtime-host",
            "argv-token",
            "C:\\private\\runtime",
            "log-token",
            "log-secret",
            "native",
            "payload",
        ] {
            assert!(!safe.contains(forbidden));
        }
        assert!(safe.contains("redacted=true"));
        assert!(safe.contains("kind=diagnosticLog"));
    }

    /// The desktop log directory lives outside the runtime state root in production, so the two
    /// sources must contribute independently and neither may reuse native file names in the archive.
    #[test]
    fn app_logs_are_collected_under_their_own_anonymous_prefix() {
        let state_root = fixture_root();
        let app_log_root = fixture_root();
        write_runtime_fixture(&state_root);
        write_app_log_fixture(&app_log_root);
        let state_root = fs::canonicalize(&state_root).unwrap();
        let app_log_root = fs::canonicalize(&app_log_root).unwrap();

        let entries = collected(&state_root, Some(&app_log_root));

        assert!(entries.contains_key("userdata/logs/log-000.txt"));
        assert!(entries.contains_key("userdata/logs/log-001.txt"));
        assert!(!entries.keys().any(|name| name.contains("main.log")));
        assert!(!entries.keys().any(|name| name.contains("renderer.log")));
        assert!(!entries.keys().any(|name| name.contains("stale.log")));
        assert!(entries.contains_key("runtime/logs/log-000.txt"));
        assert!(!entries.contains_key("userdata/logs/openclaw.json"));
        let _ = fs::remove_dir_all(state_root);
        let _ = fs::remove_dir_all(app_log_root);
    }

    /// A fresh profile has no desktop log directory yet; that must cost the app log entries only.
    #[test]
    fn a_missing_app_log_root_still_yields_the_runtime_bundle() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let state_root = fs::canonicalize(&state_root).unwrap();
        let absent = state_root.join("absent-app-logs");

        let entries = collected(&state_root, Some(&absent));

        assert!(!entries.keys().any(|name| name.starts_with(APP_LOG_PREFIX)));
        assert!(entries.contains_key("runtime/logs/log-000.txt"));
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn generated_entry_names_reject_native_path_escapes() {
        for rejected in [
            "/runtime/logs/log-000.txt",
            "runtime/../logs/log-000.txt",
            "runtime/logs/native\\path.txt",
            "userdata/logs/\0.txt",
            "elsewhere/logs/log-000.txt",
        ] {
            assert!(
                !is_allowed_entry_name(rejected),
                "{rejected} must be rejected"
            );
        }
        assert!(is_allowed_entry_name("runtime/logs/log-000.txt"));
        assert!(is_allowed_entry_name("userdata/logs/log-000.txt"));
    }

    fn collected(state_root: &Path, app_log_root: Option<&Path>) -> BTreeMap<String, Vec<u8>> {
        collect(state_root, app_log_root, b"{}".to_vec())
            .into_iter()
            .map(|entry| (entry.name, entry.content))
            .collect()
    }

    fn render_entries(entries: &BTreeMap<String, Vec<u8>>) -> String {
        entries
            .iter()
            .map(|(name, content)| format!("{name}\n{}", String::from_utf8_lossy(content)))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Mirrors the desktop shell log directory, including a log past the recency window.
    fn write_app_log_fixture(app_log_root: &Path) {
        fs::create_dir_all(app_log_root.join("nested")).unwrap();
        fs::write(app_log_root.join("main.log"), b"main log line").unwrap();
        fs::write(
            app_log_root.join("nested/renderer.log"),
            b"renderer log line",
        )
        .unwrap();
        let stale = app_log_root.join("stale.log");
        fs::write(&stale, b"stale log line").unwrap();
        let moment = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1);
        fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(moment)
            .unwrap();
    }
}
