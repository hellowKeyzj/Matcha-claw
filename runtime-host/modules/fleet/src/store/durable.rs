use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const WRITER_LOCK_TIMEOUT: Duration = Duration::from_millis(500);
const WRITER_LOCK_POLL: Duration = Duration::from_millis(1);

use platform::endpoint::NativeAgentId;

use crate::domain::topology::CredentialHash;

use super::{
    FleetFacts, StoreFault,
    codec::{
        CURRENT_SCHEMA_VERSION, HEADER_LEN, MAX_LOG_BYTES, RecoveredFacts, encode_frame,
        initialize_log, recover_log,
    },
};

pub struct FleetStore {
    path: PathBuf,
    lock_path: PathBuf,
    facts: FleetFacts,
    epoch: u64,
    requires_reopen: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentIngressIdentity {
    agent_id: NativeAgentId,
    presented_ingress_hash: CredentialHash,
    enrollment_hash: Option<CredentialHash>,
    at: SystemTime,
}

impl AgentIngressIdentity {
    pub const fn new(
        agent_id: NativeAgentId,
        presented_ingress_hash: CredentialHash,
        enrollment_hash: Option<CredentialHash>,
        at: SystemTime,
    ) -> Self {
        Self {
            agent_id,
            presented_ingress_hash,
            enrollment_hash,
            at,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IngressAuthentication {
    Authenticated {
        agent_id: NativeAgentId,
        enrollment: IngressEnrollment,
        credential: IngressCredential,
    },
    Unauthorized,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IngressEnrollment {
    Existing,
    Consumed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IngressCredential {
    Existing,
    Issued,
    Replaced,
}

impl FleetStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        Self::open_with_recovery(path, true)
    }

    pub fn open_live(path: impl Into<PathBuf>) -> Result<Self, StoreFault> {
        Self::open_with_recovery(path, false)
    }

    fn open_with_recovery(
        path: impl Into<PathBuf>,
        recover_interrupted_delivery: bool,
    ) -> Result<Self, StoreFault> {
        let path = path.into();
        ensure_parent_directory(&path)?;
        let lock_path = lock_path(&path);
        let _lock = WriterLock::acquire(&lock_path)?;
        let RecoveredFacts {
            mut facts,
            schema,
            epoch,
            committed_len,
            truncated_tail,
            had_interrupted_delivery,
        } = recover_or_initialize(&path)?;
        if truncated_tail {
            truncate_to_recovered_prefix(&path, committed_len)?;
        }
        let epoch = if schema != CURRENT_SCHEMA_VERSION {
            rewrite_migrated_facts(&path, &facts)?
        } else {
            epoch
        };
        let epoch = if recover_interrupted_delivery && had_interrupted_delivery {
            facts.recover_interrupted_deliveries();
            commit_recovered_facts(&path, epoch, &facts)?
        } else {
            epoch
        };

        Ok(Self {
            path,
            lock_path,
            facts,
            epoch,
            requires_reopen: false,
        })
    }

    pub fn facts(&self) -> &FleetFacts {
        &self.facts
    }

    pub fn authenticate_or_enroll_ingress(
        &mut self,
        identity: AgentIngressIdentity,
    ) -> Result<IngressAuthentication, StoreFault> {
        let agent_id = identity.agent_id.clone();
        self.transact(|facts| {
            let issue = facts.authenticate_or_enroll_ingress(
                &identity.agent_id,
                identity.presented_ingress_hash,
                identity.enrollment_hash,
                identity.at,
            )?;
            Ok(match issue {
                None => IngressAuthentication::Unauthorized,
                Some(crate::domain::topology::IngressCredentialIssue::ExistingHash) => {
                    IngressAuthentication::Authenticated {
                        agent_id,
                        enrollment: IngressEnrollment::Existing,
                        credential: IngressCredential::Existing,
                    }
                }
                Some(crate::domain::topology::IngressCredentialIssue::Issued) => {
                    IngressAuthentication::Authenticated {
                        agent_id,
                        enrollment: IngressEnrollment::Consumed,
                        credential: IngressCredential::Issued,
                    }
                }
                Some(crate::domain::topology::IngressCredentialIssue::Replaced) => {
                    IngressAuthentication::Authenticated {
                        agent_id,
                        enrollment: IngressEnrollment::Consumed,
                        credential: IngressCredential::Replaced,
                    }
                }
                Some(crate::domain::topology::IngressCredentialIssue::UnknownAgent) => {
                    IngressAuthentication::Unauthorized
                }
            })
        })
    }

    pub(crate) fn transact<T>(
        &mut self,
        mutation: impl FnOnce(&mut FleetFacts) -> Result<T, StoreFault>,
    ) -> Result<T, StoreFault> {
        self.ensure_writable()?;
        let lock = WriterLock::acquire(&self.lock_path)?;
        self.refresh_locked()?;
        let mut candidate = self.facts.clone();
        let result = mutation(&mut candidate)?;
        self.commit_locked(&lock, candidate)?;
        Ok(result)
    }

    fn ensure_writable(&self) -> Result<(), StoreFault> {
        if self.requires_reopen {
            return Err(StoreFault::RecoveryRequired);
        }
        Ok(())
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

    fn commit_locked(&mut self, lock: &WriterLock, facts: FleetFacts) -> Result<(), StoreFault> {
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
                facts: FleetFacts::default(),
                schema: CURRENT_SCHEMA_VERSION,
                epoch: 0,
                committed_len: HEADER_LEN as u64,
                truncated_tail: false,
                had_interrupted_delivery: false,
            })
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let file = File::open(path).map_err(|error| StoreFault::Read(error.kind()))?;
            recover_log(file)
        }
        Err(error) => Err(StoreFault::Commit(error.kind())),
    }
}

/// Replaces a complete v5 log with one v6 snapshot. The replacement is written
/// and synced before its header becomes visible, so v5 cannot be mixed with v6
/// frames after an interrupted upgrade.
fn rewrite_migrated_facts(path: &Path, facts: &FleetFacts) -> Result<u64, StoreFault> {
    let temporary = migration_temporary_path(path)?;
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| StoreFault::Recovery(error.kind()))?;
        initialize_log(&mut output)?;
        let frame = encode_frame(1, facts)?;
        output
            .write_all(&frame)
            .and_then(|()| output.sync_all())
            .map_err(|error| StoreFault::Recovery(error.kind()))?;
        drop(output);
        replace_migrated_log(&temporary, path)?;
        Ok(1)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn migration_temporary_path(path: &Path) -> Result<PathBuf, StoreFault> {
    let parent = path
        .parent()
        .ok_or(StoreFault::Recovery(io::ErrorKind::NotFound))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(StoreFault::Recovery(io::ErrorKind::InvalidInput))?;
    Ok(parent.join(format!(".{name}.v6-migration")))
}

#[cfg(unix)]
fn replace_migrated_log(temporary: &Path, path: &Path) -> Result<(), StoreFault> {
    fs::rename(temporary, path).map_err(|error| StoreFault::Recovery(error.kind()))
}

#[cfg(windows)]
fn replace_migrated_log(temporary: &Path, path: &Path) -> Result<(), StoreFault> {
    use std::{
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !path.exists() {
        return fs::rename(temporary, path).map_err(|error| StoreFault::Recovery(error.kind()));
    }
    let replaced: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let replacement: Vec<u16> = temporary.as_os_str().encode_wide().chain([0]).collect();
    if unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            null(),
            0,
            null_mut(),
            null_mut(),
        )
    } == 0
    {
        return Err(StoreFault::Recovery(io::ErrorKind::Other));
    }
    Ok(())
}

fn commit_recovered_facts(path: &Path, epoch: u64, facts: &FleetFacts) -> Result<u64, StoreFault> {
    let next_epoch = epoch.checked_add(1).ok_or(StoreFault::EpochOverflow)?;
    let frame = encode_frame(next_epoch, facts)?;
    let log_len = fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| StoreFault::Commit(error.kind()))?;
    let projected_len = log_len
        .checked_add(u64::try_from(frame.len()).map_err(|_| StoreFault::LogFull)?)
        .ok_or(StoreFault::LogFull)?;
    if projected_len > MAX_LOG_BYTES {
        return Err(StoreFault::LogFull);
    }

    let mut log = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|error| StoreFault::Commit(error.kind()))?;
    log.write_all(&frame)
        .map_err(|error| StoreFault::Commit(error.kind()))?;
    log.sync_data()
        .map_err(|error| StoreFault::CommitOutcomeUnknown(error.kind()))?;
    Ok(next_epoch)
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

fn lock_path(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    lock.into()
}

struct WriterLock {
    path: PathBuf,
}

impl WriterLock {
    fn acquire(path: &Path) -> Result<Self, StoreFault> {
        let started = SystemTime::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(file) => {
                    drop(file);
                    return Ok(Self {
                        path: path.to_owned(),
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let elapsed = started.elapsed().unwrap_or_default();
                    if elapsed >= WRITER_LOCK_TIMEOUT {
                        return Err(StoreFault::WriterBusy);
                    }
                    std::thread::sleep(WRITER_LOCK_POLL.min(WRITER_LOCK_TIMEOUT - elapsed));
                }
                Err(error) => return Err(StoreFault::Lock(error.kind())),
            }
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
