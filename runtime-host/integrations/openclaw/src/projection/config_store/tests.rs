use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Barrier,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use super::*;

const SECRET_CANARY: &str = "synthetic-openclaw-config-store-secret";
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
            "openclaw-config-store-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test root");
        let state_dir = CanonicalStateDir::provision(path.join("state")).expect("provision state");
        Self { path, state_dir }
    }

    fn config_path(&self) -> PathBuf {
        self.state_dir.as_path().join(CANONICAL_CONFIG_FILE)
    }

    fn store(&self) -> OpenClawConfigStore {
        OpenClawConfigStore::new(self.state_dir.clone())
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn missing_config_reads_as_an_empty_private_document() {
    let root = TestRoot::new();
    let document = root.store().read().expect("read missing config");

    assert!(document.get("gateway").is_none());
    assert!(!root.config_path().exists());
    assert_eq!(
        format!("{document:?}"),
        "OpenClawConfigDocument([REDACTED])"
    );
}

#[test]
fn workspace_selection_read_ignores_unrelated_secret_bearing_config() {
    let root = TestRoot::new();
    let workspace = root.path.join("workspace");
    fs::write(
        root.config_path(),
        serde_json::to_vec(&json!({
            "gateway": { "auth": { "token": SECRET_CANARY } },
            "agents": {
                "defaults": { "workspace": workspace },
                "list": [{
                    "id": "main",
                    "workspace": root.path.join("main-workspace"),
                    "isDefault": true,
                    "model": { "apiKey": SECRET_CANARY }
                }]
            }
        }))
        .unwrap(),
    )
    .expect("seed legacy config");

    let document = root
        .store()
        .read_workspace_selection()
        .expect("read workspace selection");

    let document = document.as_value();
    assert_eq!(
        document["agents"]["defaults"]["workspace"],
        workspace.to_str().unwrap()
    );
    assert!(document["gateway"].is_null());
    assert!(document["agents"]["list"][0]["model"].is_null());
}

#[test]
fn update_persists_a_json_object_in_the_canonical_state_directory() {
    let root = TestRoot::new();
    let result = root
        .store()
        .update(|document| {
            document.insert("gateway".into(), json!({ "port": 18789 }));
            OpenClawConfigMutation::changed()
        })
        .expect("persist config");
    assert!(result.changed);
    assert_eq!(
        root.store()
            .read()
            .expect("read stored config")
            .get("gateway"),
        Some(&json!({ "port": 18789 }))
    );
}

#[test]
fn unchanged_mutation_preserves_existing_file_bytes() {
    let root = TestRoot::new();
    let original = br#"{ "gateway": { "port": 18789 } }"#;
    fs::write(root.config_path(), original).expect("seed config");

    let result = root
        .store()
        .update(|_| OpenClawConfigMutation::unchanged())
        .expect("update unchanged config");

    assert!(!result.changed);
    assert_eq!(
        fs::read(root.config_path()).expect("read unchanged config"),
        original
    );
}

#[test]
fn reentrant_update_is_rejected_without_waiting_on_the_writer_lock() {
    let root = TestRoot::new();
    let store = root.store();
    let inner = store.clone();

    store
        .update(|_| {
            let error = inner
                .update(|_| OpenClawConfigMutation::unchanged())
                .expect_err("nested update must fail");
            assert_eq!(error, OpenClawConfigStoreError::ReentrantUpdate);
            OpenClawConfigMutation::unchanged()
        })
        .expect("outer update must complete");
}

#[test]
fn panic_during_a_mutation_does_not_block_the_next_update() {
    let root = TestRoot::new();
    let store = root.store();

    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.update(|_| panic!("synthetic mutation panic"));
    }));
    assert!(panic.is_err());

    store
        .update(|document| {
            document.insert("gateway".into(), json!({ "port": 18789 }));
            OpenClawConfigMutation::changed()
        })
        .expect("subsequent update must persist");
    assert_eq!(
        store.read().expect("read persisted config").get("gateway"),
        Some(&json!({ "port": 18789 }))
    );
}

#[test]
fn concurrent_updates_preserve_independent_mutations() {
    let root = TestRoot::new();
    let store = Arc::new(root.store());
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for (key, value) in [("first", 1), ("second", 2)] {
        let store = Arc::clone(&store);
        let barrier = Arc::clone(&barrier);
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            store
                .update(|document| {
                    document.insert(key.into(), Value::from(value));
                    OpenClawConfigMutation::changed()
                })
                .expect("persist concurrent mutation");
        }));
    }

    barrier.wait();
    for worker in workers {
        worker.join().expect("join concurrent mutation");
    }

    let document = store.read().expect("read concurrent mutations");
    assert_eq!(document.get("first"), Some(&Value::from(1)));
    assert_eq!(document.get("second"), Some(&Value::from(2)));
}

