use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use crate::domain::{Connector, ConnectorCatalog, ConnectorError};

use super::{
    persistence::{ConnectorStorePersistence, StdConnectorStorePersistence},
    store_schema::{ConnectorRevision, ConnectorStoreDocument, MAX_STORE_BYTES, next_revision},
};

pub(crate) fn open(state_dir: &Path) -> Result<ConnectorStore, ConnectorStoreError> {
    ConnectorStore::open(path(state_dir))
}

fn path(state_dir: &Path) -> PathBuf {
    state_dir
        .join("external-connectors")
        .join("connectors.json")
}

pub struct ConnectorStore {
    path: PathBuf,
    lock_path: PathBuf,
    catalog: ConnectorCatalog,
    revisions: BTreeMap<String, ConnectorRevision>,
    requires_reopen: bool,
    persistence: Box<dyn ConnectorStorePersistence>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConnectorMutation {
    pub created: bool,
    pub revision: u64,
}

impl ConnectorStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, ConnectorStoreError> {
        Self::open_with_persistence(path, Box::new(StdConnectorStorePersistence))
    }

    #[cfg(test)]
    pub(crate) fn open_with_persistence_io(
        path: impl Into<PathBuf>,
        persistence: Box<dyn ConnectorStorePersistence>,
    ) -> Result<Self, ConnectorStoreError> {
        Self::open_with_persistence(path, persistence)
    }

    fn open_with_persistence(
        path: impl Into<PathBuf>,
        persistence: Box<dyn ConnectorStorePersistence>,
    ) -> Result<Self, ConnectorStoreError> {
        let path = path.into();
        ensure_parent_directory(&path)?;
        let lock_path = lock_path(&path);
        let _lock = WriterLock::acquire(&lock_path)?;
        remove_stale_temporary(&path)?;
        let (catalog, revisions) = recover(&path)?;
        Ok(Self {
            catalog,
            revisions,
            path,
            lock_path,
            requires_reopen: false,
            persistence,
        })
    }

    pub fn catalog(&self) -> &ConnectorCatalog {
        &self.catalog
    }

    #[cfg(test)]
    fn revision(&self, id: &str) -> Option<u64> {
        self.revisions.get(id).map(|record| record.revision)
    }

    #[cfg(test)]
    fn applied_revision(&self, id: &str) -> Option<u64> {
        self.revisions
            .get(id)
            .and_then(|record| record.applied_revision)
    }

    pub fn upsert(
        &mut self,
        connector: Connector,
    ) -> Result<ConnectorMutation, ConnectorStoreError> {
        if self.requires_reopen {
            return Err(ConnectorStoreError::RecoveryRequired);
        }
        let _lock = WriterLock::acquire(&self.lock_path)?;
        self.reload()?;
        let mut catalog = self.catalog.clone();
        let created = catalog.upsert(connector.clone())?;
        let mut revisions = self.revisions.clone();
        let revision = next_revision(revisions.get(connector.id()))?;
        revisions.insert(
            connector.id().to_owned(),
            ConnectorRevision {
                revision,
                applied_revision: None,
                tombstoned: false,
            },
        );
        self.persist(&catalog, &revisions)?;
        self.catalog = catalog;
        self.revisions = revisions;
        Ok(ConnectorMutation { created, revision })
    }

    pub fn remove(&mut self, id: &str) -> Result<Option<u64>, ConnectorStoreError> {
        if self.requires_reopen {
            return Err(ConnectorStoreError::RecoveryRequired);
        }
        let _lock = WriterLock::acquire(&self.lock_path)?;
        self.reload()?;
        let mut catalog = self.catalog.clone();
        if !catalog.remove(id)? {
            return Ok(None);
        }
        let mut revisions = self.revisions.clone();
        let revision = next_revision(revisions.get(id))?;
        revisions.insert(
            id.into(),
            ConnectorRevision {
                revision,
                applied_revision: None,
                tombstoned: true,
            },
        );
        self.persist(&catalog, &revisions)?;
        self.catalog = catalog;
        self.revisions = revisions;
        Ok(Some(revision))
    }

    pub fn record_applied(&mut self, id: &str, revision: u64) -> Result<(), ConnectorStoreError> {
        if self.requires_reopen {
            return Err(ConnectorStoreError::RecoveryRequired);
        }
        let _lock = WriterLock::acquire(&self.lock_path)?;
        self.reload()?;
        let mut revisions = self.revisions.clone();
        let record = revisions
            .get_mut(id)
            .ok_or(ConnectorStoreError::RevisionMismatch)?;
        if record.revision != revision {
            return Err(ConnectorStoreError::RevisionMismatch);
        }
        record.applied_revision = Some(revision);
        let catalog = self.catalog.clone();
        self.persist(&catalog, &revisions)?;
        self.revisions = revisions;
        Ok(())
    }

    fn reload(&mut self) -> Result<(), ConnectorStoreError> {
        let (catalog, revisions) = recover(&self.path)?;
        self.catalog = catalog;
        self.revisions = revisions;
        Ok(())
    }

