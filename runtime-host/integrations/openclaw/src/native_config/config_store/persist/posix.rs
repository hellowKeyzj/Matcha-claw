use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{self, Read},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    sync::atomic::{AtomicU64, Ordering},
};

use platform::state_dir::StateDirHandle;

use super::PersistError;

const CANONICAL_CONFIG_FILE: &[u8] = b"openclaw.json\0";
const TEMPORARY_MODE: libc::mode_t = 0o600;
const WRITER_LOCK_FILE: &std::ffi::CStr = c"openclaw.json.lock";
const WRITER_RECLAIM_DIRECTORY: &std::ffi::CStr = c"openclaw.json.lock.reclaim";

pub(crate) struct WriterLock {
    directory: OwnedFd,
    file: Option<OwnedFd>,
    payload: Vec<u8>,
}

impl WriterLock {
    pub(crate) fn acquire(
        state_dir: &StateDirHandle,
        payload: &[u8],
    ) -> Result<Self, PersistError> {
        let directory = state_dir
            .clone_descriptor()
            .map_err(|_| PersistError::TemporaryCreateFailed)?;
        let file = acquire_lock_file(&directory, payload)?;
        Ok(Self {
            directory,
            file: Some(file),
            payload: payload.to_vec(),
        })
    }

    pub(crate) fn release(&mut self) -> Result<(), PersistError> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        remove_owned_lock(&self.directory, file, Some(&self.payload))?;
        self.file.take();
        Ok(())
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

fn acquire_lock_file(directory: &OwnedFd, payload: &[u8]) -> Result<OwnedFd, PersistError> {
    reject_reclaim(directory)?;
    match create_lock_file(directory) {
        Ok(file) => initialize_lock(directory, file, payload, true),
        Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
            let snapshot = LockSnapshot::read(directory)?;
            if !super::writer::owner_is_dead(&snapshot.bytes) {
                return Err(PersistError::TemporaryCreateFailed);
            }
            let mut guard = ReclaimGuard::acquire(directory)?;
            let result = (|| {
                snapshot.verify(directory)?;
                if !super::writer::owner_is_dead(&snapshot.bytes) {
                    return Err(PersistError::TemporaryCreateFailed);
                }
                snapshot.verify(directory)?;
                if unsafe { libc::unlinkat(directory.as_raw_fd(), WRITER_LOCK_FILE.as_ptr(), 0) }
                    != 0
                {
                    return Err(PersistError::TemporaryCreateFailed);
                }
                let file =
                    create_lock_file(directory).map_err(|_| PersistError::TemporaryCreateFailed)?;
                // Keep the native reclaim guard until the replacement sidecar is established.
                initialize_lock(directory, file, payload, false)
            })();
            if let Err(cleanup) = guard.release() {
                super::writer::report_cleanup_failure();
                return match result {
                    Ok(file) => {
                        if remove_owned_lock(directory, &file, Some(payload)).is_err() {
                            super::writer::report_cleanup_failure();
                        }
                        Err(cleanup)
                    }
                    Err(error) => Err(error),
                };
            }
            result
        }
        Err(_) => Err(PersistError::TemporaryCreateFailed),
    }
}

fn create_lock_file(directory: &OwnedFd) -> io::Result<OwnedFd> {
    // SAFETY: the verified parent anchors the name; O_EXCL never opens an existing sidecar.
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            WRITER_LOCK_FILE.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            TEMPORARY_MODE as libc::c_uint,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

fn initialize_lock(
    directory: &OwnedFd,
    file: OwnedFd,
    payload: &[u8],
    check_reclaim: bool,
) -> Result<OwnedFd, PersistError> {
    let written = write_all(&file, payload);
    let expected = written.is_ok().then_some(payload);
    let result = written.and_then(|()| {
        verify_owned_lock(directory, &file, Some(payload))
            .map_err(|_| PersistError::TemporaryCreateFailed)?;
        if check_reclaim {
            reject_reclaim(directory)?;
        }
        Ok(())
    });
    if let Err(error) = result {
        if remove_owned_lock(directory, &file, expected).is_err() {
            super::writer::report_cleanup_failure();
        }
        return Err(error);
    }
    Ok(file)
}

struct LockSnapshot {
    file: File,
    bytes: Vec<u8>,
}

impl LockSnapshot {
    fn read(directory: &OwnedFd) -> Result<Self, PersistError> {
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                WRITER_LOCK_FILE.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(PersistError::TemporaryCreateFailed);
        }
        // SAFETY: openat returned a new owned regular-file candidate.
        let mut file = unsafe { File::from_raw_fd(descriptor) };
        verify_path(directory, WRITER_LOCK_FILE, &file, libc::S_IFREG)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(super::writer::MAX_LOCK_PAYLOAD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| PersistError::TemporaryCreateFailed)?;
        if bytes.len() as u64 > super::writer::MAX_LOCK_PAYLOAD_BYTES {
            return Err(PersistError::TemporaryCreateFailed);
        }
        verify_path(directory, WRITER_LOCK_FILE, &file, libc::S_IFREG)?;
        Ok(Self { file, bytes })
    }

    fn verify(&self, directory: &OwnedFd) -> Result<(), PersistError> {
        let current = Self::read(directory)?;
        let held = descriptor_stat(&self.file)?;
        let observed = descriptor_stat(&current.file)?;
        if held.st_dev != observed.st_dev
            || held.st_ino != observed.st_ino
            || self.bytes != current.bytes
        {
            return Err(PersistError::TemporaryCreateFailed);
        }
        Ok(())
    }
}

