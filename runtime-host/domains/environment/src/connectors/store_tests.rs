use std::{fs, fs::File, io, path::Path};

use super::{
    Connector, ConnectorInput, ConnectorKind,
    persistence::ConnectorStorePersistence,
    store::{ConnectorMutation, ConnectorStore, ConnectorStoreError, WriterLock, lock_path},
    store_schema::{LEGACY_STORE_VERSION, PREVIOUS_STORE_VERSION},
};

fn connector(id: &str) -> Connector {
    let mut input = ConnectorInput::new(id.into(), ConnectorKind::McpHttp);
    input.url = Some("https://example.test/mcp".into());
    Connector::new(input)
}

fn persisted_connector(id: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "kind": "mcp-http",
        "url": "https://example.test/mcp"
    })
}

#[derive(Clone, Copy)]
enum PersistenceFailure {
    SyncData,
    Rename,
}

struct FaultingPersistence {
    failure: PersistenceFailure,
}

impl ConnectorStorePersistence for FaultingPersistence {
    fn sync_data(&self, file: &File) -> io::Result<()> {
        file.sync_data()?;
        if matches!(self.failure, PersistenceFailure::SyncData) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sync acknowledgement fault",
            ));
        }
        Ok(())
    }

    fn rename(&self, source: &Path, destination: &Path) -> io::Result<()> {
        fs::rename(source, destination)?;
        if matches!(self.failure, PersistenceFailure::Rename) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "rename acknowledgement fault",
            ));
        }
        Ok(())
    }
}

