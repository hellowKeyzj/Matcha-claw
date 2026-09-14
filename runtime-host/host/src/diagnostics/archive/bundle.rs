//! Data collection for the diagnostics archive.
//!
//! Collects two independent roots. The runtime data root that the peer runtime owns contributes
//! recent logs, per-agent session index and transcripts, whitelisted workspace documents, plugin
//! manifests and the redacted runtime config; the desktop shell's own log directory contributes its
//! recent logs. Collection is bounded and total: an unreadable, oversized or non-whitelisted input
//! is skipped so a busy runtime still yields a usable bundle instead of no bundle at all. The entry
//! order is diagnostic priority order, so truncation drops the least valuable inputs first.

use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    str,
    time::SystemTime,
};

use serde_json::Value;

pub(super) const HOST_STATE_ENTRY: &str = "diagnostics.json";
pub(super) const ENTRY_LIMIT: usize = 64;
pub(super) const ENTRY_BYTE_LIMIT: u64 = 128 * 1024;
pub(super) const TOTAL_CONTENT_LIMIT: u64 = 512 * 1024;

const RECENT_WINDOW_MS: u128 = 72 * 60 * 60 * 1000;
const MAX_DIRECTORY_DEPTH: usize = 8;
const MAX_ARCHIVE_PATH_LENGTH: usize = 160;
const RUNTIME_PREFIX: &str = "runtime";
const APP_LOG_PREFIX: &str = "userdata/logs";
const RUNTIME_CONFIG_FILE: &str = "openclaw.json";
const LOG_DIRECTORY: &str = "logs";
const AGENT_DIRECTORY: &str = "agents";
const SESSION_DIRECTORY: &str = "sessions";
const SESSION_INDEX_FILE: &str = "sessions.json";
const SESSION_TRANSCRIPT_SUFFIX: &str = ".jsonl";
const EXTENSION_DIRECTORY: &str = "extensions";
const PLUGIN_MANIFEST_FILE: &str = "openclaw.plugin.json";
const EXECUTION_DIRECTORY: &str = "executions";
const PACKAGE_DIRECTORY: &str = "packages";
const PACKAGE_FILE_WHITELIST: &[&str] = &["team.skill.json", "package.json", "README.md"];
const WORKSPACE_DIRECTORIES: &[&str] = &["workspace", "workspace-subagents"];
const WORKSPACE_FILE_WHITELIST: &[&str] = &[
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "MEMORY.md",
];
const REDACTED_VALUE: &str = "***";
const REDACTED_DOCUMENT: &[u8] = b"\"***\"";

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
    path: PathBuf,
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

/// Collects the sealed Host state document plus every collection root that is currently resolvable.
pub(super) fn collect(
    state_root: &Path,
    app_log_root: Option<&Path>,
    host_state: Vec<u8>,
) -> Vec<ArchiveEntry> {
    let runtime = Source::new(state_root, RUNTIME_PREFIX);
    let mut bundle = Bundle::new();
    bundle.push(HOST_STATE_ENTRY.to_owned(), host_state);
    bundle.collect_runtime_config(&runtime);
    bundle.collect_sessions(&runtime);
    bundle.collect_runtime_logs(&runtime);
    if let Some(app_log_root) = app_log_root {
        bundle.collect_app_logs(&Source::new(app_log_root, APP_LOG_PREFIX));
    }
    bundle.collect_workspace(&runtime);
    bundle.collect_execution_paths(&runtime);
    bundle.collect_package_paths(&runtime);
    bundle.collect_plugin_manifests(&runtime);
    bundle.entries
}

/// A canonical collection root paired with the archive prefix its files are named under. Every
/// traversal and every entry name is resolved against the root, so no collected path can escape it.
struct Source<'root> {
    root: &'root Path,
    prefix: &'static str,
}

impl<'root> Source<'root> {
    fn new(root: &'root Path, prefix: &'static str) -> Self {
        Self { root, prefix }
    }