fn descriptor_stat(file: &impl AsRawFd) -> Result<libc::stat, PersistError> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), metadata.as_mut_ptr()) } != 0 {
        return Err(PersistError::TemporaryCreateFailed);
    }
    // SAFETY: fstat initialized metadata.
    Ok(unsafe { metadata.assume_init() })
}

fn verify_path(
    directory: &OwnedFd,
    name: &CStr,
    file: &impl AsRawFd,
    kind: libc::mode_t,
) -> Result<(), PersistError> {
    let held = descriptor_stat(file)?;
    let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            current.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(PersistError::TemporaryCreateFailed);
    }
    // SAFETY: fstatat initialized current without following a symlink.
    let current = unsafe { current.assume_init() };
    if held.st_mode & libc::S_IFMT != kind
        || current.st_mode & libc::S_IFMT != kind
        || held.st_dev != current.st_dev
        || held.st_ino != current.st_ino
        || held.st_nlink == 0
    {
        return Err(PersistError::TemporaryCreateFailed);
    }
    Ok(())
}

fn verify_owned_lock(
    directory: &OwnedFd,
    file: &OwnedFd,
    payload: Option<&[u8]>,
) -> Result<(), PersistError> {
    verify_path(directory, WRITER_LOCK_FILE, file, libc::S_IFREG)
        .map_err(|_| PersistError::CleanupFailed)?;
    if let Some(payload) = payload {
        // Read the exclusive creator's descriptor, even when umask removed pathname read access.
        let mut bytes = vec![0_u8; payload.len() + 1];
        let mut read = 0;
        while read < bytes.len() {
            let count = unsafe {
                libc::pread(
                    file.as_raw_fd(),
                    bytes[read..].as_mut_ptr().cast(),
                    bytes.len() - read,
                    read as libc::off_t,
                )
            };
            if count < 0 {
                if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(PersistError::CleanupFailed);
            }
            if count == 0 {
                break;
            }
            read += count as usize;
        }
        if &bytes[..read] != payload {
            return Err(PersistError::CleanupFailed);
        }
    }
    verify_path(directory, WRITER_LOCK_FILE, file, libc::S_IFREG)
        .map_err(|_| PersistError::CleanupFailed)
}

fn remove_owned_lock(
    directory: &OwnedFd,
    file: &OwnedFd,
    payload: Option<&[u8]>,
) -> Result<(), PersistError> {
    verify_owned_lock(directory, file, payload)?;
    if unsafe { libc::unlinkat(directory.as_raw_fd(), WRITER_LOCK_FILE.as_ptr(), 0) } != 0 {
        return Err(PersistError::CleanupFailed);
    }
    Ok(())
}

struct ReclaimGuard<'a> {
    directory: &'a OwnedFd,
    identity: Option<(libc::dev_t, libc::ino_t)>,
}

impl<'a> ReclaimGuard<'a> {
    fn acquire(directory: &'a OwnedFd) -> Result<Self, PersistError> {
        if unsafe {
            libc::mkdirat(
                directory.as_raw_fd(),
                WRITER_RECLAIM_DIRECTORY.as_ptr(),
                0o700,
            )
        } != 0
        {
            return Err(PersistError::TemporaryCreateFailed);
        }
        // Native ownership comes from exclusive mkdir, not directory read permission.
        let identity = Self::current_identity(directory).map_err(|error| {
            super::writer::report_cleanup_failure();
            error
        })?;
        Ok(Self {
            directory,
            identity: Some(identity),
        })
    }

