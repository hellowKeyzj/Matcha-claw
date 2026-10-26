mod orphans;

use std::{
    error::Error as StdError,
    fmt,
    fs::File,
    io::{self, Read, Write},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

#[cfg(windows)]
use foundation::storage::{PrivateMode, set_private_mode};
use platform::state_dir::{CanonicalStateDir, StateDirHandle};
use sha2::{Digest as _, Sha256};
#[cfg(windows)]
use std::fs::{self, OpenOptions};
use tokio_util::sync::CancellationToken;

static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Failure {
    InvalidInput,
    SizeLimit,
    DigestMismatch,
    UnsafeFile,
    Read,
    Write,
    Sync,
    Publish,
    NotFound,
    Cleanup,
    Cancelled,
}

pub(super) struct Error {
    pub(super) reason: Failure,
    pub(super) step: Option<&'static str>,
    cause: Option<Box<dyn StdError + Send + Sync>>,
    cleanup: Option<Box<dyn StdError + Send + Sync>>,
}

impl Error {
    fn new(reason: Failure) -> Self {
        Self {
            reason,
            step: None,
            cause: None,
            cleanup: None,
        }
    }

    fn caused(reason: Failure, cause: impl StdError + Send + Sync + 'static) -> Self {
        Self {
            reason,
            step: None,
            cause: Some(Box::new(cause)),
            cleanup: None,
        }
    }

    fn with_step(mut self, step: &'static str) -> Self {
        self.step = Some(step);
        self
    }

    pub(super) fn cleanup_failed(&self) -> bool {
        self.cleanup.is_some()
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BlobError")
            .field("reason", &self.reason)
            .field("cleanup_failed", &self.cleanup_failed())
            .finish_non_exhaustive()
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "world content {:?}", self.reason)
    }
}

impl StdError for Error {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| cause as &(dyn StdError + 'static))
    }
}

#[derive(Clone, Copy, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FileIdentity {
    volume: u64,
    file: u64,
}

/// Synced private stage; publication happens only under the world's durable blob-row gate.
pub(super) struct Prepared {
    pub(super) digest: [u8; 32],
    pub(super) byte_size: u64,
    temporary_name: String,
    root: CanonicalStateDir,
    identity: FileIdentity,
    existing: Option<FileIdentity>,
    _owner: Arc<File>,
}

pub(super) struct Blobs {
    directory: CanonicalStateDir,
    maximum_bytes: u64,
    owner: Arc<File>,
}

/// Cleanup only: it cannot reconstruct a prepared blob or authorize publication.
#[derive(Clone, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StageCleanup {
    name: String,
    root: FileIdentity,
    file: FileIdentity,
    byte_size: u64,
}

