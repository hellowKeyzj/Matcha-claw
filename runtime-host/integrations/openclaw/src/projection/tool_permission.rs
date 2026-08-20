use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    lifecycle::state_dir::CanonicalStateDir,
    projection::config_store::{
        OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore,
        OpenClawConfigStoreError,
    },
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Default,
    FullAccess,
}

impl Mode {
    pub fn read(state_dir: CanonicalStateDir) -> Result<Self, Error> {
        OpenClawConfigStore::new(state_dir)
            .read()
            .map(|document| Self::from_document(&document))
            .map_err(|_| Error::Unavailable)
    }

    pub fn apply(self, state_dir: CanonicalStateDir) -> Result<Effect, Error> {
        let store = OpenClawConfigStore::new(state_dir);
        let update = store
            .update(|document| {
                if self.apply_to_document(document) {
                    OpenClawConfigMutation::changed()
                } else {
                    OpenClawConfigMutation::unchanged()
                }
            })
            .map_err(Error::from)?;
        if !update.changed {
            return Ok(Effect::Unchanged);
        }
        let readback = store.read().map_err(|_| Error::Unknown)?;
        (Self::from_document(&readback) == self)
            .then_some(Effect::Written)
            .ok_or(Error::Unknown)
    }

    fn from_document(document: &OpenClawConfigDocument) -> Self {
        let workspace_only = document
            .get("tools")
            .and_then(Value::as_object)
            .and_then(|tools| tools.get("fs"))
            .and_then(Value::as_object)
            .and_then(|fs| fs.get("workspaceOnly"))
            .and_then(Value::as_bool);
        if workspace_only == Some(true) {
            Self::Default
        } else {
            Self::FullAccess
        }
    }

    fn apply_to_document(self, document: &mut OpenClawConfigDocument) -> bool {
        let mut tools = object(document.get("tools"));
        let mut fs = object(tools.get("fs"));
        let mut exec = object(tools.get("exec"));
        let mut changed = replace(
            &mut fs,
            "workspaceOnly",
            Value::Bool(matches!(self, Self::Default)),
        );
        changed |= exec.remove("security").is_some();
        changed |= exec.remove("ask").is_some();
        if !changed {
            return false;
        }
        tools.insert("fs".into(), Value::Object(fs));
        if exec.is_empty() {
            tools.remove("exec");
        } else {
            tools.insert("exec".into(), Value::Object(exec));
        }
        let mut commands = object(document.get("commands"));
        commands.insert("restart".into(), Value::Bool(true));
        document.insert("tools".into(), Value::Object(tools));
        document.insert("commands".into(), Value::Object(commands));
        true
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Effect {
    Unchanged,
    Written,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Unavailable,
    Unknown,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "OpenClaw tool permission mode is unavailable",
            Self::Unknown => "OpenClaw tool permission mode outcome is unknown",
        })
    }
}

impl std::error::Error for Error {}

impl From<OpenClawConfigStoreError> for Error {
    fn from(error: OpenClawConfigStoreError) -> Self {
        match error {
            OpenClawConfigStoreError::TemporaryCreateFailed
            | OpenClawConfigStoreError::TemporaryWriteFailed
            | OpenClawConfigStoreError::TemporarySyncFailed
            | OpenClawConfigStoreError::ReplaceFailed
            | OpenClawConfigStoreError::CleanupFailed
            | OpenClawConfigStoreError::CommittedButNotDurable => Self::Unknown,
            OpenClawConfigStoreError::StateDirectoryRejected
            | OpenClawConfigStoreError::ReentrantUpdate
            | OpenClawConfigStoreError::ReadFailed
            | OpenClawConfigStoreError::InvalidDocument
            | OpenClawConfigStoreError::DocumentTooLarge => Self::Unavailable,
        }
    }
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn replace(target: &mut Map<String, Value>, key: &str, value: Value) -> bool {
    if target.get(key) == Some(&value) {
        return false;
    }
    target.insert(key.into(), value);
    true
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    use super::*;

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must follow Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "openclaw-tool-permission-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn state_dir(&self) -> CanonicalStateDir {
            CanonicalStateDir::provision(self.0.join("state")).unwrap()
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_true_workspace_only_as_default_and_every_other_value_as_full_access() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();
        let store = OpenClawConfigStore::new(state_dir.clone());

        assert_eq!(Mode::read(state_dir.clone()).unwrap(), Mode::FullAccess);
        store
            .update(|document| {
                document.insert("tools".into(), json!({ "fs": { "workspaceOnly": true } }));
                OpenClawConfigMutation::changed()
            })
            .unwrap();
        assert_eq!(Mode::read(state_dir.clone()).unwrap(), Mode::Default);
        store
            .update(|document| {
                document.insert("tools".into(), json!({ "fs": { "workspaceOnly": "true" } }));
                OpenClawConfigMutation::changed()
            })
            .unwrap();
        assert_eq!(Mode::read(state_dir).unwrap(), Mode::FullAccess);
    }

