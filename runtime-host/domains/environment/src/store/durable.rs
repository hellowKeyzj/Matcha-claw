use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use crate::{
    definition::{DesiredDefinition, EnvironmentId, EnvironmentRevision},
    ports::AppliedProjection,
};

use super::{
    AppliedEvidence, ApplyEvidenceFault, DesiredWriteFault, EnvironmentFacts, StoreFault,
    codec::{MAX_LOG_BYTES, RecoveredFacts, encode_frame, initialize_log, recover_log},
};

pub struct EnvironmentStore {
    path: PathBuf,
    lock_path: PathBuf,
    facts: Vec<EnvironmentFacts>,
    epoch: u64,
    requires_reopen: bool,
}

impl EnvironmentStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        let path = path.into();
        ensure_parent_directory(&path)?;
        let lock_path = lock_path(&path);
        let _lock = WriterLock::acquire(&lock_path)?;
        let RecoveredFacts {
            facts,
            epoch,
            committed_len,
            truncated_tail,
        } = recover_or_initialize(&path)?;
        if truncated_tail {
            truncate_to_recovered_prefix(&path, committed_len)?;
        }

        Ok(Self {
            path,
            lock_path,
            facts,
            epoch,
            requires_reopen: false,
        })
    }

    pub fn facts(&self) -> &[EnvironmentFacts] {
        &self.facts
    }

    pub fn environment(&self, environment_id: &EnvironmentId) -> Option<&EnvironmentFacts> {
        self.facts
            .iter()
            .find(|facts| facts.environment_id() == environment_id)
    }

    pub fn persist_desired(
        &mut self,
        desired: DesiredDefinition,
    ) -> Result<&EnvironmentFacts, StoreFault> {
        self.ensure_writable()?;
        let environment_id = desired.environment_id().clone();
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let candidate = self.with_desired(desired)?;
        self.commit_locked(&lock, candidate)?;
        Ok(self
            .environment(&environment_id)
            .expect("persisted Environment facts must be addressable by their identity"))
    }

    pub fn persist_delete(
        &mut self,
        environment_id: &EnvironmentId,
        expected_revision: EnvironmentRevision,
    ) -> Result<&EnvironmentFacts, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let candidate = self.with_tombstone(environment_id, expected_revision)?;
        self.commit_locked(&lock, candidate)?;
        Ok(self
            .environment(environment_id)
            .expect("tombstoned Environment facts must remain addressable by their identity"))
    }

    pub fn record_applied(
        &mut self,
        projection: AppliedProjection,
    ) -> Result<&EnvironmentFacts, StoreFault> {
        self.ensure_writable()?;
        let environment_id = projection.environment_id().clone();
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let candidate = self.with_applied(&projection)?;
        self.commit_locked(&lock, candidate)?;
        Ok(self
            .environment(&environment_id)
            .expect("applied evidence must remain associated with its desired facts"))
    }

    fn ensure_writable(&self) -> Result<(), StoreFault> {
        if self.requires_reopen {
            return Err(StoreFault::RecoveryRequired);
        }
        Ok(())
    }

    fn with_desired(
        &self,
        desired: DesiredDefinition,
    ) -> Result<Vec<EnvironmentFacts>, DesiredWriteFault> {
        let mut facts = self.facts.clone();
        match facts
            .iter()
            .position(|current| current.environment_id() == desired.environment_id())
        {
            None => {
                if desired.revision().get() != 1 {
                    return Err(DesiredWriteFault::InitialRevisionRequired);
                }
                facts.push(EnvironmentFacts::new(desired, None));
            }
            Some(index) => {
                let current = &facts[index];
                if desired.revision() < current.desired_revision() {
                    return Err(DesiredWriteFault::StaleRevision {
                        current: current.desired_revision(),
                        received: desired.revision(),
                    });
                }
                if current.is_tombstone() {
                    if current.desired_revision().next().ok() != Some(desired.revision()) {
                        return Err(DesiredWriteFault::RevisionMustFollowCurrent {
                            current: current.desired_revision(),
                            received: desired.revision(),
                        });
                    }
                    facts[index] = EnvironmentFacts::new(desired, None);
                    return Ok(facts);
                }
                if desired.revision() == current.desired_revision() {
                    if current.desired() != &desired {
                        return Err(DesiredWriteFault::RevisionConflict {
                            revision: desired.revision(),
                        });
                    }
                    return Ok(facts);
                }
                if current.desired_revision().next().ok() != Some(desired.revision()) {
                    return Err(DesiredWriteFault::RevisionMustFollowCurrent {
                        current: current.desired_revision(),
                        received: desired.revision(),
                    });
                }
                facts[index] = EnvironmentFacts::new(desired, current.applied().copied());
            }
        }
        Ok(facts)
    }

    fn with_tombstone(
        &self,
        environment_id: &EnvironmentId,
        expected_revision: EnvironmentRevision,
    ) -> Result<Vec<EnvironmentFacts>, DesiredWriteFault> {
        let mut facts = self.facts.clone();
        let Some(index) = facts
            .iter()
            .position(|current| current.environment_id() == environment_id)
        else {
            return Err(DesiredWriteFault::UnknownEnvironment);
        };
        let current = &facts[index];
        if current.desired_revision() != expected_revision {
            return Err(DesiredWriteFault::RevisionConflict {
                revision: expected_revision,
            });
        }
        if !current.is_tombstone() {
            facts[index] = EnvironmentFacts::tombstone(current.desired().clone());
        }
        Ok(facts)
    }

    fn with_applied(
        &self,
        projection: &AppliedProjection,
    ) -> Result<Vec<EnvironmentFacts>, ApplyEvidenceFault> {
        let mut facts = self.facts.clone();
        let Some(index) = facts
            .iter()
            .position(|current| current.environment_id() == projection.environment_id())
        else {
            return Err(ApplyEvidenceFault::UnknownEnvironment);
        };
        let current = &facts[index];
        if current.is_tombstone() {
            return Err(ApplyEvidenceFault::UnknownEnvironment);
        }
        let desired = current.desired();
        if projection.revision() != current.desired_revision() {
            return Err(ApplyEvidenceFault::RevisionMismatch {
                desired: current.desired_revision(),
                received: projection.revision(),
            });
        }
        if !projection.covers(desired) {
            return Err(ApplyEvidenceFault::IncompleteVerification);
        }
        facts[index] = EnvironmentFacts::new(
            desired.clone(),
            Some(AppliedEvidence::new(projection.revision())),
        );
        Ok(facts)
    }

    fn refresh_locked(&mut self) -> Result<(), StoreFault> {
        let recovered =
            recover_log(File::open(&self.path).map_err(|error| StoreFault::Read(error.kind()))?)?;
        if recovered.truncated_tail {
            truncate_to_recovered_prefix(&self.path, recovered.committed_len)?;
        }
        self.facts = recovered.facts;
        self.epoch = recovered.epoch;
        Ok(())
    }

    fn commit_locked(
        &mut self,
        lock: &WriterLock,
        facts: Vec<EnvironmentFacts>,
    ) -> Result<(), StoreFault> {
        let next_epoch = self.epoch.checked_add(1).ok_or(StoreFault::EpochOverflow)?;
        let frame = encode_frame(next_epoch, &facts)?;
        let log_len = lock.log_len(&self.path)?;
        let projected_len = log_len
            .checked_add(u64::try_from(frame.len()).map_err(|_| StoreFault::LogFull)?)
            .ok_or(StoreFault::LogFull)?;
        if projected_len > MAX_LOG_BYTES {
            return Err(StoreFault::LogFull);
        }
        let mut log = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .map_err(|error| StoreFault::Commit(error.kind()))?;
        if let Err(error) = log.write_all(&frame) {
            return Err(StoreFault::Commit(error.kind()));
        }
        if let Err(error) = log.sync_data() {
            self.requires_reopen = true;
            return Err(StoreFault::CommitOutcomeUnknown(error.kind()));
        }
        self.facts = facts;
        self.epoch = next_epoch;
        Ok(())
    }
}