impl Blobs {
    pub(super) fn open(directory: &Path, maximum_bytes: u64) -> Result<Self, Error> {
        if maximum_bytes == 0 || maximum_bytes > usize::MAX as u64 {
            return Err(Error::new(Failure::InvalidInput));
        }
        let directory = CanonicalStateDir::provision_private(directory)
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        let opened = directory
            .open()
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        let owner = Arc::new(
            opened
                .lock_regular_file(".content-owner")
                .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?,
        );
        let _publication = opened
            .lock_regular_file(".content-publication")
            .map_err(|cause| {
                Error::caused(Failure::Publish, cause).with_step("open_publication_lock")
            })?;
        orphans::reconcile(&directory, &opened)?;
        sync_directory(&opened)?;
        #[cfg(unix)]
        if let Some(parent) = directory.as_path().parent() {
            File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|cause| Error::caused(Failure::Sync, cause))?;
        }
        Ok(Self {
            directory,
            maximum_bytes,
            owner,
        })
    }

    pub(super) fn prepare(
        &self,
        reader: &mut impl Read,
        expected_digest: Option<[u8; 32]>,
        cancellation: &CancellationToken,
    ) -> Result<Prepared, Error> {
        self.prepare_inner(reader, expected_digest, cancellation, false)
    }

    pub(super) fn prepare_locked(
        &self,
        reader: &mut impl Read,
        expected_digest: Option<[u8; 32]>,
        cancellation: &CancellationToken,
    ) -> Result<Prepared, Error> {
        self.prepare_inner(reader, expected_digest, cancellation, true)
    }

    fn prepare_inner(
        &self,
        reader: &mut impl Read,
        expected_digest: Option<[u8; 32]>,
        cancellation: &CancellationToken,
        physical_held: bool,
    ) -> Result<Prepared, Error> {
        check_cancelled(cancellation)?;
        let directory = self
            .directory
            .open()
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        let (temporary_name, mut file) = create_temporary(&self.directory, &directory)?;
        let prepared = (|| {
            let mut hasher = Sha256::new();
            let mut byte_size = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                check_cancelled(cancellation)?;
                let length = match reader.read(&mut buffer) {
                    Err(cause) if cause.kind() == io::ErrorKind::Interrupted => continue,
                    result => result.map_err(|cause| Error::caused(Failure::Read, cause))?,
                };
                if length == 0 {
                    break;
                }
                byte_size = byte_size
                    .checked_add(length as u64)
                    .filter(|size| *size <= self.maximum_bytes)
                    .ok_or_else(|| Error::new(Failure::SizeLimit))?;
                file.write_all(&buffer[..length])
                    .map_err(|cause| Error::caused(Failure::Write, cause).with_step("write"))?;
                hasher.update(&buffer[..length]);
            }
            let digest: [u8; 32] = hasher.finalize().into();
            if expected_digest.is_some_and(|expected| expected != digest) {
                return Err(Error::new(Failure::DigestMismatch));
            }
            file.sync_all()
                .map_err(|cause| Error::caused(Failure::Sync, cause))?;
            let identity = file_identity(&file)?;
            check_cancelled(cancellation)?;
            Ok((digest, byte_size, identity))
        })();
        drop(file);
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                return Err(cleanup_error(
                    error,
                    &self.directory,
                    &directory,
                    &temporary_name,
                ));
            }
        };
        let (digest, byte_size, identity) = prepared;
        let staged_name = format!(".stage.{}.{}", digest_name(&digest), uuid::Uuid::new_v4());
        publish(&self.directory, &directory, &temporary_name, &staged_name).map_err(|cause| {
            cleanup_error(
                Error::caused(Failure::Publish, cause).with_step("stage_publish"),
                &self.directory,
                &directory,
                &temporary_name,
            )
        })?;
        if let Err(cause) = remove(&self.directory, &directory, &temporary_name) {
            return Err(cleanup_error(
                Error::caused(Failure::Cleanup, cause),
                &self.directory,
                &directory,
                &staged_name,
            ));
        }
        let mut prepared = Prepared {
            digest,
            byte_size,
            temporary_name: staged_name,
            root: self.directory.clone(),
            identity,
            existing: None,
            _owner: self.owner.clone(),
        };
        if let Err(error) = sync_directory(&directory).and_then(|_| {
            if physical_held {
                self.refresh_locked(&mut prepared)
            } else {
                self.refresh(&mut prepared)
            }
        }) {
            return Err(cleanup_error(
                error,
                &self.directory,
                &directory,
                &prepared.temporary_name,
            ));
        }
        Ok(prepared)
    }

    /// The caller already holds the matching PostgreSQL blob row and checked every deletion barrier.
    pub(super) fn publish_prepared(&self, prepared: &Prepared) -> Result<(), Error> {
        if prepared.root != self.directory {
            return Err(Error::new(Failure::InvalidInput));
        }
        let _physical = self.lock()?;
        self.publish_locked(prepared)
    }

    pub(super) fn publish_locked(&self, prepared: &Prepared) -> Result<(), Error> {
        if prepared.root != self.directory {
            return Err(Error::new(Failure::InvalidInput));
        }
        let directory = self
            .directory
            .open()
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        let target = digest_name(&prepared.digest);
        // No source copy or full hash pass under the SQL transaction. The stage was already synced.
        match publish(
            &self.directory,
            &directory,
            &prepared.temporary_name,
            &target,
        ) {
            Ok(()) => {
                remove(&self.directory, &directory, &prepared.temporary_name)
                    .map_err(|cause| Error::caused(Failure::Cleanup, cause))?;
            }
            Err(cause)
                if matches!(
                    cause.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::NotFound
                ) => {}
            Err(cause) => {
                return Err(Error::caused(Failure::Publish, cause).with_step("blob_publish"));
            }
        }
        let file = open_regular(&self.directory, &directory, &target, true)?;
        let identity = file_identity(&file)?;
        if identity != prepared.identity && Some(identity) != prepared.existing {
            // A concurrent publisher won after prepare. Revalidate outside SQL before retrying.
            return Err(Error::new(Failure::Publish).with_step("publication_identity"));
        }
        if file
            .metadata()
            .map_err(|cause| Error::caused(Failure::Read, cause))?
            .len()
            != prepared.byte_size
        {
            return Err(Error::new(Failure::DigestMismatch));
        }
        file.sync_all()
            .map_err(|cause| Error::caused(Failure::Sync, cause))?;
        drop(file);
        remove(&self.directory, &directory, &prepared.temporary_name)
            .map_err(|cause| Error::caused(Failure::Cleanup, cause))?;
        sync_directory(&directory)
    }

    pub(super) fn stage_cleanup(&self, prepared: &Prepared) -> Result<StageCleanup, Error> {
        if prepared.root != self.directory {
            return Err(Error::new(Failure::InvalidInput));
        }
        let directory = self
            .directory
            .open()
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        Ok(StageCleanup {
            name: prepared.temporary_name.clone(),
            root: directory_identity(&directory)?,
            file: prepared.identity,
            byte_size: prepared.byte_size,
        })
    }

    /// Removes only this private stage, never the shared digest or another publisher's file.
    pub(super) fn discard(&self, prepared: &Prepared) -> Result<(), Error> {
        self.discard_stage(&self.stage_cleanup(prepared)?)
    }

    pub(super) fn is_local_stage(&self, witness: &StageCleanup) -> Result<bool, Error> {
        let directory = self
            .directory
            .open()
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        Ok(directory_identity(&directory)? == witness.root)
    }

    pub(super) fn discard_stage(&self, witness: &StageCleanup) -> Result<(), Error> {
        let mut parts = witness.name.split('.');
        if parts.next() != Some("")
            || parts.next() != Some("stage")
            || !parts.next().is_some_and(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            || !parts
                .next()
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            || parts.next().is_some()
        {
            return Err(Error::new(Failure::InvalidInput));
        }
        let _physical = self.lock()?;
        let directory = self
            .directory
            .open()
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        if directory_identity(&directory)? != witness.root {
            return Err(Error::new(Failure::UnsafeFile));
        }
        match open_regular(&self.directory, &directory, &witness.name, false) {
            Ok(file) => {
                if file_identity(&file)? != witness.file
                    || file
                        .metadata()
                        .map_err(|cause| Error::caused(Failure::Read, cause))?
                        .len()
                        != witness.byte_size
                {
                    return Err(Error::new(Failure::UnsafeFile));
                }
            }
            Err(error) if error.reason == Failure::NotFound => return sync_directory(&directory),
            Err(error) => return Err(error),
        }
        remove(&self.directory, &directory, &witness.name)
            .map_err(|cause| Error::caused(Failure::Cleanup, cause))?;
        sync_directory(&directory)
    }

    pub(super) fn read_locked(&self, digest: &[u8; 32], byte_size: u64) -> Result<Vec<u8>, Error> {
        if byte_size > self.maximum_bytes {
            return Err(Error::new(Failure::SizeLimit));
        }
        let directory = self
            .directory
            .open()
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        let mut file = open_regular(&self.directory, &directory, &digest_name(digest), false)?;
        read_verified(&mut file, digest, byte_size)
    }

    /// Full duplicate validation is outside the caller's SQL transaction.
    pub(super) fn refresh(&self, prepared: &mut Prepared) -> Result<(), Error> {
        if prepared.root != self.directory {
            return Err(Error::new(Failure::InvalidInput));
        }
        let _physical = self.lock()?;
        self.refresh_locked(prepared)
    }

    fn refresh_locked(&self, prepared: &mut Prepared) -> Result<(), Error> {
        let directory = self
            .directory
            .open()
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        let mut file = match open_regular(
            &self.directory,
            &directory,
            &digest_name(&prepared.digest),
            true,
        ) {
            Ok(file) => file,
            Err(error) if error.reason == Failure::NotFound => {
                prepared.existing = None;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        read_verified(&mut file, &prepared.digest, prepared.byte_size)?;
        file.sync_all()
            .map_err(|cause| Error::caused(Failure::Sync, cause))?;
        prepared.existing = Some(file_identity(&file)?);
        sync_directory(&directory)
    }

    pub(super) fn maximum_bytes(&self) -> u64 {
        self.maximum_bytes
    }

    pub(super) fn identity(&self) -> &CanonicalStateDir {
        &self.directory
    }

    pub(super) fn lock(&self) -> Result<File, Error> {
        self.directory
            .open()
            .and_then(|directory| directory.lock_regular_file(".content-publication"))
            .map_err(|cause| Error::caused(Failure::Publish, cause).with_step("publication_lock"))
    }

    /// Caller must hold the S03 durable deletion claim, excluding new references/read pins.
    pub(super) fn remove_locked(&self, digest: &[u8; 32]) -> Result<(), Error> {
        let directory = self
            .directory
            .open()
            .map_err(|cause| Error::caused(Failure::UnsafeFile, cause))?;
        let name = digest_name(digest);
        #[cfg(windows)]
        return self.remove_windows(&directory, &name);
        #[cfg(unix)]
        {
            match open_regular(&self.directory, &directory, &name, false) {
                Ok(file) => drop(file),
                Err(error) if error.reason == Failure::NotFound => {
                    return sync_directory(&directory);
                }
                Err(error) => return Err(error),
            }
            remove(&self.directory, &directory, &name)
                .map_err(|cause| Error::caused(Failure::Cleanup, cause))?;
            sync_directory(&directory)
        }
    }

    #[cfg(windows)]
    fn remove_windows(&self, directory: &StateDirHandle, name: &str) -> Result<(), Error> {
        let tombstone = format!(".deleted.{name}");
        let exists = match open_regular(&self.directory, directory, name, false) {
            Ok(file) => {
                drop(file);
                true
            }
            Err(error) if error.reason == Failure::NotFound => false,
            Err(error) => return Err(error),
        };
        if exists {
            // A previous interrupted cleanup can coexist with a new rejected same-digest upload.
            match open_regular(&self.directory, directory, &tombstone, false) {
                Ok(file) => {
                    drop(file);
                    remove(&self.directory, directory, &tombstone)
                        .map_err(|cause| Error::caused(Failure::Cleanup, cause))?;
                }
                Err(error) if error.reason == Failure::NotFound => {}
                Err(error) => return Err(error),
            }
            publish(&self.directory, directory, name, &tombstone).map_err(|cause| {
                Error::caused(Failure::Publish, cause).with_step("delete_rename")
            })?;
        }
        match open_regular(&self.directory, directory, &tombstone, false) {
            Ok(file) => drop(file),
            Err(error) if error.reason == Failure::NotFound => return Ok(()),
            Err(error) => return Err(error),
        }
        remove(&self.directory, directory, &tombstone)
            .map_err(|cause| Error::caused(Failure::Cleanup, cause))
    }
}

#[cfg(unix)]
fn file_identity(file: &File) -> Result<FileIdentity, Error> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file
        .metadata()
        .map_err(|cause| Error::caused(Failure::Read, cause))?;
    Ok(FileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(unix)]
fn directory_identity(directory: &StateDirHandle) -> Result<FileIdentity, Error> {
    let file = File::from(
        directory
            .clone_descriptor()
            .map_err(|cause| Error::caused(Failure::Read, cause))?,
    );
    file_identity(&file)
}

#[cfg(windows)]
fn directory_identity(directory: &StateDirHandle) -> Result<FileIdentity, Error> {
    handle_identity(directory.raw_handle())
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<FileIdentity, Error> {
    use std::os::windows::io::AsRawHandle;
    handle_identity(file.as_raw_handle())
}

#[cfg(windows)]
fn handle_identity(handle: windows_sys::Win32::Foundation::HANDLE) -> Result<FileIdentity, Error> {
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the caller retains this live handle for the synchronous call.
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(Error::caused(Failure::Read, io::Error::last_os_error()));
    }
    Ok(FileIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file: u64::from(information.nFileIndexHigh) << 32 | u64::from(information.nFileIndexLow),
    })
}

fn read_verified(file: &mut File, digest: &[u8; 32], byte_size: u64) -> Result<Vec<u8>, Error> {
    let metadata = file
        .metadata()
        .map_err(|cause| Error::caused(Failure::Read, cause))?;
    if metadata.len() != byte_size {
        return Err(Error::new(Failure::DigestMismatch));
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(byte_size as usize)
        .map_err(|cause| Error::caused(Failure::SizeLimit, cause))?;
    file.take(byte_size.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|cause| Error::caused(Failure::Read, cause))?;
    if bytes.len() as u64 != byte_size || <[u8; 32]>::from(Sha256::digest(&bytes)) != *digest {
        return Err(Error::new(Failure::DigestMismatch));
    }
    Ok(bytes)
}

fn create_temporary(
    root: &CanonicalStateDir,
    directory: &StateDirHandle,
) -> Result<(String, File), Error> {
    for _ in 0..128 {
        let sequence = NEXT_TEMPORARY.fetch_add(1, Ordering::Relaxed);
        let name = format!(".blob.{}.{sequence}.tmp", std::process::id());
        match create_file(root, directory, &name) {
            Ok(file) => return Ok((name, file)),
            Err(error)
                if error
                    .cause
                    .as_deref()
                    .and_then(|cause| cause.downcast_ref::<io::Error>())
                    .is_some_and(|cause| cause.kind() == io::ErrorKind::AlreadyExists) => {}
            Err(error) => return Err(error),
        }
    }
    Err(Error::new(Failure::Write).with_step("temp_name_exhausted"))
}

fn cleanup_error(
    mut error: Error,
    root: &CanonicalStateDir,
    directory: &StateDirHandle,
    name: &str,
) -> Error {
    error.cleanup = remove(root, directory, name)
        .err()
        .map(|cause| Box::new(cause) as _);
    if error.cleanup.is_none() {
        if let Err(cause) = sync_directory(directory) {
            error.cleanup = Some(Box::new(cause));
        }
    }
    error
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        Err(Error::new(Failure::Cancelled))
    } else {
        Ok(())
    }
}

pub(super) fn digest_name(digest: &[u8; 32]) -> String {
    use fmt::Write as _;
    let mut name = String::with_capacity(64);
    for byte in digest {
        write!(name, "{byte:02x}").expect("writing a digest to String cannot fail");
    }
    name
}

#[cfg(unix)]
fn create_file(
    _root: &CanonicalStateDir,
    directory: &StateDirHandle,
    name: &str,
) -> Result<File, Error> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name)
        .map_err(|cause| Error::caused(Failure::InvalidInput, cause))?;
    let descriptor = directory
        .clone_descriptor()
        .map_err(|cause| Error::caused(Failure::Write, cause).with_step("create_temp"))?;
    // SAFETY: generated single-component name and a live directory descriptor; no links followed.
    let file = unsafe {
        libc::openat(
            descriptor.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if file < 0 {
        Err(Error::caused(Failure::Write, io::Error::last_os_error()).with_step("create_temp"))
    } else {
        Ok(unsafe { File::from_raw_fd(file) })
    }
}

#[cfg(windows)]
fn create_file(
    root: &CanonicalStateDir,
    directory: &StateDirHandle,
    name: &str,
) -> Result<File, Error> {
    let path = root.as_path().join(name);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|cause| Error::caused(Failure::Write, cause).with_step("create_temp"))?;
    if let Err(cause) = set_private_mode(&path, PrivateMode::File) {
        drop(file);
        return Err(cleanup_error(
            Error::caused(Failure::Write, cause).with_step("private_mode"),
            root,
            directory,
            name,
        ));
    }
    Ok(file)
}