    #[test]
    fn writes_only_owned_permission_fields_and_records_restart_when_changed() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();
        let store = OpenClawConfigStore::new(state_dir.clone());
        store
            .update(|document| {
                document.insert(
                    "tools".into(),
                    json!({
                        "profile": "coding",
                        "fs": { "workspaceOnly": false, "keepFs": true },
                        "exec": { "security": "full", "ask": "off", "keepExec": true },
                        "customToolConfig": true,
                    }),
                );
                document.insert(
                    "agents".into(),
                    json!({ "defaults": { "model": { "primary": "anthropic/claude" } } }),
                );
                OpenClawConfigMutation::changed()
            })
            .unwrap();

        assert_eq!(
            Mode::Default.apply(state_dir.clone()).unwrap(),
            Effect::Written
        );
        assert_eq!(Mode::read(state_dir.clone()).unwrap(), Mode::Default);
        let document = store.read().unwrap().as_value();
        assert_eq!(
            document["tools"],
            json!({
                "profile": "coding",
                "fs": { "workspaceOnly": true, "keepFs": true },
                "exec": { "keepExec": true },
                "customToolConfig": true,
            })
        );
        assert_eq!(document["commands"]["restart"], true);
        assert_eq!(
            document["agents"],
            json!({ "defaults": { "model": { "primary": "anthropic/claude" } } })
        );

        assert_eq!(
            Mode::FullAccess.apply(state_dir.clone()).unwrap(),
            Effect::Written
        );
        assert_eq!(Mode::read(state_dir).unwrap(), Mode::FullAccess);
    }

    #[test]
    fn unchanged_mode_does_not_rewrite_or_claim_restart() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();
        let path = state_dir.as_path().join("openclaw.json");
        let original = br#"{ "tools": { "fs": { "workspaceOnly": true } } }"#;
        fs::write(&path, original).unwrap();

        assert_eq!(Mode::Default.apply(state_dir).unwrap(), Effect::Unchanged);
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn write_is_recovered_from_the_canonical_document_after_new_owner_construction() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();

        assert_eq!(
            Mode::Default.apply(state_dir.clone()).unwrap(),
            Effect::Written
        );
        assert_eq!(Mode::read(state_dir).unwrap(), Mode::Default);
    }

    #[test]
    fn failures_do_not_expose_config_path_or_contents() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();
        let config = state_dir.as_path().join("openclaw.json");
        let secret = "synthetic-tool-permission-secret";
        fs::write(&config, format!("{{\"token\":\"{secret}\"")).unwrap();

        let error = Mode::read(state_dir).unwrap_err();
        let rendered = format!("{error:?} {error}");

        assert_eq!(error, Error::Unavailable);
        assert!(!rendered.contains(secret));
        assert!(!rendered.contains(config.to_string_lossy().as_ref()));
    }

    #[test]
    fn durable_write_uncertainty_is_distinct_from_config_unavailability() {
        for error in [
            OpenClawConfigStoreError::TemporaryCreateFailed,
            OpenClawConfigStoreError::TemporaryWriteFailed,
            OpenClawConfigStoreError::TemporarySyncFailed,
            OpenClawConfigStoreError::ReplaceFailed,
            OpenClawConfigStoreError::CleanupFailed,
            OpenClawConfigStoreError::CommittedButNotDurable,
        ] {
            assert_eq!(Error::from(error), Error::Unknown);
        }
        for error in [
            OpenClawConfigStoreError::StateDirectoryRejected,
            OpenClawConfigStoreError::ReentrantUpdate,
            OpenClawConfigStoreError::ReadFailed,
            OpenClawConfigStoreError::InvalidDocument,
            OpenClawConfigStoreError::DocumentTooLarge,
        ] {
            assert_eq!(Error::from(error), Error::Unavailable);
        }
    }
}
