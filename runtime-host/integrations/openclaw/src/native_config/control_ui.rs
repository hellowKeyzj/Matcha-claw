use platform::state_dir::CanonicalStateDir;
use std::fmt;

use serde_json::Value;

use crate::native_config::config_store::{
    OpenClawConfigDocument, OpenClawConfigMutation, OpenClawConfigStore, OpenClawConfigStoreError,
};

const DANGEROUSLY_DISABLE_DEVICE_AUTH: &str = "dangerouslyDisableDeviceAuth";

pub fn ensure_matcha_operator_device_auth_policy(
    state_dir: CanonicalStateDir,
) -> Result<Effect, Error> {
    let store = OpenClawConfigStore::new(state_dir);
    let update = store
        .update_private_document(|document| {
            if apply_to_document(document) {
                OpenClawConfigMutation::changed()
            } else {
                OpenClawConfigMutation::unchanged()
            }
        })
        .map_err(Error::from)?;
    if update.changed {
        Ok(Effect::Written)
    } else {
        Ok(Effect::Unchanged)
    }
}

fn apply_to_document(document: &mut OpenClawConfigDocument) -> bool {
    let mut gateway = object(document.get("gateway"));
    let mut control_ui = object(gateway.get("controlUi"));
    if control_ui.get(DANGEROUSLY_DISABLE_DEVICE_AUTH) == Some(&Value::Bool(true)) {
        return false;
    }

    control_ui.insert(DANGEROUSLY_DISABLE_DEVICE_AUTH.into(), Value::Bool(true));
    gateway.insert("controlUi".into(), Value::Object(control_ui));
    document.insert("gateway".into(), Value::Object(gateway));
    true
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
            Self::Unavailable => "OpenClaw Control UI auth policy is unavailable",
            Self::Unknown => "OpenClaw Control UI auth policy outcome is unknown",
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

fn object(value: Option<&Value>) -> serde_json::Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
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
                "openclaw-control-ui-policy-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn state_dir(&self) -> CanonicalStateDir {
            CanonicalStateDir::provision(self.0.join("state")).unwrap()
        }

        fn config_path(&self) -> PathBuf {
            self.0.join("state/openclaw.json")
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_control_ui_device_auth_bypass_without_touching_other_gateway_config() {
        let root = TestRoot::new();
        let state_dir = root.state_dir();
        fs::write(
            root.config_path(),
            serde_json::to_vec(&json!({
                "gateway": {
                    "mode": "local",
                    "controlUi": { "allowedOrigins": ["file://", "null"] }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            ensure_matcha_operator_device_auth_policy(state_dir.clone()).unwrap(),
            Effect::Written,
        );
        assert_eq!(
            ensure_matcha_operator_device_auth_policy(state_dir.clone()).unwrap(),
            Effect::Unchanged,
        );

        let value: Value = serde_json::from_slice(&fs::read(root.config_path()).unwrap()).unwrap();
        assert_eq!(
            value["gateway"]["controlUi"],
            json!({
                "allowedOrigins": ["file://", "null"],
                "dangerouslyDisableDeviceAuth": true
            }),
        );
        assert_eq!(value["gateway"]["mode"], "local");
    }
}