    fn persist(
        &mut self,
        catalog: &ConnectorCatalog,
        revisions: &BTreeMap<String, ConnectorRevision>,
    ) -> Result<(), ConnectorStoreError> {
        let bytes =
            serde_json::to_vec_pretty(&ConnectorStoreDocument::from_state(catalog, revisions))
                .map_err(|_| ConnectorStoreError::Encode)?;
        if bytes.len() > MAX_STORE_BYTES as usize {
            return Err(ConnectorStoreError::RecordTooLarge);
        }
        let temporary = temporary_path(&self.path);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| ConnectorStoreError::Commit(error.kind()))?;
        use std::io::Write;
        if let Err(error) = file.write_all(&bytes) {
            let _ = fs::remove_file(&temporary);
            return Err(ConnectorStoreError::Commit(error.kind()));
        }
        if let Err(error) = file.write_all(b"\n") {
            let _ = fs::remove_file(&temporary);
            return Err(ConnectorStoreError::Commit(error.kind()));
        }
        if let Err(error) = self.persistence.sync_data(&file) {
            self.requires_reopen = true;
            let _ = fs::remove_file(&temporary);
            return Err(ConnectorStoreError::CommitOutcomeUnknown(error.kind()));
        }
        drop(file);
        if let Err(error) = self.persistence.rename(&temporary, &self.path) {
            self.requires_reopen = true;
            let _ = fs::remove_file(&temporary);
            return Err(ConnectorStoreError::CommitOutcomeUnknown(error.kind()));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorStoreError {
    Connector(ConnectorError),
    Commit(io::ErrorKind),
    CommitOutcomeUnknown(io::ErrorKind),
    Decode,
    Encode,
    RecordTooLarge,
    RecoveryRequired,
    RevisionMismatch,
    RevisionOverflow,
    WriterBusy,
}
impl From<ConnectorError> for ConnectorStoreError {
    fn from(value: ConnectorError) -> Self {
        Self::Connector(value)
    }
}
impl std::fmt::Display for ConnectorStoreError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(match self {
            Self::Connector(error) => return error.fmt(output),
            Self::Commit(_) => "external connector facts could not be committed",
            Self::CommitOutcomeUnknown(_) => {
                "external connector commit outcome is unknown; reopen before another mutation"
            }
            Self::Decode => "external connector facts are invalid",
            Self::Encode => "external connector facts could not be encoded",
            Self::RecordTooLarge => "external connector facts exceed the durable limit",
            Self::RecoveryRequired => {
                "external connector facts require reopening before another mutation"
            }
            Self::RevisionMismatch => {
                "external connector revision no longer matches the durable facts"
            }
            Self::RevisionOverflow => "external connector revision is exhausted",
            Self::WriterBusy => "external connector facts writer is busy",
        })
    }
}
impl std::error::Error for ConnectorStoreError {}

fn recover(
    path: &Path,
) -> Result<(ConnectorCatalog, BTreeMap<String, ConnectorRevision>), ConnectorStoreError> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= MAX_STORE_BYTES as usize => {
            serde_json::from_slice::<ConnectorStoreDocument>(&bytes)
                .map_err(|_| ConnectorStoreError::Decode)?
                .into_state()
        }
        Ok(_) => Err(ConnectorStoreError::RecordTooLarge),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok((ConnectorCatalog::default(), BTreeMap::new()))
        }
        Err(error) => Err(ConnectorStoreError::Commit(error.kind())),
    }
}
fn ensure_parent_directory(path: &Path) -> Result<(), ConnectorStoreError> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| ConnectorStoreError::Commit(error.kind()))?;
    }
    Ok(())
}
pub(super) fn lock_path(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    lock.into()
}
fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".next");
    temporary.into()
}
fn remove_stale_temporary(path: &Path) -> Result<(), ConnectorStoreError> {
    match fs::remove_file(temporary_path(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ConnectorStoreError::Commit(error.kind())),
    }
}
pub(super) struct WriterLock {
    path: PathBuf,
}
impl WriterLock {
    pub(super) fn acquire(path: &Path) -> Result<Self, ConnectorStoreError> {
        match File::create_new(path) {
            Ok(file) => {
                drop(file);
                Ok(Self {
                    path: path.to_owned(),
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(ConnectorStoreError::WriterBusy)
            }
            Err(error) => Err(ConnectorStoreError::Commit(error.kind())),
        }
    }
}
impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, fs::File, io, path::Path};

    use crate::domain::{Connector, ConnectorInput, ConnectorKind};

    use super::{
        super::{
            persistence::ConnectorStorePersistence,
            store_schema::{LEGACY_STORE_VERSION, PREVIOUS_STORE_VERSION},
        },
        ConnectorMutation, ConnectorStore, ConnectorStoreError, WriterLock, lock_path,
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
        let root =
            std::env::temp_dir().join(format!("connector-store-test-{}", std::process::id()));
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
}