#[test]
fn sync_data_failure_requires_reopen_before_retry() {
    let root = std::env::temp_dir().join(format!(
        "connector-store-sync-fault-test-{}",
        std::process::id()
    ));
    let path = root.join("external-connectors/connectors.json");
    let mut committed = ConnectorStore::open(&path).expect("open");
    committed
        .upsert(connector("remote"))
        .expect("commit baseline");
    drop(committed);

    let mut store = ConnectorStore::open_with_persistence_io(
        &path,
        Box::new(FaultingPersistence {
            failure: PersistenceFailure::SyncData,
        }),
    )
    .expect("open with fault");
    let error = store.upsert(connector("next")).expect_err("sync failure");
    assert_eq!(
        error,
        ConnectorStoreError::CommitOutcomeUnknown(io::ErrorKind::PermissionDenied)
    );
    assert_eq!(
        store.upsert(connector("retry")),
        Err(ConnectorStoreError::RecoveryRequired)
    );
    drop(store);

    let mut reopened = ConnectorStore::open(&path).expect("reopen");
    assert!(reopened.catalog().get("remote").is_some());
    assert!(reopened.catalog().get("next").is_none());
    assert_eq!(reopened.upsert(connector("retry")).unwrap().revision, 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rename_failure_requires_reopen_before_retry() {
    let root = std::env::temp_dir().join(format!(
        "connector-store-rename-fault-test-{}",
        std::process::id()
    ));
    let path = root.join("external-connectors/connectors.json");
    let mut committed = ConnectorStore::open(&path).expect("open");
    committed
        .upsert(connector("remote"))
        .expect("commit baseline");
    drop(committed);

    let mut store = ConnectorStore::open_with_persistence_io(
        &path,
        Box::new(FaultingPersistence {
            failure: PersistenceFailure::Rename,
        }),
    )
    .expect("open with fault");
    let error = store
        .upsert(connector("remote"))
        .expect_err("rename acknowledgement failure");
    assert_eq!(
        error,
        ConnectorStoreError::CommitOutcomeUnknown(io::ErrorKind::PermissionDenied)
    );
    assert_eq!(
        store.upsert(connector("retry")),
        Err(ConnectorStoreError::RecoveryRequired)
    );
    drop(store);

    let mut reopened = ConnectorStore::open(&path).expect("reopen");
    assert!(reopened.catalog().get("remote").is_some());
    assert_eq!(reopened.revision("remote"), Some(2));
    assert_eq!(reopened.upsert(connector("retry")).unwrap().revision, 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn store_persists_revisioned_desired_and_applied_facts_across_reopen() {
    let root = std::env::temp_dir().join(format!("connector-store-test-{}", std::process::id()));
    let path = root.join("external-connectors/connectors.json");
    let mut store = ConnectorStore::open(&path).expect("open");
    let created = store.upsert(connector("remote")).expect("create");
    assert_eq!(
        created,
        ConnectorMutation {
            created: true,
            revision: 1
        }
    );
    store.record_applied("remote", 1).expect("record applied");
    let replacement = store.upsert(connector("remote")).expect("replace");
    assert_eq!(
        replacement,
        ConnectorMutation {
            created: false,
            revision: 2
        }
    );
    assert_eq!(store.applied_revision("remote"), None);
    assert_eq!(store.remove("remote").expect("remove"), Some(3));
    drop(store);

    let mut store = ConnectorStore::open(&path).expect("reopen");
    assert!(store.catalog().get("remote").is_none());
    assert_eq!(store.revision("remote"), Some(3));
    store
        .record_applied("remote", 3)
        .expect("record deletion applied");
    assert_eq!(store.applied_revision("remote"), Some(3));
    assert_eq!(
        store
            .upsert(connector("remote"))
            .expect("recreate")
            .revision,
        4
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn raw_schema_v1_recovers_with_initial_revision() {
    let root = std::env::temp_dir().join(format!(
        "connector-store-raw-v1-test-{}",
        std::process::id()
    ));
    let path = root.join("external-connectors/connectors.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{"version":1,"connectors":[{"id":"remote","kind":"mcp-http","url":"https://example.test/mcp"}]}"#,
    )
    .unwrap();

    let store = ConnectorStore::open(&path).expect("recover v1");
    assert!(store.catalog().get("remote").is_some());
    assert_eq!(store.revision("remote"), Some(1));
    assert_eq!(store.applied_revision("remote"), None);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn raw_schema_v3_recovers_revision_and_applied_evidence() {
    let root = std::env::temp_dir().join(format!(
        "connector-store-raw-v3-test-{}",
        std::process::id()
    ));
    let path = root.join("external-connectors/connectors.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"{
            "version": 3,
            "connectors": [{
                "id": "remote",
                "kind": "mcp-http",
                "url": "https://example.test/mcp"
            }],
            "revisions": {
                "remote": {"revision": 7, "appliedRevision": 5}
            }
        }"#,
    )
    .unwrap();

    let store = ConnectorStore::open(&path).expect("recover v3");
    assert!(store.catalog().get("remote").is_some());
    assert_eq!(store.revision("remote"), Some(7));
    assert_eq!(store.applied_revision("remote"), Some(5));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn persisted_document_declares_schema_version_three() {
    let root = std::env::temp_dir().join(format!(
        "connector-store-persisted-version-test-{}",
        std::process::id()
    ));
    let path = root.join("external-connectors/connectors.json");
    let mut store = ConnectorStore::open(&path).expect("open");
    store.upsert(connector("remote")).expect("persist");
    drop(store);

    let persisted = fs::read_to_string(&path).unwrap();
    assert!(persisted.contains("\"version\": 3"));
    let persisted: serde_json::Value = serde_json::from_str(&persisted).unwrap();
    assert_eq!(persisted["version"].as_u64(), Some(3));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn two_instances_report_file_lock_contention_and_recover_after_release() {
    let root = std::env::temp_dir().join(format!(
        "connector-store-lock-contention-test-{}",
        std::process::id()
    ));
    let path = root.join("external-connectors/connectors.json");
    let mut first = ConnectorStore::open(&path).expect("open first");
    let mut second = ConnectorStore::open(&path).expect("open second");
    let held = WriterLock::acquire(&lock_path(&path)).expect("hold writer lock");

    assert_eq!(
        second.upsert(connector("remote")),
        Err(ConnectorStoreError::WriterBusy)
    );
    drop(held);

    assert_eq!(first.upsert(connector("remote")).unwrap().revision, 1);
    assert_eq!(second.upsert(connector("remote")).unwrap().revision, 2);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn applied_evidence_requires_the_current_exact_revision() {
    let root = std::env::temp_dir().join(format!(
        "connector-store-revision-test-{}",
        std::process::id()
    ));
    let path = root.join("external-connectors/connectors.json");
    let mut store = ConnectorStore::open(&path).expect("open");
    store.upsert(connector("remote")).expect("create");
    assert_eq!(
        store.record_applied("remote", 2),
        Err(ConnectorStoreError::RevisionMismatch)
    );
    assert_eq!(store.applied_revision("remote"), None);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_secret_reference_records_fail_closed_during_recovery() {
    for version in [LEGACY_STORE_VERSION, PREVIOUS_STORE_VERSION] {
        for field in ["secretEnv", "secretHeaders", "secretConfigRefs"] {
            let root = std::env::temp_dir().join(format!(
                "connector-store-legacy-secret-test-{}-{version}-{field}",
                std::process::id()
            ));
            let path = root.join("external-connectors/connectors.json");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut connector = persisted_connector("remote");
            connector.as_object_mut().unwrap().insert(
                field.into(),
                serde_json::json!({
                    "Authorization": {
                        "kind": "secret-ref",
                        "ref": "credential:v1:opaque"
                    }
                }),
            );
            let mut document = serde_json::json!({
                "version": version,
                "connectors": [connector],
            });
            if version == PREVIOUS_STORE_VERSION {
                document["revisions"] = serde_json::json!({
                    "remote": { "revision": 1, "appliedRevision": 1 }
                });
            }
            fs::write(&path, document.to_string()).unwrap();

            assert!(matches!(
                ConnectorStore::open(&path),
                Err(ConnectorStoreError::Decode)
            ));
            let _ = fs::remove_dir_all(root);
        }
    }
}