fn open_regular(
    root: &CanonicalStateDir,
    directory: &StateDirHandle,
    name: &str,
    writable: bool,
) -> Result<File, Error> {
    #[cfg(unix)]
    let opened = {
        use std::os::fd::{AsRawFd, FromRawFd};
        let _ = root;
        let descriptor = directory
            .clone_descriptor()
            .map_err(|cause| Error::caused(Failure::Read, cause))?;
        let name = std::ffi::CString::new(name)
            .map_err(|cause| Error::caused(Failure::InvalidInput, cause))?;
        let flags = if writable {
            libc::O_RDWR
        } else {
            libc::O_RDONLY
        };
        // SAFETY: a generated leaf name is opened relative to the verified private directory.
        let file = unsafe {
            libc::openat(
                descriptor.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if file < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(file) })
        }
    };
    #[cfg(windows)]
    let opened = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let _ = directory;
        OpenOptions::new()
            .read(true)
            .write(writable)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(root.as_path().join(name))
    };
    let file = opened.map_err(|cause| {
        Error::caused(
            if cause.kind() == io::ErrorKind::NotFound {
                Failure::NotFound
            } else {
                Failure::Read
            },
            cause,
        )
    })?;
    let metadata = file
        .metadata()
        .map_err(|cause| Error::caused(Failure::Read, cause))?;
    #[cfg(unix)]
    let redirected = {
        use std::os::unix::fs::MetadataExt;
        metadata.nlink() != 1
    };
    #[cfg(windows)]
    let redirected = {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: file owns this live handle and information is writable for the synchronous call.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err(Error::caused(Failure::Read, io::Error::last_os_error()));
        }
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || information.nNumberOfLinks != 1
    };
    if redirected || !metadata.is_file() {
        return Err(Error::new(Failure::UnsafeFile));
    }
    Ok(file)
}

