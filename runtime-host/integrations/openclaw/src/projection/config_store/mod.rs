use std::{
    cell::Cell,
    fmt,
    sync::{Mutex, OnceLock},
};

use serde::Deserialize;
use serde_json::{Map, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::lifecycle::state_dir::CanonicalStateDir;

mod persist;

const CANONICAL_CONFIG_FILE: &str = "openclaw.json";
const MAX_CONFIG_DOCUMENT_BYTES: usize = 1_048_576;
const REDACTED_VALUE: &str = "[redacted]";
const SENSITIVE_CONFIG_KEYS: &[&str] = &[
    "access",
    "access_token",
    "access-token",
    "apikey",
    "api_key",
    "api-key",
    "authorization",
    "client_secret",
    "client-secret",
    "clientsecret",
    "credential",
    "key",
    "password",
    "proxy-authorization",
    "refresh",
    "refresh_token",
    "refresh-token",
    "secret",
    "token",
    "x-api-key",
];

static PROCESS_WRITER: OnceLock<Mutex<()>> = OnceLock::new();

thread_local! {
    static WRITER_ACTIVE: Cell<bool> = const { Cell::new(false) };
}

#[derive(Clone)]
pub(crate) struct OpenClawConfigStore {
    state_dir: CanonicalStateDir,
}

impl OpenClawConfigStore {
    pub(crate) fn new(state_dir: CanonicalStateDir) -> Self {
        Self { state_dir }
    }

    pub(crate) fn read(&self) -> Result<OpenClawConfigDocument, OpenClawConfigStoreError> {
        let state_dir = self
            .state_dir
            .open()
            .map_err(|_| OpenClawConfigStoreError::StateDirectoryRejected)?;
        read_document(&state_dir)
    }

    pub(crate) fn read_workspace_selection(
        &self,
    ) -> Result<OpenClawConfigDocument, OpenClawConfigStoreError> {
        let state_dir = self
            .state_dir
            .open()
            .map_err(|_| OpenClawConfigStoreError::StateDirectoryRejected)?;
        read_workspace_selection_document(&state_dir)
    }

    pub(crate) fn read_private(&self) -> Result<OpenClawConfigDocument, OpenClawConfigStoreError> {
        let state_dir = self
            .state_dir
            .open()
            .map_err(|_| OpenClawConfigStoreError::StateDirectoryRejected)?;
        read_private_document(&state_dir)
    }

    pub(crate) fn state_dir(&self) -> CanonicalStateDir {
        self.state_dir.clone()
    }

    pub(crate) fn state_dir_path(&self) -> &std::path::Path {
        self.state_dir.as_path()
    }

    #[cfg(windows)]
    pub(crate) fn ensure_canonical_document(&self) -> Result<(), OpenClawConfigStoreError> {
        let state_dir = self
            .state_dir
            .open()
            .map_err(|_| OpenClawConfigStoreError::StateDirectoryRejected)?;
        if state_dir
            .read_regular_file_bounded(CANONICAL_CONFIG_FILE, MAX_CONFIG_DOCUMENT_BYTES)
            .map_err(|_| OpenClawConfigStoreError::ReadFailed)?
            .is_none()
        {
            persist::create_if_missing(&state_dir, b"{}\n")
                .map_err(OpenClawConfigStoreError::from)?;
        }
        Ok(())
    }

    pub(crate) fn update(
        &self,
        mutate: impl FnOnce(&mut OpenClawConfigDocument) -> OpenClawConfigMutation,
    ) -> Result<OpenClawConfigUpdate, OpenClawConfigStoreError> {
        self.update_with(read_private_document, serialize_private_document, mutate)
    }

    pub(crate) fn update_private_document(
        &self,
        mutate: impl FnOnce(&mut OpenClawConfigDocument) -> OpenClawConfigMutation,
    ) -> Result<OpenClawConfigUpdate, OpenClawConfigStoreError> {
        self.update_with(read_private_document, serialize_private_document, mutate)
    }

    fn update_with(
        &self,
        read: impl FnOnce(
            &crate::lifecycle::state_dir::StateDirHandle,
        ) -> Result<OpenClawConfigDocument, OpenClawConfigStoreError>,
        serialize: impl FnOnce(
            &OpenClawConfigDocument,
        ) -> Result<Zeroizing<Vec<u8>>, OpenClawConfigStoreError>,
        mutate: impl FnOnce(&mut OpenClawConfigDocument) -> OpenClawConfigMutation,
    ) -> Result<OpenClawConfigUpdate, OpenClawConfigStoreError> {
        if WRITER_ACTIVE.with(Cell::get) {
            return Err(OpenClawConfigStoreError::ReentrantUpdate);
        }
        let writer = PROCESS_WRITER.get_or_init(|| Mutex::new(()));
        let _writer = writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _active = WriterActivity::enter();
        let state_dir = self
            .state_dir
            .open()
            .map_err(|_| OpenClawConfigStoreError::StateDirectoryRejected)?;
        let mut document = read(&state_dir)?;
        let mutation = mutate(&mut document);
        if mutation.changed {
            let bytes = serialize(&document)?;
            persist::replace(&state_dir, &bytes).map_err(OpenClawConfigStoreError::from)?;
        }
        Ok(OpenClawConfigUpdate {
            changed: mutation.changed,
        })
    }
}

impl fmt::Debug for OpenClawConfigStore {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("OpenClawConfigStore([REDACTED])")
    }
}

