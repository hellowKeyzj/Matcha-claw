use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use super::{Connector, ConnectorCatalog, ConnectorError};

use super::{
    persistence::{ConnectorStorePersistence, StdConnectorStorePersistence},
    store_schema::{ConnectorRevision, ConnectorStoreDocument, MAX_STORE_BYTES, next_revision},
};

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

    pub fn revision(&self, id: &str) -> Option<u64> {
        self.revisions.get(id).map(|record| record.revision)
    }

    pub fn applied_revision(&self, id: &str) -> Option<u64> {
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
