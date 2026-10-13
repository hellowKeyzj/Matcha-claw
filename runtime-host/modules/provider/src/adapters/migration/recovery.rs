use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use foundation::storage::{PrivateMode, provision_private_directory, set_private_mode};
use serde::{Deserialize, Serialize};

use super::{
    ProviderMigrationFault, SelectedSource, SourceSelection, read_bounded, temporary_path,
};

const RECORD_FILE: &str = "provider-recovery.v1.json";
const CASCADE_FILE: &str = "provider-cascade.v1.json";
const TARGET_BACKUPS: [&str; 3] = ["accounts.original", "models.original", "routing.original"];
const SOURCE_BACKUPS: [&str; 3] = ["accounts.source", "models.source", "routing.source"];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRecoveryNotice {
    pub backup_directory: String,
}

pub struct ProviderRecoveryStore {
    root: PathBuf,
}

impl ProviderRecoveryStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn pending(&self) -> Result<Option<ProviderRecoveryNotice>, ProviderMigrationFault> {
        let _lock = self.writer_lock()?;
        match self.record()? {
            Some(record) if record.phase == Phase::Committed && record.reset => {
                let directory = self.backup_directory(&record)?;
                Ok(Some(ProviderRecoveryNotice {
                    backup_directory: directory
                        .to_str()
                        .ok_or(ProviderMigrationFault::Recovery)?
                        .to_owned(),
                }))
            }
            Some(record) if record.phase == Phase::Prepared => {
                Err(ProviderMigrationFault::Recovery)
            }
            _ => Ok(None),
        }
    }

    pub fn acknowledge(&self) -> Result<(), ProviderMigrationFault> {
        let _lock = self.writer_lock()?;
        match self.record()? {
            Some(record) if record.phase == Phase::Prepared => {
                Err(ProviderMigrationFault::Recovery)
            }
            Some(_) => self.clear_record(),
            None => Ok(()),
        }
    }

    pub(super) fn writer_lock(&self) -> Result<File, ProviderMigrationFault> {
        fs::create_dir_all(&self.root).map_err(journal_fault)?;
        let path = self.root.join("provider-recovery.v1.lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(journal_fault)?;
        set_private_mode(&path, PrivateMode::File)
            .map_err(|_| ProviderMigrationFault::Permission)?;
        // OS ownership ends on close/crash; the lock file must never be unlinked while writers wait.
        file.lock().map_err(journal_fault)?;
        Ok(file)
    }

    pub(super) fn recover_prepared(
        &self,
        paths: &[PathBuf; 3],
    ) -> Result<(), ProviderMigrationFault> {
        let Some(record) = self.record()? else {
            return Ok(());
        };
        if &record.targets != paths {
            return Err(ProviderMigrationFault::Recovery);
        }
        if record.phase == Phase::Prepared {
            self.restore(&record)?;
            self.clear_record()?;
        } else if !record.reset {
            self.clear_record()?;
        }
        Ok(())
    }

    fn path(&self) -> PathBuf {
        self.root.join(RECORD_FILE)
    }

    fn record(&self) -> Result<Option<RecoveryRecord>, ProviderMigrationFault> {
        let Some(bytes) = read_bounded(&self.path()).map_err(|error| match error {
            ProviderMigrationFault::InputTooLarge => ProviderMigrationFault::Recovery,
            other => other,
        })?
        else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| ProviderMigrationFault::Recovery)
    }

    fn backup_directory(&self, record: &RecoveryRecord) -> Result<PathBuf, ProviderMigrationFault> {
        let leaf = Path::new(&record.backup);
        if record.backup.is_empty()
            || leaf.components().count() != 1
            || !matches!(
                leaf.components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return Err(ProviderMigrationFault::Recovery);
        }
        let parent = self.root.join("provider-backups");
        let directory = parent.join(leaf);
        for path in [&parent, &directory] {
            let metadata = fs::symlink_metadata(path).map_err(read_fault)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(ProviderMigrationFault::Recovery);
            }
        }
        Ok(directory)
    }

    fn persist(&self, record: &RecoveryRecord) -> Result<(), ProviderMigrationFault> {
        let bytes = serde_json::to_vec(record).map_err(|_| ProviderMigrationFault::Encode)?;
        let path = self.path();
        let temporary = temporary_path(&path);
        remove_if_present(&temporary).map_err(journal_fault)?;
        write_private(&temporary, &bytes).map_err(record_fault)?;
        crate::persistence::replace_file(&temporary, &path).map_err(journal_fault)?;
        sync_file(&path).map_err(journal_fault)?;
        sync_parent(&path).map_err(journal_fault)
    }

    fn clear_record(&self) -> Result<(), ProviderMigrationFault> {
        remove_if_present(&self.path()).map_err(journal_fault)?;
        sync_parent(&self.path()).map_err(journal_fault)
    }

    fn restore(&self, record: &RecoveryRecord) -> Result<(), ProviderMigrationFault> {
        let directory = self.backup_directory(record)?;
        for (index, target) in record.targets.iter().enumerate() {
            let temporary = temporary_path(target);
            remove_if_present(&temporary).map_err(unknown_fault)?;
            if record.target_exists[index] {
                copy_private(&directory.join(TARGET_BACKUPS[index]), &temporary)
                    .map_err(rollback_fault)?;
                crate::persistence::replace_file(&temporary, target).map_err(unknown_fault)?;
                sync_file(target).map_err(unknown_fault)?;
            } else {
                remove_if_present(target).map_err(unknown_fault)?;
            }
            sync_parent(target).map_err(unknown_fault)?;
        }
        if record.reset && record.cascade_exists {
            let target = self.root.join(CASCADE_FILE);
            let temporary = temporary_path(&target);
            remove_if_present(&temporary).map_err(unknown_fault)?;
            copy_private(&directory.join("cascade.original"), &temporary)
                .map_err(rollback_fault)?;
            crate::persistence::replace_file(&temporary, &target).map_err(unknown_fault)?;
            sync_file(&target).map_err(unknown_fault)?;
            sync_parent(&target).map_err(unknown_fault)?;
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecoveryRecord {
    phase: Phase,
    backup: String,
    targets: [PathBuf; 3],
    target_exists: [bool; 3],
    sources: [Option<PathBuf>; 3],
    cascade_exists: bool,
    reset: bool,
}

#[derive(Clone, Copy, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Prepared,
    Committed,
}

pub(super) fn backup_sources(
    store: &ProviderRecoveryStore,
    paths: &[PathBuf; 3],
    selected: &[SelectedSource; 3],
) -> Result<RecoveryRecord, ProviderMigrationFault> {
    let parent = store.root.join("provider-backups");
    provision_private_directory(&parent).map_err(|_| ProviderMigrationFault::Permission)?;
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ProviderMigrationFault::Recovery)?
        .as_nanos();
    let backup = format!(
        "{time}-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    );
    let directory = parent.join(&backup);
    fs::create_dir(&directory).map_err(backup_fault)?;
    set_private_mode(&directory, PrivateMode::Directory)
        .map_err(|_| ProviderMigrationFault::Permission)?;
    let mut record = RecoveryRecord {
        phase: Phase::Prepared,
        backup,
        targets: paths.clone(),
        target_exists: std::array::from_fn(|index| selected[index].target_exists),
        sources: std::array::from_fn(|index| selected[index].path.clone()),
        cascade_exists: false,
        reset: false,
    };
    for index in 0..3 {
        if record.target_exists[index] {
            let destination = directory.join(TARGET_BACKUPS[index]);
            match &selected[index].target_bytes {
                Some(bytes) => write_private(&destination, bytes)?,
                None => copy_private(&paths[index], &destination)?,
            }
        }
        if let Some(source) = &selected[index].path
            && source != &paths[index]
        {
            let destination = directory.join(SOURCE_BACKUPS[index]);
            match &selected[index].selection {
                SourceSelection::Legacy(bytes) => write_private(&destination, bytes)?,
                _ => match &selected[index].source_bytes {
                    Some(bytes) => write_private(&destination, bytes)?,
                    None => copy_private(source, &destination)?,
                },
            }
        }
    }
    let cascade = store.root.join(CASCADE_FILE);
    match fs::symlink_metadata(&cascade) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            copy_private(&cascade, &directory.join("cascade.original"))?;
            record.cascade_exists = true;
        }
        Ok(_) => return Err(ProviderMigrationFault::Recovery),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(backup_fault(error)),
    }
    let bytes = serde_json::to_vec(&record).map_err(|_| ProviderMigrationFault::Encode)?;
    write_private(&directory.join("backup.json"), &bytes)?;
    sync_parent(&directory.join("backup.json")).map_err(backup_fault)?;
    sync_parent(&directory).map_err(backup_fault)?;
    Ok(record)
}