struct WriterActivity;

impl WriterActivity {
    fn enter() -> Self {
        WRITER_ACTIVE.with(|active| active.set(true));
        Self
    }
}

impl Drop for WriterActivity {
    fn drop(&mut self) {
        WRITER_ACTIVE.with(|active| active.set(false));
    }
}

pub(crate) struct OpenClawConfigDocument(Map<String, Value>);

impl OpenClawConfigDocument {
    pub(crate) fn empty() -> Self {
        Self(Map::new())
    }

    pub(crate) fn from_value(value: Value) -> Result<Self, OpenClawConfigStoreError> {
        match value {
            Value::Object(document) => Ok(Self(document)),
            _ => Err(OpenClawConfigStoreError::InvalidDocument),
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    pub(crate) fn as_value(&self) -> Value {
        Value::Object(self.0.clone())
    }

    pub(crate) fn into_value(mut self) -> Value {
        Value::Object(std::mem::take(&mut self.0))
    }

    pub(crate) fn insert(&mut self, key: String, value: Value) -> Option<Value> {
        self.0.insert(key, value)
    }
}

impl Drop for OpenClawConfigDocument {
    fn drop(&mut self) {
        self.0.values_mut().for_each(zeroize_value);
    }
}

fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(string) => string.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(object) => object.values_mut().for_each(zeroize_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

impl fmt::Debug for OpenClawConfigDocument {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("OpenClawConfigDocument([REDACTED])")
    }
}

pub(crate) struct OpenClawConfigMutation {
    changed: bool,
}

impl OpenClawConfigMutation {
    pub(crate) fn unchanged() -> Self {
        Self { changed: false }
    }

    pub(crate) fn changed() -> Self {
        Self { changed: true }
    }
}

pub(crate) struct OpenClawConfigUpdate {
    pub(crate) changed: bool,
}

impl fmt::Debug for OpenClawConfigUpdate {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output
            .debug_struct("OpenClawConfigUpdate")
            .field("changed", &self.changed)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenClawConfigStoreError {
    StateDirectoryRejected,
    ReentrantUpdate,
    ReadFailed,
    InvalidDocument,
    DocumentTooLarge,
    TemporaryCreateFailed,
    TemporaryWriteFailed,
    TemporarySyncFailed,
    ReplaceFailed,
    CleanupFailed,
    CommittedButNotDurable,
}

impl fmt::Display for OpenClawConfigStoreError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::StateDirectoryRejected => "OpenClaw config state directory was rejected",
            Self::ReentrantUpdate => "OpenClaw config update cannot be reentered",
            Self::ReadFailed => "OpenClaw config read failed",
            Self::InvalidDocument => "OpenClaw config document is invalid",
            Self::DocumentTooLarge => "OpenClaw config document is too large",
            Self::TemporaryCreateFailed => "OpenClaw config temporary file creation failed",
            Self::TemporaryWriteFailed => "OpenClaw config temporary file write failed",
            Self::TemporarySyncFailed => "OpenClaw config temporary file synchronization failed",
            Self::ReplaceFailed => "OpenClaw config replacement failed",
            Self::CleanupFailed => "OpenClaw config temporary file cleanup failed",
            Self::CommittedButNotDurable => {
                "OpenClaw config was committed but is not confirmed durable"
            }
        })
    }
}

