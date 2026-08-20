//! Diagnostics archive admission, bounding and terminal receipt projection.
//!
//! An admitted request owns one archive identity for its whole lifetime: the sealed Host state
//! document and the runtime bundle are encoded in memory, bounded, published atomically and then
//! reported through a receipt that carries only the opaque identity, the terminal and the archive
//! size. Runtime facts, filesystem paths and raw errors never reach the receipt.

mod bundle;
mod output;
mod zip;

use getrandom::fill;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

pub(crate) use output::DiagnosticsArchiveRoot;

use super::HostState;

pub(crate) const ARCHIVE_BYTE_LIMIT: u64 = 2 * 1024 * 1024;
const ARCHIVE_ID_BYTES: usize = 16;
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticsArchiveTerminal {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticsArchiveError {
    InvalidRoot,
    OutputUnavailable,
    ArchiveNotFound,
    ArchiveIdUnavailable,
}

impl std::fmt::Display for DiagnosticsArchiveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRoot => "diagnostics archive root is invalid",
            Self::OutputUnavailable => "diagnostics archive output is unavailable",
            Self::ArchiveNotFound => "diagnostics archive was not found",
            Self::ArchiveIdUnavailable => "diagnostics archive identifier is unavailable",
        })
    }
}

impl std::error::Error for DiagnosticsArchiveError {}

/// The sealed Host state document carried as the first archive entry.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveHostState {
    ok: bool,
    lifecycle: super::HostLifecycle,
    matcha: ArchiveRuntimeState,
    open_claw: ArchiveRuntimeState,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveRuntimeState {
    lifecycle: super::RuntimeLifecycle,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<super::RuntimeFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    startup_diagnostic: Option<super::RuntimeStartupDiagnostic>,
}

impl From<&HostState> for ArchiveHostState {
    fn from(state: &HostState) -> Self {
        Self {
            ok: state.ok(),
            lifecycle: state.lifecycle(),
            matcha: ArchiveRuntimeState::from(state.matcha()),
            open_claw: ArchiveRuntimeState::from(state.open_claw()),
        }
    }
}