    fn current_identity(directory: &OwnedFd) -> Result<(libc::dev_t, libc::ino_t), PersistError> {
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                WRITER_RECLAIM_DIRECTORY.as_ptr(),
                metadata.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(PersistError::TemporaryCreateFailed);
        }
        // SAFETY: fstatat initialized metadata without following a symlink.
        let metadata = unsafe { metadata.assume_init() };
        if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err(PersistError::TemporaryCreateFailed);
        }
        Ok((metadata.st_dev, metadata.st_ino))
    }

    fn release(&mut self) -> Result<(), PersistError> {
        let Some(identity) = self.identity else {
            return Ok(());
        };
        if Self::current_identity(self.directory).map_err(|_| PersistError::CleanupFailed)?
            != identity
        {
            return Err(PersistError::CleanupFailed);
        }
        if unsafe {
            libc::unlinkat(
                self.directory.as_raw_fd(),
                WRITER_RECLAIM_DIRECTORY.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } != 0
        {
            return Err(PersistError::CleanupFailed);
        }
        self.identity.take();
        Ok(())
    }
}

impl Drop for ReclaimGuard<'_> {
    fn drop(&mut self) {
        if self.release().is_err() {
            super::writer::report_cleanup_failure();
        }
    }
}

fn reject_reclaim(directory: &OwnedFd) -> Result<(), PersistError> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: the directory is verified and metadata is a writable stat buffer.
    if unsafe {
        libc::fstatat(directory.as_raw_fd(), WRITER_RECLAIM_DIRECTORY.as_ptr(), metadata.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
    } != 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        Ok(())
    } else {
        Err(PersistError::TemporaryCreateFailed)
    }
}

static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);

pub(super) fn replace(state_dir: &StateDirHandle, contents: &[u8]) -> Result<(), PersistError> {
    let directory = state_dir
        .clone_descriptor()
        .map_err(|_| PersistError::TemporaryCreateFailed)?;
    let (mut temporary, name) = create_temporary_file(&directory)?;
    let result = write_and_replace(&directory, &temporary, &name, contents);
    match result {
        Ok(()) => Ok(()),
        Err(error) => match remove_temporary(&directory, &name) {
            Ok(()) => Err(error),
            Err(()) => Err(PersistError::CleanupFailed),
        },
    }
}

fn create_temporary_file(directory: &OwnedFd) -> Result<(OwnedFd, CString), PersistError> {
    for _ in 0..128 {
        let name = temporary_name()?;
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                TEMPORARY_MODE as libc::c_uint,
            )
        };
        if descriptor >= 0 {
            // SAFETY: openat returned a new owned descriptor.
            return Ok((unsafe { OwnedFd::from_raw_fd(descriptor) }, name));
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(PersistError::TemporaryCreateFailed);
        }
    }
    Err(PersistError::TemporaryCreateFailed)
}

fn temporary_name() -> Result<CString, PersistError> {
    let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
    CString::new(format!(
        ".openclaw.json.{:x}.{sequence:x}.tmp",
        std::process::id()
    ))
    .map_err(|_| PersistError::TemporaryCreateFailed)
}

fn write_and_replace(
    directory: &OwnedFd,
    temporary: &OwnedFd,
    temporary_name: &CString,
    contents: &[u8],
) -> Result<(), PersistError> {
    write_all(temporary, contents)?;
    if unsafe { libc::fsync(temporary.as_raw_fd()) } != 0 {
        return Err(PersistError::TemporarySyncFailed);
    }
    let canonical = CString::from_vec_with_nul(CANONICAL_CONFIG_FILE.to_vec())
        .expect("OpenClaw canonical config name is valid");
    if unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            temporary_name.as_ptr(),
            directory.as_raw_fd(),
            canonical.as_ptr(),
        )
    } != 0
    {
        return Err(PersistError::ReplaceFailed);
    }
    if unsafe { libc::fsync(directory.as_raw_fd()) } != 0 {
        return Err(PersistError::CommittedButNotDurable);
    }
    Ok(())
}

fn write_all(file: &OwnedFd, contents: &[u8]) -> Result<(), PersistError> {
    let mut remaining = contents;
    while !remaining.is_empty() {
        let written =
            unsafe { libc::write(file.as_raw_fd(), remaining.as_ptr().cast(), remaining.len()) };
        if written <= 0 {
            return Err(PersistError::TemporaryWriteFailed);
        }
        remaining = &remaining[written as usize..];
    }
    Ok(())
}

fn remove_temporary(directory: &OwnedFd, name: &CString) -> Result<(), ()> {
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(libc::ENOENT) => Ok(()),
        _ => Err(()),
    }
}