    fn entry_name(&self, path: &Path) -> Option<String> {
        let relative = path.strip_prefix(self.root).ok()?;
        let mut name = String::from(self.prefix);
        for component in relative.components() {
            let Component::Normal(segment) = component else {
                return None;
            };
            name.push('/');
            name.push_str(segment.to_str()?);
        }
        (name.len() > self.prefix.len()).then_some(name)
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
        Some(ContainedFile { path, file })
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

    fn collect_runtime_config(&mut self, source: &Source<'_>) {
        let config = source.root.join(RUNTIME_CONFIG_FILE);
        self.push_file(source, &config, Redaction::SensitiveJson);
    }

    fn collect_sessions(&mut self, source: &Source<'_>) {
        for agent_id in agent_ids(source) {
            let sessions = source
                .root
                .join(AGENT_DIRECTORY)
                .join(agent_id)
                .join(SESSION_DIRECTORY);
            self.push_file(
                source,
                &sessions.join(SESSION_INDEX_FILE),
                Redaction::SafeJson,
            );
            self.walk(
                source,
                &sessions,
                &|name| name.ends_with(SESSION_TRANSCRIPT_SUFFIX),
                Recency::Recent,
            );
        }
    }

    fn collect_runtime_logs(&mut self, source: &Source<'_>) {
        let logs = source.root.join(LOG_DIRECTORY);
        self.walk(source, &logs, &|_| true, Recency::Recent);
    }

    /// The desktop shell's log directory is itself the root, so it is walked in place.
    fn collect_app_logs(&mut self, source: &Source<'_>) {
        self.walk(source, source.root, &|_| true, Recency::Recent);
    }

    fn collect_workspace(&mut self, source: &Source<'_>) {
        for directory in WORKSPACE_DIRECTORIES {
            let root = source.root.join(directory);
            self.walk(
                source,
                &root,
                &|name| WORKSPACE_FILE_WHITELIST.contains(&name),
                Recency::Any,
            );
        }
    }

    fn collect_execution_paths(&mut self, source: &Source<'_>) {
        let executions = source.root.join(EXECUTION_DIRECTORY);
        self.walk(source, &executions, &|_| true, Recency::Recent);
    }

    fn collect_package_paths(&mut self, source: &Source<'_>) {
        let packages = source.root.join(PACKAGE_DIRECTORY);
        self.walk(
            source,
            &packages,
            &|name| PACKAGE_FILE_WHITELIST.contains(&name),
            Recency::Any,
        );
    }

    fn collect_plugin_manifests(&mut self, source: &Source<'_>) {
        let extensions = source.root.join(EXTENSION_DIRECTORY);
        for extension in child_directory_names(&extensions) {
            let manifest = extensions.join(extension).join(PLUGIN_MANIFEST_FILE);
            self.push_file(source, &manifest, Redaction::SafeJson);
        }
    }

    fn walk(
        &mut self,
        source: &Source<'_>,
        root: &Path,
        accepts: &dyn Fn(&str) -> bool,
        recency: Recency,
    ) {
        let Some(root) = source.contained_directory(root) else {
            return;
        };
        let mut pending = vec![root];
        while let Some(directory) = pending.pop() {
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
                    pending.push(child.path());
                    continue;
                }
                let Some(name) = child.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if !kind.is_file() || !accepts(&name) {
                    continue;
                }
                if !child
                    .metadata()
                    .is_ok_and(|metadata| recency.admits(&metadata, self.cutoff_ms))
                {
                    continue;
                }
                self.push_file(source, &child.path(), Redaction::SafeText);
            }
        }
    }

    fn push_file(&mut self, source: &Source<'_>, path: &Path, redaction: Redaction) {
        if self.is_full() {
            return;
        }
        let Some(file) = source.contained_file(path) else {
            return;
        };
        let Some(name) = source.entry_name(&file.path) else {
            return;
        };
        let Some(content) = read_bounded_file(file) else {
            return;
        };
        self.push(name, redaction.apply(content));
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
    Any,
    Recent,
}

impl Recency {
    fn admits(self, metadata: &Metadata, cutoff_ms: u128) -> bool {
        match self {
            Self::Any => true,
            Self::Recent => metadata
                .modified()
                .is_ok_and(|modified| unix_millis(modified) >= cutoff_ms),
        }
    }
}

#[derive(Clone, Copy)]
enum Redaction {
    SafeText,
    SafeJson,
    SensitiveJson,
}

impl Redaction {
    fn apply(self, content: Vec<u8>) -> Vec<u8> {
        match self {
            Self::SafeText => redact_sensitive_text(&content),
            Self::SafeJson | Self::SensitiveJson => redact_sensitive_json(&content),
        }
    }
}

/// Configured agents plus agents that only left a session directory behind.
fn agent_ids(source: &Source<'_>) -> BTreeSet<String> {
    let mut ids = configured_agent_ids(source);
    ids.extend(child_directory_names(&source.root.join(AGENT_DIRECTORY)));
    ids
}