impl From<&super::RuntimeState> for ArchiveRuntimeState {
    fn from(state: &super::RuntimeState) -> Self {
        Self {
            lifecycle: state.lifecycle(),
            failure: state.failure(),
            startup_diagnostic: state.startup_diagnostic(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsArchiveReceipt {
    archive_id: String,
    terminal: DiagnosticsArchiveTerminalWire,
    entries: usize,
    bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum DiagnosticsArchiveTerminalWire {
    Completed,
    Cancelled,
    Failed,
}

impl From<DiagnosticsArchiveTerminal> for DiagnosticsArchiveTerminalWire {
    fn from(value: DiagnosticsArchiveTerminal) -> Self {
        match value {
            DiagnosticsArchiveTerminal::Completed => Self::Completed,
            DiagnosticsArchiveTerminal::Cancelled => Self::Cancelled,
            DiagnosticsArchiveTerminal::Failed => Self::Failed,
        }
    }
}

impl DiagnosticsArchiveReceipt {
    /// A terminal without a published archive carries no entry or byte count.
    fn terminated(archive_id: String, terminal: DiagnosticsArchiveTerminal) -> Self {
        Self {
            archive_id,
            terminal: terminal.into(),
            entries: 0,
            bytes: 0,
        }
    }

    fn completed(archive_id: String, entries: usize, bytes: u64) -> Self {
        Self {
            archive_id,
            terminal: DiagnosticsArchiveTerminal::Completed.into(),
            entries,
            bytes,
        }
    }

    pub(crate) fn failed() -> Self {
        Self::terminated("unavailable".to_owned(), DiagnosticsArchiveTerminal::Failed)
    }

    pub fn archive_id(&self) -> &str {
        &self.archive_id
    }

    pub(crate) fn has_opaque_archive_id(&self) -> bool {
        self.archive_id.len() == ARCHIVE_ID_BYTES * 2
            && self
                .archive_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (byte.is_ascii_lowercase() && byte <= b'f'))
    }

    pub fn terminal(&self) -> DiagnosticsArchiveTerminal {
        match self.terminal {
            DiagnosticsArchiveTerminalWire::Completed => DiagnosticsArchiveTerminal::Completed,
            DiagnosticsArchiveTerminalWire::Cancelled => DiagnosticsArchiveTerminal::Cancelled,
            DiagnosticsArchiveTerminalWire::Failed => DiagnosticsArchiveTerminal::Failed,
        }
    }

    pub fn entries(&self) -> usize {
        self.entries
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }
}

#[derive(Clone)]
pub(crate) struct DiagnosticsArchiveCancellation(CancellationToken);

pub(crate) struct DiagnosticsArchiveCancellationGuard(DiagnosticsArchiveCancellation);

impl DiagnosticsArchiveCancellation {
    pub(crate) fn new() -> Self {
        Self(CancellationToken::new())
    }

    pub(crate) fn cancel(&self) {
        self.0.cancel();
    }

    pub(crate) fn cancel_on_drop(&self) -> DiagnosticsArchiveCancellationGuard {
        DiagnosticsArchiveCancellationGuard(self.clone())
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }
}

impl Drop for DiagnosticsArchiveCancellationGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[derive(Clone)]
pub(crate) struct DiagnosticsArchiveProducer {
    root: DiagnosticsArchiveRoot,
}

/// A single admitted archive request bound to the Host state observed at admission time.
pub(crate) struct DiagnosticsArchiveAdmission {
    producer: DiagnosticsArchiveProducer,
    state: HostState,
}

impl DiagnosticsArchiveProducer {
    pub(crate) fn new(root: DiagnosticsArchiveRoot) -> Result<Self, DiagnosticsArchiveError> {
        root.is_available()
            .then_some(Self { root })
            .ok_or(DiagnosticsArchiveError::InvalidRoot)
    }

    pub(crate) fn admit(&self, state: HostState) -> DiagnosticsArchiveAdmission {
        DiagnosticsArchiveAdmission {
            producer: self.clone(),
            state,
        }
    }

    pub(crate) fn download(&self, archive_id: &str) -> Result<Vec<u8>, DiagnosticsArchiveError> {
        self.root.read(archive_id)
    }

    fn produce(
        &self,
        state: &HostState,
        cancellation: &DiagnosticsArchiveCancellation,
    ) -> Result<DiagnosticsArchiveReceipt, DiagnosticsArchiveError> {
        let archive_id = archive_id()?;
        if cancellation.is_cancelled() {
            return Ok(cancelled(archive_id));
        }
        if !self.root.is_available() {
            return Err(DiagnosticsArchiveError::OutputUnavailable);
        }
        let Ok((entries, image)) = self.encode(state) else {
            return Ok(failed(archive_id));
        };
        if cancellation.is_cancelled() {
            return Ok(cancelled(archive_id));
        }
        if self.root.publish(&archive_id, &image).is_err() {
            return Ok(failed(archive_id));
        }
        if !cancellation.is_cancelled() {
            return Ok(DiagnosticsArchiveReceipt::completed(
                archive_id,
                entries,
                image.len() as u64,
            ));
        }
        Ok(match self.root.discard(&archive_id) {
            Ok(()) => cancelled(archive_id),
            Err(_) => failed(archive_id),
        })
    }

    /// Encodes the bundle in memory so a request that exceeds the archive bound never reaches disk.
    fn encode(&self, state: &HostState) -> Result<(usize, Vec<u8>), DiagnosticsArchiveError> {
        let host_state = serde_json::to_vec_pretty(&ArchiveHostState::from(state))
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        let app_log_root = self.root.app_log_root();
        let entries = bundle::collect(self.root.state_root(), app_log_root.as_deref(), host_state);
        let image = zip::encode(&entries)?;
        (image.len() as u64 <= ARCHIVE_BYTE_LIMIT)
            .then_some((entries.len(), image))
            .ok_or(DiagnosticsArchiveError::OutputUnavailable)
    }
}

impl DiagnosticsArchiveAdmission {
    pub(crate) fn download(self, archive_id: &str) -> Result<Vec<u8>, DiagnosticsArchiveError> {
        self.producer.download(archive_id)
    }

    pub(crate) fn collect(
        self,
        cancellation: &DiagnosticsArchiveCancellation,
    ) -> DiagnosticsArchiveReceipt {
        self.producer
            .produce(&self.state, cancellation)
            .unwrap_or_else(|_| DiagnosticsArchiveReceipt::failed())
    }
}

fn cancelled(archive_id: String) -> DiagnosticsArchiveReceipt {
    DiagnosticsArchiveReceipt::terminated(archive_id, DiagnosticsArchiveTerminal::Cancelled)
}

fn failed(archive_id: String) -> DiagnosticsArchiveReceipt {
    DiagnosticsArchiveReceipt::terminated(archive_id, DiagnosticsArchiveTerminal::Failed)
}

fn archive_id() -> Result<String, DiagnosticsArchiveError> {
    let mut random = [0_u8; ARCHIVE_ID_BYTES];
    fill(&mut random).map_err(|_| DiagnosticsArchiveError::ArchiveIdUnavailable)?;
    let mut id = String::with_capacity(ARCHIVE_ID_BYTES * 2);
    for byte in random {
        id.push(char::from(HEX_DIGITS[usize::from(byte >> 4)]));
        id.push(char::from(HEX_DIGITS[usize::from(byte & 0x0f)]));
    }
    Ok(id)
}

#[cfg(test)]
pub(super) mod tests {
    use std::{
        collections::BTreeMap,
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use serde_json::{Value, json};

    use super::*;
    use crate::diagnostics::{HostLifecycle, RuntimeFailure, RuntimeLifecycle, RuntimeState};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn admission_publishes_both_collection_roots_and_reports_a_bounded_terminal() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let app_log_dir = app_log_dir(&state_root);
        fs::create_dir_all(&app_log_dir).unwrap();
        fs::write(app_log_dir.join("main.log"), b"desktop log line").unwrap();
        let root = provision_root(&state_root);
        let producer = DiagnosticsArchiveProducer::new(root.clone()).unwrap();

        let receipt = producer
            .admit(safe_state(HostLifecycle::Ready, true))
            .collect(&DiagnosticsArchiveCancellation::new());

        assert_eq!(receipt.terminal(), DiagnosticsArchiveTerminal::Completed);
        assert!(receipt.has_opaque_archive_id());
        assert!(receipt.bytes() > 0 && receipt.bytes() <= ARCHIVE_BYTE_LIMIT);
        let entries = published_entries(&root, &receipt.archive_id);
        assert_eq!(receipt.entries(), entries.len());
        assert!(receipt.entries() >= 9);
        let document: Value =
            serde_json::from_slice(entries.get(bundle::HOST_STATE_ENTRY).unwrap()).unwrap();
        assert_eq!(document["lifecycle"], "ready");
        for expected in [
            "runtime/openclaw.json",
            "runtime/logs/runtime.log",
            "runtime/agents/reviewer/sessions/sessions.json",
            "runtime/agents/reviewer/sessions/session-1.jsonl",
            "runtime/workspace/AGENTS.md",
            "runtime/workspace-subagents/child/TOOLS.md",
            "runtime/executions/run-1/package-path.txt",
            "runtime/packages/team-reviewer/team.skill.json",
            "runtime/packages/team-reviewer/README.md",
            "runtime/extensions/browser/openclaw.plugin.json",
            "userdata/logs/main.log",
        ] {
            assert!(entries.contains_key(expected), "missing entry {expected}");
        }
        let config = String::from_utf8(entries["runtime/openclaw.json"].clone()).unwrap();
        assert!(!config.contains("config-token-canary"));
        assert!(config.contains("***"));
        let log = String::from_utf8(entries["runtime/logs/runtime.log"].clone()).unwrap();
        for forbidden in [
            "4321",
            "runtime-host",
            "C:\\private\\runtime",
            "log-token",
            "log-secret",
            "native",
        ] {
            assert!(!log.contains(forbidden), "log leaked {forbidden}");
        }
        assert!(log.contains("***"));
        let _ = fs::remove_dir_all(app_log_dir);
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn a_terminal_receipt_never_carries_runtime_facts_or_output_paths() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let root = provision_root(&state_root);
        let producer = DiagnosticsArchiveProducer::new(root.clone()).unwrap();
        let state = HostState {
            ok: true,
            lifecycle: HostLifecycle::Ready,
            matcha: RuntimeState {
                lifecycle: RuntimeLifecycle::Running,
                pid: Some(42),
                failure: Some(RuntimeFailure::UnexpectedExit),
                startup_diagnostic: None,
            },
            open_claw: unavailable_state(),
        };

        let receipt = producer
            .admit(state)
            .collect(&DiagnosticsArchiveCancellation::new());

        let wire = serde_json::to_value(&receipt).unwrap();
        assert_eq!(
            wire.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["archiveId", "bytes", "entries", "terminal"]
        );
        let rendered = format!("{}{receipt:?}", serde_json::to_string(&receipt).unwrap());
        for canary in [
            root.output_root().to_string_lossy().as_ref(),
            "config-token-canary",
            "workspace-canary",
            "pid",
            "unexpectedExit",
        ] {
            assert!(!rendered.contains(canary), "receipt leaked {canary}");
        }
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn the_host_state_entry_is_a_closed_safe_projection() {
        let state = HostState {
            ok: true,
            lifecycle: HostLifecycle::Ready,
            matcha: RuntimeState {
                lifecycle: RuntimeLifecycle::Running,
                pid: Some(42),
                failure: Some(RuntimeFailure::UnexpectedExit),
                startup_diagnostic: Some(
                    matcha_agent::lifecycle::output::StartupDiagnosticCategory::PortConflict.into(),
                ),
            },
            open_claw: unavailable_state(),
        };

        assert_eq!(
            serde_json::to_value(ArchiveHostState::from(&state)).unwrap(),
            json!({
                "ok": true,
                "lifecycle": "ready",
                "matcha": {
                    "lifecycle": "running",
                    "failure": "unexpectedExit",
                    "startupDiagnostic": "portConflict",
                },
                "openClaw": { "lifecycle": "unavailable" },
            })
        );
    }

    #[test]
    fn cancellation_before_admission_leaves_no_published_archive() {
        let state_root = fixture_root();
        write_runtime_fixture(&state_root);
        let root = provision_root(&state_root);
        let producer = DiagnosticsArchiveProducer::new(root.clone()).unwrap();
        let cancellation = DiagnosticsArchiveCancellation::new();
        cancellation.cancel();

        let receipt = producer
            .admit(safe_state(HostLifecycle::Created, false))
            .collect(&cancellation);

        assert_eq!(receipt.terminal(), DiagnosticsArchiveTerminal::Cancelled);
        assert_eq!(receipt.entries(), 0);
        assert_eq!(receipt.bytes(), 0);
        assert_eq!(fs::read_dir(root.output_root()).unwrap().count(), 0);
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn a_caller_guard_cancels_the_shared_operation_token() {
        let cancellation = DiagnosticsArchiveCancellation::new();

        drop(cancellation.cancel_on_drop());

        assert!(cancellation.is_cancelled());
    }

    #[test]
    fn an_unavailable_output_root_projects_an_opaque_failed_receipt() {
        let fixture = fixture_root();
        let state_root = fixture.join("runtime-secret-canary");
        fs::create_dir(&state_root).unwrap();
        let root = provision_root(&state_root);
        let producer = DiagnosticsArchiveProducer::new(root.clone()).unwrap();
        fs::remove_dir(root.output_root()).unwrap();

        let receipt = producer
            .admit(safe_state(HostLifecycle::Ready, true))
            .collect(&DiagnosticsArchiveCancellation::new());

        assert_eq!(receipt.terminal(), DiagnosticsArchiveTerminal::Failed);
        assert_eq!(receipt.entries(), 0);
        assert_eq!(receipt.bytes(), 0);
        let rendered = format!("{}{receipt:?}", serde_json::to_string(&receipt).unwrap());
        for canary in [
            state_root.to_string_lossy().as_ref(),
            "runtime-secret-canary",
            "host-diagnostics",
        ] {
            assert!(!rendered.contains(canary));
        }
        let _ = fs::remove_dir_all(fixture);
    }

    #[test]
    fn concurrent_admissions_never_share_an_archive_identity() {
        let state_root = fixture_root();
        let root = provision_root(&state_root);
        let producer = DiagnosticsArchiveProducer::new(root.clone()).unwrap();

        let first = producer
            .admit(safe_state(HostLifecycle::Created, false))
            .collect(&DiagnosticsArchiveCancellation::new());
        let second = producer
            .admit(safe_state(HostLifecycle::Created, false))
            .collect(&DiagnosticsArchiveCancellation::new());

        assert_eq!(first.terminal(), DiagnosticsArchiveTerminal::Completed);
        assert_eq!(second.terminal(), DiagnosticsArchiveTerminal::Completed);
        assert_ne!(first.archive_id, second.archive_id);
        assert_eq!(fs::read_dir(root.output_root()).unwrap().count(), 2);
        let _ = fs::remove_dir_all(state_root);
    }

    fn unavailable_state() -> RuntimeState {
        RuntimeState {
            lifecycle: RuntimeLifecycle::Unavailable,
            pid: None,
            failure: None,
            startup_diagnostic: None,
        }
    }

    fn safe_state(lifecycle: HostLifecycle, ok: bool) -> HostState {
        HostState {
            ok,
            lifecycle,
            matcha: unavailable_state(),
            open_claw: unavailable_state(),
        }
    }

    fn published_entries(
        root: &DiagnosticsArchiveRoot,
        archive_id: &str,
    ) -> BTreeMap<String, Vec<u8>> {
        let archive = fs::read(
            root.output_root()
                .join(format!("host-diagnostics-{archive_id}.zip")),
        )
        .unwrap();
        zip_entries(&archive)
    }

    /// Reads the published image the way a ZIP reader does: central directory first, then each
    /// local header, so a malformed offset or length is a test failure rather than a silent pass.
    fn zip_entries(archive: &[u8]) -> BTreeMap<String, Vec<u8>> {
        let end = archive.len() - 22;
        assert_eq!(&archive[end..end + 4], b"PK\x05\x06");
        let count = usize::from(u16::from_le_bytes([archive[end + 10], archive[end + 11]]));
        let mut cursor = read_u32(archive, end + 16);
        let mut entries = BTreeMap::new();
        for _ in 0..count {
            assert_eq!(&archive[cursor..cursor + 4], b"PK\x01\x02");
            let name_len = usize::from(read_u16(archive, cursor + 28));
            let local_offset = read_u32(archive, cursor + 42);
            let name =
                String::from_utf8(archive[cursor + 46..cursor + 46 + name_len].to_vec()).unwrap();
            entries.insert(name, read_local_entry(archive, local_offset));
            cursor += 46 + name_len;
        }
        assert_eq!(cursor, end);
        entries
    }

    fn read_local_entry(archive: &[u8], offset: usize) -> Vec<u8> {
        assert_eq!(&archive[offset..offset + 4], b"PK\x03\x04");
        assert_eq!(read_u16(archive, offset + 8), 8);
        let compressed_len = read_u32(archive, offset + 18);
        let uncompressed_len = read_u32(archive, offset + 22);
        let name_len = usize::from(read_u16(archive, offset + 26));
        let start = offset + 30 + name_len;
        inflate_stored_blocks(&archive[start..start + compressed_len], uncompressed_len)
    }

    fn inflate_stored_blocks(compressed: &[u8], expected_len: usize) -> Vec<u8> {
        let mut cursor = 0;
        let mut content = Vec::with_capacity(expected_len);
        loop {
            let header = compressed[cursor];
            assert_eq!(header & 0b1111_1110, 0);
            let length = usize::from(read_u16(compressed, cursor + 1));
            assert_eq!(read_u16(compressed, cursor + 3), !(length as u16));
            cursor += 5;
            content.extend_from_slice(&compressed[cursor..cursor + length]);
            cursor += length;
            if header & 1 == 1 {
                break;
            }
        }
        assert_eq!(cursor, compressed.len());
        assert_eq!(content.len(), expected_len);
        content
    }

    fn read_u16(image: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes(image[offset..offset + 2].try_into().unwrap())
    }

    fn read_u32(image: &[u8], offset: usize) -> usize {
        u32::from_le_bytes(image[offset..offset + 4].try_into().unwrap()) as usize
    }

    pub(super) fn fixture_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "runtime-host-diagnostics-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// In production the desktop shell's log directory lives outside the runtime state root, so the
    /// fixture keeps it a sibling. It need not exist: the root resolves it per collection.
    fn app_log_dir(state_root: &Path) -> PathBuf {
        state_root.with_extension("userdata-logs")
    }

    fn provision_root(state_root: &Path) -> DiagnosticsArchiveRoot {
        DiagnosticsArchiveRoot::provision(state_root, app_log_dir(state_root)).unwrap()
    }

    /// Mirrors the runtime data layout the peer runtime owns, including inputs that must be
    /// excluded: an unlisted workspace file, a stale transcript and a non-manifest plugin file.
    pub(super) fn write_runtime_fixture(state_root: &Path) {
        write(
            &state_root.join("openclaw.json"),
            &serde_json::to_vec_pretty(&json!({
                "agents": { "list": [{ "id": "configured", "model": "opus" }] },
                "token": "config-token-canary",
                "gateway": { "clientSecret": "nested-secret-canary", "port": 8080 },
            }))
            .unwrap(),
        );
        write(
            &state_root.join("logs/runtime.log"),
            br#"pid=4321 argv=["runtime-host"] path=C:\private\runtime token=log-token secret=log-secret payload={"native":true}"#,
        );
        write(
            &state_root.join("logs/nested/gateway.log"),
            b"gateway log line",
        );
        write(
            &state_root.join("agents/reviewer/sessions/sessions.json"),
            b"{\"sessions\":[]}",
        );
        write(
            &state_root.join("agents/reviewer/sessions/session-1.jsonl"),
            b"{\"seq\":1}\n",
        );
        write(
            &state_root.join("agents/configured/sessions/sessions.json"),
            b"{\"sessions\":[]}",
        );
        write(&state_root.join("workspace/AGENTS.md"), b"agent charter");
        write(&state_root.join("workspace/notes.txt"), b"workspace-canary");
        write(
            &state_root.join("workspace-subagents/child/TOOLS.md"),
            b"subagent tools",
        );
        write(
            &state_root.join("executions/run-1/package-path.txt"),
            b"package execution path",
        );
        write(
            &state_root.join("packages/team-reviewer/team.skill.json"),
            b"{\"name\":\"reviewer\"}",
        );
        write(
            &state_root.join("packages/team-reviewer/README.md"),
            b"package readme",
        );
        write(
            &state_root.join("packages/team-reviewer/private.env"),
            b"package-secret-canary",
        );
        write(
            &state_root.join("extensions/browser/openclaw.plugin.json"),
            b"{\"name\":\"browser\"}",
        );
        write(&state_root.join("extensions/browser/package.json"), b"{}");
        set_stale(&state_root.join("agents/reviewer/sessions/stale.jsonl"));
    }

    fn write(path: &Path, content: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// A transcript older than the recency window must not enter the bundle.
    fn set_stale(path: &Path) {
        write(path, b"{\"seq\":0}\n");
        let stale = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1);
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(stale).unwrap();
    }
}
