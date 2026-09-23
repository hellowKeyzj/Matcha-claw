use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};

use platform::state_dir::CanonicalStateDir;

use super::*;

static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    path: PathBuf,
    state_dir: CanonicalStateDir,
}

impl TestRoot {
    fn new() -> Self {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "openclaw-security-projection-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test root");
        let state_dir = CanonicalStateDir::provision(path.join("state")).expect("provision state");
        Self { path, state_dir }
    }

    fn config_path(&self) -> PathBuf {
        self.state_dir.as_path().join("openclaw.json")
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn normalized_runtime() -> Map<String, Value> {
    json!({
        "runtimeGuardEnabled": true,
        "blockDestructive": true,
        "blockSecrets": true,
        "auditFailureMode": null
    })
    .as_object()
    .expect("runtime fixture must be an object")
    .clone()
}

#[test]
fn normalized_runtime_merges_into_security_core_without_erasing_plugin_fields() {
    let root = TestRoot::new();
    fs::write(
        root.config_path(),
        serde_json::to_vec(&json!({
            "plugins": {
                "catalog": { "source": "bundled" },
                "entries": {
                    "security-core": {
                        "enabled": true,
                        "config": {
                            "pluginSpecificSetting": "preserved",
                            "runtimeGuardEnabled": false
                        }
                    },
                    "other-plugin": { "enabled": false }
                }
            },
            "gateway": { "port": 18789 }
        }))
        .expect("serialize seed"),
    )
    .expect("seed config");

    assert!(
        apply_normalized(root.state_dir.clone(), &normalized_runtime()).expect("apply runtime")
    );
    let document = OpenClawConfigStore::new(root.state_dir.clone())
        .read()
        .expect("read config");
    let security_core = document
        .get("plugins")
        .and_then(|plugins| plugins.get("entries"))
        .and_then(|entries| entries.get("security-core"))
        .expect("security core");

    assert_eq!(document.get("gateway"), Some(&json!({ "port": 18789 })));
    assert_eq!(security_core.get("enabled"), Some(&json!(true)));
    assert_eq!(
        security_core
            .get("config")
            .and_then(|config| config.get("pluginSpecificSetting")),
        Some(&json!("preserved"))
    );
    assert_eq!(
        security_core
            .get("config")
            .and_then(|config| config.get("runtimeGuardEnabled")),
        Some(&json!(true))
    );
    assert_eq!(
        document
            .get("plugins")
            .and_then(|plugins| plugins.get("entries"))
            .and_then(|entries| entries.get("other-plugin")),
        Some(&json!({ "enabled": false }))
    );
}

#[test]
fn reapplying_the_same_normalized_runtime_is_a_no_op() {
    let root = TestRoot::new();
    let runtime = normalized_runtime();

    assert!(apply_normalized(root.state_dir.clone(), &runtime).expect("initial apply"));
    assert!(!apply_normalized(root.state_dir.clone(), &runtime).expect("repeat apply"));
}

#[test]
fn saved_policy_runtime_projection_applies_without_exposing_runtime_in_debug() {
    let root = TestRoot::new();
    let runtime = normalized_runtime();
    let projection = SavedPolicyRuntimeProjection::from_normalized_runtime(runtime);

    assert!(
        projection
            .apply(root.state_dir.clone())
            .expect("apply saved runtime")
    );
    assert_eq!(
        format!("{projection:?}"),
        "SavedPolicyRuntimeProjection([REDACTED])"
    );
}

#[test]
fn rejects_nested_private_auth_before_public_config_commit() {
    let root = TestRoot::new();
    let original = json!({
        "plugins": {
            "entries": {
                "security-core": {
                    "enabled": true,
                    "config": { "runtimeGuardEnabled": true }
                }
            }
        },
        "gateway": { "port": 18789 }
    });
    fs::write(
        root.config_path(),
        serde_json::to_vec(&original).expect("serialize seed"),
    )
    .expect("seed config");

    let private_runtime = json!({
        "gateway": { "auth": { "token": "private-token" } }
    })
    .as_object()
    .expect("private runtime must be an object")
    .clone();

    assert_eq!(
        apply_normalized(root.state_dir.clone(), &private_runtime)
            .expect_err("private auth must not enter public config"),
        SecurityProjectionError::ConfigStore
    );
    let document = OpenClawConfigStore::new(root.state_dir.clone())
        .read()
        .expect("read unchanged config");
    assert_eq!(document.as_value(), original);
    assert!(
        !fs::read_to_string(root.config_path())
            .expect("read config bytes")
            .contains("private-token")
    );
}

#[test]
fn config_store_failures_map_to_a_redacted_projection_error() {
    let root = TestRoot::new();
    fs::write(root.config_path(), b"{\"invalid\":").expect("seed malformed config");

    let error = apply_normalized(root.state_dir.clone(), &normalized_runtime())
        .expect_err("reject malformed config");

    assert_eq!(error, SecurityProjectionError::ConfigStore);
    assert_eq!(
        error.to_string(),
        "OpenClaw security policy persistence failed"
    );
    assert!(!format!("{error:?} {error}").contains("runtimeGuardEnabled"));
}