fn configured_agent_ids(source: &Source<'_>) -> BTreeSet<String> {
    let Some(config) = source.contained_file(&source.root.join(RUNTIME_CONFIG_FILE)) else {
        return BTreeSet::new();
    };
    let Some(raw) = read_bounded_file(config) else {
        return BTreeSet::new();
    };
    let Ok(document) = serde_json::from_slice::<Value>(&raw) else {
        return BTreeSet::new();
    };
    document
        .get("agents")
        .and_then(|agents| agents.get("list"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|agent| agent.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn child_directory_names(root: &Path) -> BTreeSet<String> {
    let Ok(children) = fs::read_dir(root) else {
        return BTreeSet::new();
    };
    children
        .flatten()
        .filter(|child| child.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|child| child.file_name().to_str().map(str::trim).map(str::to_owned))
        .filter(|name| !name.is_empty())
        .collect()
}

/// Replaces every string value held under a credential-shaped key with a fixed marker.
fn redact_sensitive_text(raw: &[u8]) -> Vec<u8> {
    let Ok(text) = str::from_utf8(raw) else {
        return REDACTED_DOCUMENT.to_vec();
    };
    let mut safe = String::with_capacity(text.len());
    for line in text.lines() {
        if !safe.is_empty() {
            safe.push('\n');
        }
        safe.push_str(&redact_sensitive_line(line));
    }
    safe.into_bytes()
}

fn redact_sensitive_line(line: &str) -> String {
    let mut start = 0;
    while let Some(relative) =
        line[start..].find(|character: char| character == ':' || character == '=')
    {
        let delimiter = start + relative;
        let key_start = line[..delimiter]
            .rfind(|character: char| {
                character.is_whitespace()
                    || character == '{'
                    || character == ','
                    || character == '['
            })
            .map_or(0, |index| index + 1);
        let key = line[key_start..delimiter].trim_matches(['"', '\'']);
        if is_sensitive_key(key) {
            return REDACTED_VALUE.to_owned();
        }
        start = delimiter + 1;
    }
    line.to_owned()
}

fn redact_sensitive_json(raw: &[u8]) -> Vec<u8> {
    let Ok(mut document) = serde_json::from_slice::<Value>(raw) else {
        return REDACTED_DOCUMENT.to_vec();
    };
    redact_sensitive_values(&mut document, "");
    serde_json::to_vec_pretty(&document).unwrap_or_else(|_| REDACTED_DOCUMENT.to_vec())
}

fn redact_sensitive_values(value: &mut Value, key: &str) {
    match value {
        Value::Object(members) => {
            for (member_key, member) in members {
                redact_sensitive_values(member, member_key);
            }
        }
        Value::Array(members) => {
            for member in members {
                redact_sensitive_values(member, key);
            }
        }
        Value::String(text) if is_sensitive_key(key) && !text.trim().is_empty() => {
            *text = REDACTED_VALUE.to_owned();
        }
        _ => {}
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key == "key"
        || [
            "token",
            "secret",
            "password",
            "apikey",
            "api_key",
            "authorization",
            "cookie",
            "proxy",
        ]
        .iter()
        .any(|marker| key.contains(marker))
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
    fn runtime_bundle_recovers_the_full_runtime_data_layout() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let state_root = fs::canonicalize(&state_root).unwrap();

        let entries = collected(&state_root, None);

        assert!(entries.contains_key(HOST_STATE_ENTRY));
        for expected in [
            "runtime/openclaw.json",
            "runtime/logs/runtime.log",
            "runtime/logs/nested/gateway.log",
            "runtime/agents/reviewer/sessions/sessions.json",
            "runtime/agents/reviewer/sessions/session-1.jsonl",
            "runtime/agents/configured/sessions/sessions.json",
            "runtime/workspace/AGENTS.md",
            "runtime/workspace-subagents/child/MEMORY.md",
            "runtime/executions/run-1/package-path.txt",
            "runtime/packages/team-reviewer/team.skill.json",
            "runtime/packages/team-reviewer/README.md",
            "runtime/extensions/browser/openclaw.plugin.json",
        ] {
            assert!(entries.contains_key(expected), "missing entry {expected}");
        }
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn runtime_bundle_excludes_unlisted_stale_and_oversized_inputs() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let oversized = vec![b'x'; ENTRY_BYTE_LIMIT as usize + 1];
        fs::write(state_root.join("logs").join("oversized.log"), oversized).unwrap();
        let state_root = fs::canonicalize(&state_root).unwrap();

        let entries = collected(&state_root, None);

        for excluded in [
            "runtime/workspace/notes.txt",
            "runtime/logs/oversized.log",
            "runtime/agents/reviewer/sessions/stale.jsonl",
            "runtime/packages/team-reviewer/private.env",
            "runtime/extensions/browser/package.json",
        ] {
            assert!(
                !entries.contains_key(excluded),
                "unexpected entry {excluded}"
            );
        }
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn runtime_config_credentials_are_redacted_in_place() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let state_root = fs::canonicalize(&state_root).unwrap();

        let mut entries = collected(&state_root, None);
        let config = String::from_utf8(entries.remove("runtime/openclaw.json").unwrap()).unwrap();

        assert!(!config.contains("config-token-canary"));
        assert!(!config.contains("nested-secret-canary"));
        assert!(config.contains(REDACTED_VALUE));
        assert!(config.contains("configured"));
        assert!(config.contains("8080"));
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn sensitive_keys_cover_credential_shapes_without_swallowing_plain_fields() {
        for sensitive in [
            "token",
            "accessToken",
            "apiKey",
            "api_key",
            "key",
            "PASSWORD",
            "authorization",
            "cookie",
            "proxyUrl",
            "clientSecret",
        ] {
            assert!(is_sensitive_key(sensitive), "{sensitive} must be sensitive");
        }
        for plain in ["id", "model", "keyring_label", "lifecycle", "workspace"] {
            assert!(!is_sensitive_key(plain), "{plain} must stay verbatim");
        }
    }

    #[test]
    fn safe_text_redaction_removes_sensitive_diagnostics_canaries() {
        let raw = br#"pid=4321 argv=["runtime-host", "--token=argv-token"] path=C:\private\runtime token=log-token secret=log-secret payload={"native":true}"#;

        let safe = String::from_utf8(redact_sensitive_text(raw)).unwrap();

        assert!(!safe.contains("4321"));
        assert!(!safe.contains("runtime-host"));
        assert!(!safe.contains("argv-token"));
        assert!(!safe.contains("C:\\private\\runtime"));
        assert!(!safe.contains("log-token"));
        assert!(!safe.contains("log-secret"));
        assert!(!safe.contains("native"));
        assert!(safe.contains(REDACTED_VALUE));
    }

    /// The desktop log directory lives outside the runtime state root in production, so the two
    /// sources must contribute independently and neither may name a file under the other's prefix.
    #[test]
    fn app_logs_are_collected_under_their_own_prefix_beside_the_runtime_root() {
        let state_root = fixture_root();
        let app_log_root = fixture_root();
        write_runtime_fixture(&state_root);
        write_app_log_fixture(&app_log_root);
        let state_root = fs::canonicalize(&state_root).unwrap();
        let app_log_root = fs::canonicalize(&app_log_root).unwrap();

        let entries = collected(&state_root, Some(&app_log_root));

        assert!(entries.contains_key("userdata/logs/main.log"));
        assert!(entries.contains_key("userdata/logs/nested/renderer.log"));
        assert!(!entries.contains_key("userdata/logs/stale.log"));
        assert!(entries.contains_key("runtime/logs/runtime.log"));
        assert!(entries.contains_key("runtime/openclaw.json"));
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
        assert!(entries.contains_key("runtime/logs/runtime.log"));
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn entry_names_reject_escapes_and_keep_the_source_prefix() {
        let runtime = Source::new(Path::new("/state"), RUNTIME_PREFIX);
        let app_logs = Source::new(Path::new("/userData/logs"), APP_LOG_PREFIX);

        assert_eq!(
            runtime.entry_name(Path::new("/state/logs/runtime.log")),
            Some("runtime/logs/runtime.log".to_owned())
        );
        assert_eq!(
            app_logs.entry_name(Path::new("/userData/logs/main.log")),
            Some("userdata/logs/main.log".to_owned())
        );
        assert_eq!(runtime.entry_name(Path::new("/state")), None);
        assert_eq!(runtime.entry_name(Path::new("/elsewhere/x")), None);
        assert_eq!(app_logs.entry_name(Path::new("/userData")), None);
    }

    fn collected(state_root: &Path, app_log_root: Option<&Path>) -> BTreeMap<String, Vec<u8>> {
        collect(state_root, app_log_root, b"{}".to_vec())
            .into_iter()
            .map(|entry| (entry.name, entry.content))
            .collect()
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