pub(super) fn commit(
    store: &ProviderRecoveryStore,
    mut record: RecoveryRecord,
    paths: &[PathBuf; 3],
    outputs: &[Option<Vec<u8>>; 3],
    reset: bool,
) -> Result<(), ProviderMigrationFault> {
    record.reset = reset;
    let directory = store.backup_directory(&record)?;
    let cascade_bytes = if reset && record.cascade_exists {
        let bytes = read_bounded(&directory.join("cascade.original"))?
            .ok_or(ProviderMigrationFault::Recovery)?;
        crate::adapters::cascade::validate_reset_deletion(&bytes)
            .map_err(|_| ProviderMigrationFault::Recovery)?;
        Some(bytes)
    } else {
        None
    };
    // Prepared is durable before touching targets, including cascade cleanup.
    store.persist(&record)?;
    let outcome = (|| {
        for (target, output) in paths.iter().zip(outputs) {
            if let Some(bytes) = output {
                let parent = target.parent().ok_or(ProviderMigrationFault::Recovery)?;
                fs::create_dir_all(parent).map_err(commit_fault)?;
                let temporary = temporary_path(target);
                remove_if_present(&temporary).map_err(commit_fault)?;
                write_private(&temporary, bytes).map_err(commit_write_fault)?;
            }
        }
        for (target, output) in paths.iter().zip(outputs) {
            if output.is_some() {
                crate::persistence::replace_file(&temporary_path(target), target)
                    .map_err(unknown_fault)?;
                sync_file(target).map_err(unknown_fault)?;
                sync_parent(target).map_err(unknown_fault)?;
            }
        }
        if let Some(original) = &cascade_bytes {
            // Only this commit's three exact empty documents authorize completing the old deletion.
            for (target, output) in paths.iter().zip(outputs) {
                if read_bounded(target)?.as_ref() != output.as_ref() {
                    return Err(ProviderMigrationFault::Recovery);
                }
            }
            let cascade = store.root.join(CASCADE_FILE);
            crate::adapters::cascade::complete_reset_deletion(&cascade, original, paths).map_err(
                |error| match error {
                    crate::ProviderCascadeFault::Journal(kind) => {
                        ProviderMigrationFault::Journal(kind)
                    }
                    crate::ProviderCascadeFault::Unknown => {
                        ProviderMigrationFault::CommitOutcomeUnknown(io::ErrorKind::Other)
                    }
                    _ => ProviderMigrationFault::Recovery,
                },
            )?;
            sync_parent(&cascade).map_err(unknown_fault)?;
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        store.restore(&record)?;
        store.clear_record().map_err(rollback_fault)?;
        return Err(error);
    }
    // The marker replacement is the commit point. A sync failure must not reverse a possibly committed record.
    record.phase = Phase::Committed;
    store.persist(&record).map_err(rollback_fault)?;
    if !reset {
        store.clear_record()?;
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ProviderMigrationFault> {
    let mut file = private_file(path)?;
    file.write_all(bytes).map_err(backup_fault)?;
    file.sync_all().map_err(backup_fault)
}

fn copy_private(source: &Path, destination: &Path) -> Result<(), ProviderMigrationFault> {
    let metadata = fs::symlink_metadata(source).map_err(backup_fault)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ProviderMigrationFault::Recovery);
    }
    let mut source = File::open(source).map_err(backup_fault)?;
    let mut destination = private_file(destination)?;
    io::copy(&mut source, &mut destination).map_err(backup_fault)?;
    destination.sync_all().map_err(backup_fault)
}

fn private_file(path: &Path) -> Result<File, ProviderMigrationFault> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(backup_fault)?;
    set_private_mode(path, PrivateMode::File).map_err(|_| ProviderMigrationFault::Permission)?;
    Ok(file)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn sync_file(path: &Path) -> io::Result<()> {
    OpenOptions::new().write(true).open(path)?.sync_all()
}

fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn read_fault(error: io::Error) -> ProviderMigrationFault {
    ProviderMigrationFault::Read(error.kind())
}
fn backup_fault(error: io::Error) -> ProviderMigrationFault {
    ProviderMigrationFault::Backup(error.kind())
}
fn journal_fault(error: io::Error) -> ProviderMigrationFault {
    ProviderMigrationFault::Journal(error.kind())
}
fn commit_fault(error: io::Error) -> ProviderMigrationFault {
    ProviderMigrationFault::Commit(error.kind())
}
fn unknown_fault(error: io::Error) -> ProviderMigrationFault {
    ProviderMigrationFault::CommitOutcomeUnknown(error.kind())
}
fn record_fault(error: ProviderMigrationFault) -> ProviderMigrationFault {
    match error {
        ProviderMigrationFault::Backup(kind) => ProviderMigrationFault::Journal(kind),
        other => other,
    }
}
fn commit_write_fault(error: ProviderMigrationFault) -> ProviderMigrationFault {
    match error {
        ProviderMigrationFault::Backup(kind) => ProviderMigrationFault::Commit(kind),
        other => other,
    }
}
fn rollback_fault(error: ProviderMigrationFault) -> ProviderMigrationFault {
    match error {
        ProviderMigrationFault::Read(kind)
        | ProviderMigrationFault::Backup(kind)
        | ProviderMigrationFault::Commit(kind)
        | ProviderMigrationFault::Journal(kind) => {
            ProviderMigrationFault::CommitOutcomeUnknown(kind)
        }
        _ => ProviderMigrationFault::CommitOutcomeUnknown(io::ErrorKind::Other),
    }
}
