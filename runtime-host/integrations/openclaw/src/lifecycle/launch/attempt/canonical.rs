use std::{
    ffi::CString,
    io,
    mem::MaybeUninit,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
};

use crate::lifecycle::state_dir::StateDirHandle;

const CANONICAL_CONFIG_FILE: &[u8] = b"openclaw.json\0";
const EMPTY_DOCUMENT: &[u8] = b"{}\n";
const FILE_MODE: libc::mode_t = 0o600;
const TEMPORARY_MODE: libc::mode_t = 0o600;

pub(super) fn ensure(state_dir: &StateDirHandle) -> Result<(), ()> {
    let directory = state_dir.clone_descriptor().map_err(|_| ())?;
    let canonical = CString::from_vec_with_nul(CANONICAL_CONFIG_FILE.to_vec()).map_err(|_| ())?;
    let temporary = create_temporary_file(&directory)?;
    if let Err(error) = write_and_sync(&temporary) {
        let _ = unlink(&directory, &temporary.name);
        return Err(error);
    }
    let published = unsafe {
        libc::linkat(
            directory.as_raw_fd(),
            temporary.name.as_ptr(),
            directory.as_raw_fd(),
            canonical.as_ptr(),
            0,
        )
    } == 0;
    let result = if published {
        if unsafe { libc::fsync(directory.as_raw_fd()) } == 0 {
            Ok(())
        } else {
            Err(())
        }
    } else if io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST)
        && is_regular_file(&directory, &canonical)
    {
        Ok(())
    } else {
        Err(())
    };
    unlink(&directory, &temporary.name)?;
    result
}

struct TemporaryFile {
    file: OwnedFd,
    name: CString,
}

fn create_temporary_file(directory: &OwnedFd) -> Result<TemporaryFile, ()> {
    for sequence in 0..128 {
        let name = CString::new(format!(".openclaw.json.initialize-{sequence}"))
            .expect("fixed temporary canonical config name must not contain NUL");
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                TEMPORARY_MODE,
            )
        };
        if descriptor >= 0 {
            return Ok(TemporaryFile {
                // SAFETY: openat returned a new owned descriptor.
                file: unsafe { OwnedFd::from_raw_fd(descriptor) },
                name,
            });
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(());
        }
    }
    Err(())
}

fn write_and_sync(temporary: &TemporaryFile) -> Result<(), ()> {
    let mut remaining = EMPTY_DOCUMENT;
    while !remaining.is_empty() {
        let written = unsafe {
            libc::write(
                temporary.file.as_raw_fd(),
                remaining.as_ptr().cast(),
                remaining.len(),
            )
        };
        if written <= 0 {
            return Err(());
        }
        remaining = &remaining[written as usize..];
    }
    if unsafe { libc::fchmod(temporary.file.as_raw_fd(), FILE_MODE) } == 0
        && unsafe { libc::fsync(temporary.file.as_raw_fd()) } == 0
    {
        Ok(())
    } else {
        Err(())
    }
}

fn is_regular_file(directory: &OwnedFd, name: &CString) -> bool {
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return false;
    }
    // SAFETY: openat returned a new owned descriptor.
    let file = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let mut metadata = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), metadata.as_mut_ptr()) } != 0 {
        return false;
    }
    // SAFETY: fstat initialized metadata after reporting success.
    unsafe { metadata.assume_init() }.st_mode & libc::S_IFMT == libc::S_IFREG
}

fn unlink(directory: &OwnedFd, name: &CString) -> Result<(), ()> {
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == 0
        || io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
    {
        Ok(())
    } else {
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::{
            Arc, Barrier,
            atomic::{AtomicU64, Ordering},
        },
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::lifecycle::state_dir::CanonicalStateDir;

    use super::*;

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot {
        cleanup_root: PathBuf,
        state_dir: CanonicalStateDir,
    }

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let cleanup_root = std::env::temp_dir().join(format!(
                "openclaw-canonical-initialization-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&cleanup_root).unwrap();
            let state_dir = CanonicalStateDir::provision(cleanup_root.join("openclaw")).unwrap();
            Self {
                cleanup_root,
                state_dir,
            }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.cleanup_root);
        }
    }

    #[test]
    fn initializes_a_missing_empty_canonical_document_once() {
        let root = TestRoot::new();
        let state_dir = root.state_dir.open().unwrap();

        ensure(&state_dir).unwrap();
        ensure(&state_dir).unwrap();

        let canonical = root.state_dir.as_path().join("openclaw.json");
        assert_eq!(fs::read(&canonical).unwrap(), EMPTY_DOCUMENT);
        assert_eq!(fs::read_dir(root.state_dir.as_path()).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_initialization_publishes_one_document_without_temporary_files() {
        let root = TestRoot::new();
        let barrier = Arc::new(Barrier::new(3));
        thread::scope(|scope| {
            for _ in 0..2 {
                let barrier = Arc::clone(&barrier);
                let state_dir = root.state_dir.clone();
                scope.spawn(move || {
                    let state_dir = state_dir.open().unwrap();
                    barrier.wait();
                    ensure(&state_dir).unwrap();
                });
            }
            barrier.wait();
        });

        let canonical = root.state_dir.as_path().join("openclaw.json");
        assert_eq!(fs::read(&canonical).unwrap(), EMPTY_DOCUMENT);
        assert_eq!(fs::read_dir(root.state_dir.as_path()).unwrap().count(), 1);
    }

    #[test]
    fn preserves_existing_canonical_document_bytes() {
        let root = TestRoot::new();
        let canonical = root.state_dir.as_path().join("openclaw.json");
        let contents = b"{\"channels\":{\"feishu\":{\"appId\":\"app-id\"}}}";
        fs::write(&canonical, contents).unwrap();

        ensure(&root.state_dir.open().unwrap()).unwrap();

        assert_eq!(fs::read(&canonical).unwrap(), contents);
        assert_eq!(fs::read_dir(root.state_dir.as_path()).unwrap().count(), 1);
    }

    #[test]
    fn rejects_an_existing_non_regular_canonical_entry() {
        let root = TestRoot::new();
        fs::create_dir(root.state_dir.as_path().join("openclaw.json")).unwrap();

        assert_eq!(ensure(&root.state_dir.open().unwrap()), Err(()));
        assert_eq!(fs::read_dir(root.state_dir.as_path()).unwrap().count(), 1);
    }
}
