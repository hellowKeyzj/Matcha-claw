use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use sha2::{Digest, Sha256};

use super::StoreFault;
use crate::{GraphRunId, TeamId};

static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
pub(crate) enum ContentScope<'a> {
    Team(&'a TeamId),
    Run {
        team: &'a TeamId,
        run: &'a GraphRunId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ContentRef {
    pub(crate) sha256: [u8; 32],
    pub(crate) byte_len: u64,
}

pub(crate) struct ContentStore {
    root: PathBuf,
}

impl ContentStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    // The caller holds the Organization writer boundary through the DB reference commit.
    pub(crate) fn put(
        &self,
        scope: ContentScope<'_>,
        bytes: &[u8],
    ) -> Result<ContentRef, StoreFault> {
        let reference = ContentRef {
            sha256: Sha256::digest(bytes).into(),
            byte_len: bytes.len() as u64,
        };
        let directory = self.directory(scope, true).map_err(commit_fault)?;
        let target = directory.join(hex_digest(&reference.sha256));
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                if self.read(scope, &reference)? != bytes {
                    return Err(StoreFault::InvalidFacts);
                }
                OpenOptions::new()
                    .write(true)
                    .open(&target)
                    .and_then(|file| file.sync_all())
                    .map_err(commit_fault)?;
                sync_directory(&directory).map_err(commit_fault)?;
                return Ok(reference);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(commit_fault(error)),
        }
        let (temporary, mut file) = temporary_file(&directory).map_err(commit_fault)?;
        let written = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        let published = written.and_then(|()| publish(&temporary, &target));
        let _ = fs::remove_file(&temporary);
        match published {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if self.read(scope, &reference)? != bytes {
                    return Err(StoreFault::InvalidFacts);
                }
            }
            Err(error) => return Err(commit_fault(error)),
        }
        sync_directory(&directory).map_err(commit_fault)?;
        Ok(reference)
    }

    pub(crate) fn read(
        &self,
        scope: ContentScope<'_>,
        reference: &ContentRef,
    ) -> Result<Vec<u8>, StoreFault> {
        let directory = self.directory(scope, false).map_err(read_fault)?;
        let path = directory.join(hex_digest(&reference.sha256));
        let metadata = fs::symlink_metadata(&path).map_err(read_fault)?;
        if is_redirect(&metadata) || !metadata.is_file() || metadata.len() != reference.byte_len {
            return Err(StoreFault::InvalidFacts);
        }
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(read_fault)?
            .take(reference.byte_len.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(read_fault)?;
        if bytes.len() as u64 != reference.byte_len
            || <[u8; 32]>::from(Sha256::digest(&bytes)) != reference.sha256
        {
            return Err(StoreFault::InvalidFacts);
        }
        Ok(bytes)
    }

    fn directory(&self, scope: ContentScope<'_>, create: bool) -> io::Result<PathBuf> {
        // Host supplies a private root; identities never become path components.
        check_directory(&self.root, create)?;
        let mut directory = fs::canonicalize(&self.root)?;
        let (team, run) = match scope {
            ContentScope::Team(team) => (team, None),
            ContentScope::Run { team, run } => (team, Some(run)),
        };
        let team_hash = hex_digest(&Sha256::digest(team.as_str().as_bytes()).into());
        for component in ["teams", team_hash.as_str()] {
            directory.push(component);
            check_directory(&directory, create)?;
        }
        if let Some(run) = run {
            let run_hash = hex_digest(&Sha256::digest(run.as_str().as_bytes()).into());
            for component in ["runs", run_hash.as_str()] {
                directory.push(component);
                check_directory(&directory, create)?;
            }
        }
        directory.push("contents");
        check_directory(&directory, create)?;
        Ok(directory)
    }
}

fn check_directory(path: &Path, create: bool) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
            match fs::create_dir(path) {
                Ok(()) => {
                    if let Some(parent) = path.parent() {
                        sync_directory(parent)?;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            fs::symlink_metadata(path)?
        }
        Err(error) => return Err(error),
    };
    if is_redirect(&metadata) || !metadata.is_dir() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(())
}

fn is_redirect(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn temporary_file(directory: &Path) -> io::Result<(PathBuf, File)> {
    loop {
        let sequence = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(".{}.{sequence}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

#[cfg(windows)]
fn publish(temporary: &Path, target: &Path) -> io::Result<()> {
    platform::state_dir::publish_new_file(temporary, target)
}

#[cfg(not(windows))]
fn publish(temporary: &Path, target: &Path) -> io::Result<()> {
    fs::hard_link(temporary, target)
}

#[cfg(not(windows))]
fn sync_directory(directory: &Path) -> io::Result<()> {
    File::open(directory)?.sync_all()
}

#[cfg(windows)]
fn sync_directory(_directory: &Path) -> io::Result<()> {
    // File sync plus WRITE_THROUGH publication; std has no Windows directory fsync.
    Ok(())
}

fn hex_digest(digest: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(64);
    for byte in digest {
        write!(hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    hex
}

fn read_fault(error: io::Error) -> StoreFault {
    StoreFault::Read(error.kind())
}

fn commit_fault(error: io::Error) -> StoreFault {
    StoreFault::Commit(error.kind())
}