impl std::error::Error for OpenClawConfigStoreError {}

fn read_document(
    state_dir: &crate::lifecycle::state_dir::StateDirHandle,
) -> Result<OpenClawConfigDocument, OpenClawConfigStoreError> {
    let Some(bytes) = read_config_bytes(state_dir)? else {
        return Ok(OpenClawConfigDocument::empty());
    };
    let mut document = parse_document(&bytes)?;
    redact_sensitive_fields(&mut document.0, &[]);
    Ok(document)
}

fn read_private_document(
    state_dir: &crate::lifecycle::state_dir::StateDirHandle,
) -> Result<OpenClawConfigDocument, OpenClawConfigStoreError> {
    let Some(bytes) = read_config_bytes(state_dir)? else {
        return Ok(OpenClawConfigDocument::empty());
    };
    parse_document(&bytes)
}

fn read_workspace_selection_document(
    state_dir: &crate::lifecycle::state_dir::StateDirHandle,
) -> Result<OpenClawConfigDocument, OpenClawConfigStoreError> {
    let Some(bytes) = read_config_bytes(state_dir)? else {
        return Ok(OpenClawConfigDocument::empty());
    };
    parse_workspace_selection_document(&bytes)
}

fn read_config_bytes(
    state_dir: &crate::lifecycle::state_dir::StateDirHandle,
) -> Result<Option<Zeroizing<Vec<u8>>>, OpenClawConfigStoreError> {
    state_dir
        .read_regular_file_bounded(CANONICAL_CONFIG_FILE, MAX_CONFIG_DOCUMENT_BYTES)
        .map(|bytes| bytes.map(Zeroizing::new))
        .map_err(|_| OpenClawConfigStoreError::ReadFailed)
}

fn parse_document(bytes: &[u8]) -> Result<OpenClawConfigDocument, OpenClawConfigStoreError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| OpenClawConfigStoreError::InvalidDocument)?;
    match value {
        Value::Object(document) => Ok(OpenClawConfigDocument(document)),
        _ => Err(OpenClawConfigStoreError::InvalidDocument),
    }
}

fn parse_workspace_selection_document(
    bytes: &[u8],
) -> Result<OpenClawConfigDocument, OpenClawConfigStoreError> {
    let document = serde_json::from_slice::<WorkspaceSelectionDocument>(bytes)
        .map_err(|_| OpenClawConfigStoreError::InvalidDocument)?;
    let Some(agents) = document.agents else {
        return Ok(OpenClawConfigDocument::empty());
    };
    let mut selected = Map::new();
    selected.insert("agents".into(), agents.into_value());
    Ok(OpenClawConfigDocument(selected))
}

#[derive(Deserialize)]
struct WorkspaceSelectionDocument {
    agents: Option<WorkspaceSelectionAgents>,
}

#[derive(Deserialize)]
struct WorkspaceSelectionAgents {
    defaults: Option<WorkspaceSelectionDefaults>,
    list: Option<Vec<WorkspaceSelectionAgent>>,
}

impl WorkspaceSelectionAgents {
    fn into_value(self) -> Value {
        let mut agents = Map::new();
        if let Some(defaults) = self
            .defaults
            .and_then(WorkspaceSelectionDefaults::into_value)
        {
            agents.insert("defaults".into(), defaults);
        }
        if let Some(list) = self.list {
            let list = list
                .into_iter()
                .filter_map(WorkspaceSelectionAgent::into_value)
                .collect::<Vec<_>>();
            if !list.is_empty() {
                agents.insert("list".into(), Value::Array(list));
            }
        }
        Value::Object(agents)
    }
}