#[test]
fn rejects_invalid_documents_without_exposing_contents_or_paths() {
    let root = TestRoot::new();
    fs::write(
        root.config_path(),
        format!(r#"{{"gateway":{{"auth":{{"token":"{SECRET_CANARY}"}}}}"#),
    )
    .expect("seed invalid config");

    let error = root.store().read().expect_err("invalid config must fail");
    let rendered = format!("{error:?} {error}");

    assert_eq!(error, OpenClawConfigStoreError::InvalidDocument);
    assert_eq!(error.to_string(), "OpenClaw config document is invalid");
    assert!(!rendered.contains(SECRET_CANARY));
    assert!(!rendered.contains(root.config_path().to_string_lossy().as_ref()));
}

#[test]
fn rejects_a_scalar_document_without_exposing_contents_or_paths() {
    let root = TestRoot::new();
    fs::write(root.config_path(), SECRET_CANARY).expect("seed scalar config");

    let error = root.store().read().expect_err("scalar config must fail");
    let rendered = format!("{error:?} {error}");

    assert_eq!(error, OpenClawConfigStoreError::InvalidDocument);
    assert!(!rendered.contains(SECRET_CANARY));
    assert!(!rendered.contains(root.config_path().to_string_lossy().as_ref()));
}

#[test]
fn rejects_an_oversized_document_without_exposing_contents_or_paths() {
    let root = TestRoot::new();
    let document = format!(
        "{{\"token\":\"{}\"}}",
        "x".repeat(MAX_CONFIG_DOCUMENT_BYTES)
    );
    fs::write(root.config_path(), document).expect("seed oversized config");

    let error = root.store().read().expect_err("oversized config must fail");
    let rendered = format!("{error:?} {error}");

    assert_eq!(error, OpenClawConfigStoreError::ReadFailed);
    assert!(!rendered.contains(root.config_path().to_string_lossy().as_ref()));
}

#[test]
fn replace_failure_cleans_the_temporary_file_without_overwriting_the_target() {
    let root = TestRoot::new();
    let error = root
        .store()
        .update(|document| {
            fs::create_dir(root.config_path()).expect("occupy canonical name with directory");
            document.insert("gateway".into(), json!({ "port": 18789 }));
            OpenClawConfigMutation::changed()
        })
        .expect_err("replacement must fail");

    assert_eq!(error, OpenClawConfigStoreError::ReplaceFailed);
    assert!(root.config_path().is_dir());
    let entries = fs::read_dir(root.state_dir.as_path())
        .expect("read state directory")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect state entries");
    assert_eq!(entries.len(), 1);
}

#[test]
fn rejects_a_state_directory_replaced_after_provisioning_without_exposure() {
    let root = TestRoot::new();
    let state_path = root.state_dir.as_path().to_owned();
    fs::remove_dir(&state_path).expect("remove state directory");
    fs::create_dir(&state_path).expect("replace state directory");

    let error = root.store().read().expect_err("replaced state must fail");
    let rendered = format!("{error:?} {error}");

    assert_eq!(error, OpenClawConfigStoreError::StateDirectoryRejected);
    assert!(!rendered.contains(state_path.to_string_lossy().as_ref()));
}

#[test]
fn public_read_redacts_sensitive_config_fields_without_rewriting() {
    for document in [
        json!({ "models": { "providers": { "openai": { "apiKey": SECRET_CANARY } } } }),
        json!({ "gateway": { "auth": { "token": SECRET_CANARY } } }),
        json!({ "gateway": { "authorization": SECRET_CANARY } }),
        json!({ "models": { "providers": { "openai": { "headers": { "Authorization": SECRET_CANARY } } } } }),
    ] {
        let root = TestRoot::new();
        let bytes = serde_json::to_vec(&document).expect("serialize secret-bearing config");
        fs::write(root.config_path(), &bytes).expect("seed secret-bearing config");

        let rendered = root
            .store()
            .read()
            .expect("read redacted config")
            .as_value();

        assert_eq!(
            fs::read(root.config_path()).expect("read original config"),
            bytes
        );
        assert!(!rendered.to_string().contains(SECRET_CANARY));
        assert!(rendered.to_string().contains(REDACTED_VALUE));
    }
}

#[test]
fn public_update_accepts_sensitive_mutations_but_public_read_redacts_them() {
    let root = TestRoot::new();
    let store = root.store();
    store
        .update(|document| {
            document.insert(
                "gateway".into(),
                json!({ "auth": { "token": SECRET_CANARY } }),
            );
            OpenClawConfigMutation::changed()
        })
        .expect("persist secret-bearing mutation");

    let public = store.read().expect("read public config").as_value();
    let private = store
        .read_private()
        .expect("read private config")
        .as_value();

    assert_eq!(public["gateway"]["auth"]["token"], REDACTED_VALUE);
    assert_eq!(private["gateway"]["auth"]["token"], SECRET_CANARY);
    assert_eq!(format!("{store:?}"), "OpenClawConfigStore([REDACTED])");
}