#[cfg(windows)]
fn publish(
    root: &CanonicalStateDir,
    _directory: &StateDirHandle,
    temporary: &str,
    target: &str,
) -> io::Result<()> {
    platform::state_dir::publish_new_file(
        &root.as_path().join(temporary),
        &root.as_path().join(target),
    )
}

#[cfg(unix)]
fn publish(
    _root: &CanonicalStateDir,
    directory: &StateDirHandle,
    temporary: &str,
    target: &str,
) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let descriptor = directory.clone_descriptor().map_err(io::Error::other)?;
    let temporary = std::ffi::CString::new(temporary)?;
    let target = std::ffi::CString::new(target)?;
    // Atomic no-replace rename leaves no crash window containing a second hard link.
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            descriptor.as_raw_fd(),
            temporary.as_ptr(),
            descriptor.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            descriptor.as_raw_fd(),
            temporary.as_ptr(),
            descriptor.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn remove(_root: &CanonicalStateDir, directory: &StateDirHandle, name: &str) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let descriptor = directory.clone_descriptor().map_err(io::Error::other)?;
    let name = std::ffi::CString::new(name)?;
    // SAFETY: generated relative leaf name, unlink never follows a symbolic link.
    if unsafe { libc::unlinkat(descriptor.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    let cause = io::Error::last_os_error();
    if cause.kind() == io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(cause)
    }
}

#[cfg(windows)]
fn remove(root: &CanonicalStateDir, _directory: &StateDirHandle, name: &str) -> io::Result<()> {
    match fs::remove_file(root.as_path().join(name)) {
        Err(cause) if cause.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

#[cfg(unix)]
fn sync_directory(directory: &StateDirHandle) -> Result<(), Error> {
    use std::os::fd::AsRawFd;
    let descriptor = directory
        .clone_descriptor()
        .map_err(|cause| Error::caused(Failure::Sync, cause))?;
    // SAFETY: descriptor owns the open private directory for this call.
    if unsafe { libc::fsync(descriptor.as_raw_fd()) } == 0 {
        Ok(())
    } else {
        Err(Error::caused(Failure::Sync, io::Error::last_os_error()))
    }
}

#[cfg(windows)]
fn sync_directory(_directory: &StateDirHandle) -> Result<(), Error> {
    // Publication uses MOVEFILE_WRITE_THROUGH after file.sync_all(), not directory fsync.
    // A private orphan deletion may reappear after a crash; the next exclusive startup rescans it.
    Ok(())
}