#[derive(Deserialize)]
struct WorkspaceSelectionDefaults {
    workspace: Option<String>,
}

impl WorkspaceSelectionDefaults {
    fn into_value(self) -> Option<Value> {
        Some(json_object([("workspace", self.workspace?)]))
    }
}

#[derive(Deserialize)]
struct WorkspaceSelectionAgent {
    id: Option<String>,
    workspace: Option<String>,
    #[serde(rename = "isDefault")]
    is_default: Option<bool>,
}

impl WorkspaceSelectionAgent {
    fn into_value(self) -> Option<Value> {
        let mut agent = Map::new();
        agent.insert("id".into(), Value::String(self.id?));
        agent.insert("workspace".into(), Value::String(self.workspace?));
        if let Some(is_default) = self.is_default {
            agent.insert("isDefault".into(), Value::Bool(is_default));
        }
        Some(Value::Object(agent))
    }
}

fn json_object<const N: usize>(entries: [(&str, String); N]) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), Value::String(value)))
            .collect(),
    )
}

fn serialize_private_document(
    document: &OpenClawConfigDocument,
) -> Result<Zeroizing<Vec<u8>>, OpenClawConfigStoreError> {
    let mut bytes = Zeroizing::new(
        serde_json::to_vec_pretty(&document.0)
            .map_err(|_| OpenClawConfigStoreError::DocumentTooLarge)?,
    );
    bytes.push(b'\n');
    if bytes.len() > MAX_CONFIG_DOCUMENT_BYTES {
        return Err(OpenClawConfigStoreError::DocumentTooLarge);
    }
    Ok(bytes)
}

fn redact_sensitive_fields(document: &mut Map<String, Value>, path: &[String]) {
    for (key, value) in document {
        if SENSITIVE_CONFIG_KEYS.contains(&key.to_ascii_lowercase().as_str())
            && !is_mcp_server_header_value(path)
            || key.eq_ignore_ascii_case("headers")
                && !is_mcp_server_headers(path, key)
                && headers_contain_credential(value)
        {
            *value = Value::String(REDACTED_VALUE.into());
            continue;
        }
        let mut child_path = path.to_vec();
        child_path.push(key.clone());
        match value {
            Value::Object(object) => redact_sensitive_fields(object, &child_path),
            Value::Array(values) => {
                for value in values {
                    redact_sensitive_value(value, &child_path);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }
}

fn redact_sensitive_value(value: &mut Value, path: &[String]) {
    match value {
        Value::Object(object) => redact_sensitive_fields(object, path),
        Value::Array(values) => {
            for value in values {
                redact_sensitive_value(value, path);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn is_mcp_server_headers(parent: &[String], key: &str) -> bool {
    key.eq_ignore_ascii_case("headers")
        && parent.len() == 3
        && parent[0] == "mcp"
        && parent[1] == "servers"
}

fn is_mcp_server_header_value(path: &[String]) -> bool {
    path.len() == 4 && path[0] == "mcp" && path[1] == "servers" && path[3] == "headers"
}

fn headers_contain_credential(value: &Value) -> bool {
    value.as_object().is_none_or(|headers| {
        headers.keys().any(|name| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "authorization" | "proxy-authorization" | "x-api-key" | "api-key"
            )
        })
    })
}

impl From<persist::PersistError> for OpenClawConfigStoreError {
    fn from(error: persist::PersistError) -> Self {
        match error {
            persist::PersistError::TemporaryCreateFailed => Self::TemporaryCreateFailed,
            persist::PersistError::TemporaryWriteFailed => Self::TemporaryWriteFailed,
            persist::PersistError::TemporarySyncFailed => Self::TemporarySyncFailed,
            persist::PersistError::ReplaceFailed => Self::ReplaceFailed,
            persist::PersistError::CleanupFailed => Self::CleanupFailed,
            persist::PersistError::CommittedButNotDurable => Self::CommittedButNotDurable,
        }
    }
}

#[cfg(test)]
mod tests;