fn ensure_parent_directory(path: &Path) -> Result<(), StoreFault> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| StoreFault::Commit(error.kind()))?;
    }
    Ok(())
}

fn recover_or_initialize(path: &Path) -> Result<RecoveredFacts, StoreFault> {
    match File::open(path) {
        Ok(file) => recover_log(file),
        Err(error) if error.kind() == io::ErrorKind::NotFound => initialize_log_file(path),
        Err(error) => Err(StoreFault::Read(error.kind())),
    }
}

fn initialize_log_file(path: &Path) -> Result<RecoveredFacts, StoreFault> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            initialize_log(&mut file)?;
            file.sync_all()
                .map_err(|error| StoreFault::CommitOutcomeUnknown(error.kind()))?;
            Ok(RecoveredFacts {
                facts: Vec::new(),
                epoch: 0,
                committed_len: super::codec::HEADER_LEN as u64,
                truncated_tail: false,
            })
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let file = File::open(path).map_err(|error| StoreFault::Read(error.kind()))?;
            recover_log(file)
        }
        Err(error) => Err(StoreFault::Commit(error.kind())),
    }
}

fn truncate_to_recovered_prefix(path: &Path, committed_len: u64) -> Result<(), StoreFault> {
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| {
            file.set_len(committed_len)?;
            file.sync_all()
        })
        .map_err(|error| StoreFault::Recovery(error.kind()))
}

pub(super) fn lock_path(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    lock.into()
}

pub(super) struct WriterLock {
    path: PathBuf,
}

impl WriterLock {
    pub(super) fn acquire(path: &Path) -> Result<Self, StoreFault> {
        match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(file) => {
                drop(file);
                Ok(Self {
                    path: path.to_owned(),
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(StoreFault::WriterBusy)
            }
            Err(error) => Err(StoreFault::Lock(error.kind())),
        }
    }

    fn log_len(&self, path: &Path) -> Result<u64, StoreFault> {
        fs::metadata(path)
            .map(|metadata| metadata.len())
            .map_err(|error| StoreFault::Commit(error.kind()))
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
