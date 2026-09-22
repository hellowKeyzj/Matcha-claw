//! Output root ownership and atomic publication for the diagnostics archive.
//!
//! Publication and reads operate relative to a verified output-directory handle, so a later
//! symlink/reparse swap of the path cannot redirect archive writes or downloads.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use super::{ARCHIVE_BYTE_LIMIT, DiagnosticsArchiveError};

const OUTPUT_DIRECTORY: &str = "host-diagnostics";
const ARCHIVE_PREFIX: &str = "host-diagnostics-";
const ARCHIVE_SUFFIX: &str = ".zip";
const STAGING_PREFIX: &str = ".host-diagnostics-";
const STAGING_SUFFIX: &str = ".tmp";

#[derive(Clone)]
pub struct DiagnosticsArchiveRoot {
    state_root: PathBuf,
    output_root: PathBuf,
    output_identity: FileIdentity,
    app_log_dir: PathBuf,
}

impl DiagnosticsArchiveRoot {
    pub fn provision(
        state_root: impl AsRef<Path>,
        app_log_dir: impl Into<PathBuf>,
    ) -> Result<Self, DiagnosticsArchiveError> {
        let state_root = canonical_directory(state_root.as_ref())?;
        let output_root = state_root.join(OUTPUT_DIRECTORY);
        match fs::create_dir(&output_root) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(DiagnosticsArchiveError::InvalidRoot),
        }
        let output_root = canonical_directory(&output_root)?;
        let output_identity = FileIdentity::from_path(&output_root)?;
        Ok(Self {
            output_root,
            output_identity,
            state_root,
            app_log_dir: app_log_dir.into(),
        })
    }

    pub(super) fn state_root(&self) -> &Path {
        &self.state_root
    }

    /// Resolved per collection rather than at provision time: the desktop shell creates its log
    /// directory on first write, so a fresh profile legitimately has none yet, and a directory
    /// replaced by a symlink afterwards must be rejected instead of followed.
    pub(super) fn app_log_root(&self) -> Option<PathBuf> {
        canonical_directory(&self.app_log_dir).ok()
    }

    /// Only the archive's own directories gate availability. A missing desktop log directory
    /// degrades to a bundle without app log entries, never to a failed archive.
    pub(super) fn is_available(&self) -> bool {
        is_regular_directory(&self.state_root) && self.open_output_directory().is_ok()
    }

    pub(super) fn publish(
        &self,
        archive_id: &str,
        image: &[u8],
    ) -> Result<(), DiagnosticsArchiveError> {
        let staged = archive_name(STAGING_PREFIX, archive_id, STAGING_SUFFIX)?;
        let published = archive_name(ARCHIVE_PREFIX, archive_id, ARCHIVE_SUFFIX)?;
        self.open_output_directory()?
            .publish(&staged, &published, image)
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)
    }

    pub(super) fn discard(&self, archive_id: &str) -> Result<(), DiagnosticsArchiveError> {
        let published = archive_name(ARCHIVE_PREFIX, archive_id, ARCHIVE_SUFFIX)?;
        self.open_output_directory()?
            .remove(&published)
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)
    }

    pub(super) fn read(&self, archive_id: &str) -> Result<Vec<u8>, DiagnosticsArchiveError> {
        if !is_archive_id(archive_id) {
            return Err(DiagnosticsArchiveError::ArchiveNotFound);
        }
        let path = archive_name(ARCHIVE_PREFIX, archive_id, ARCHIVE_SUFFIX)?;
        let file = self.open_output_directory()?.open_archive(&path)?;
        let metadata = file
            .metadata()
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        if !metadata.is_file() || metadata.len() > ARCHIVE_BYTE_LIMIT {
            return Err(DiagnosticsArchiveError::OutputUnavailable);
        }
        let mut image = Vec::with_capacity(metadata.len() as usize);
        file.take(ARCHIVE_BYTE_LIMIT + 1)
            .read_to_end(&mut image)
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        (image.len() as u64 <= ARCHIVE_BYTE_LIMIT)
            .then_some(image)
            .ok_or(DiagnosticsArchiveError::OutputUnavailable)
    }

    #[cfg(test)]
    pub(super) fn output_root(&self) -> &Path {
        &self.output_root
    }

    fn open_output_directory(&self) -> Result<OutputDirectory, DiagnosticsArchiveError> {
        OutputDirectory::open(&self.output_root, self.output_identity)
    }
}

fn archive_name(
    prefix: &str,
    archive_id: &str,
    suffix: &str,
) -> Result<String, DiagnosticsArchiveError> {
    is_archive_id(archive_id)
        .then(|| format!("{prefix}{archive_id}{suffix}"))
        .ok_or(DiagnosticsArchiveError::OutputUnavailable)
}

#[cfg(unix)]
struct OutputDirectory {
    directory: File,
}

#[cfg(unix)]
impl OutputDirectory {
    fn open(path: &Path, identity: FileIdentity) -> Result<Self, DiagnosticsArchiveError> {
        use std::os::unix::fs::OpenOptionsExt;

        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        let metadata = directory
            .metadata()
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        if !metadata.is_dir() || !identity.matches(&metadata) {
            return Err(DiagnosticsArchiveError::OutputUnavailable);
        }
        Ok(Self { directory })
    }

    fn publish(&self, staged_name: &str, published_name: &str, image: &[u8]) -> io::Result<()> {
        use std::{ffi::CString, os::fd::AsRawFd};

        let staged = CString::new(staged_name)?;
        let published = CString::new(published_name)?;
        let directory = self.directory.as_raw_fd();
        let result = (|| {
            let mut file = open_at(
                directory,
                &staged,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )?;
            file.write_all(image)?;
            file.sync_all()?;
            drop(file);
            link_at(directory, &staged, directory, &published)?;
            unlink_at(directory, &staged)
        })();
        if result.is_err() {
            let _ = unlink_at(directory, &staged);
        }
        result
    }

    fn remove(&self, name: &str) -> io::Result<()> {
        use std::{ffi::CString, os::fd::AsRawFd};

        let name = CString::new(name)?;
        match unlink_at(self.directory.as_raw_fd(), &name) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }

    fn open_archive(&self, name: &str) -> Result<File, DiagnosticsArchiveError> {
        use std::{ffi::CString, os::fd::AsRawFd};

        let name = CString::new(name).map_err(|_| DiagnosticsArchiveError::ArchiveNotFound)?;
        open_at(
            self.directory.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0,
        )
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                DiagnosticsArchiveError::ArchiveNotFound
            } else {
                DiagnosticsArchiveError::OutputUnavailable
            }
        })
    }
}

#[cfg(unix)]
fn open_at(
    directory: std::os::fd::RawFd,
    name: &std::ffi::CStr,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> io::Result<File> {
    use std::os::fd::FromRawFd;

    let descriptor = unsafe { libc::openat(directory, name.as_ptr(), flags, mode) };
    if descriptor == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
fn link_at(
    source_directory: std::os::fd::RawFd,
    source: &std::ffi::CStr,
    target_directory: std::os::fd::RawFd,
    target: &std::ffi::CStr,
) -> io::Result<()> {
    if unsafe {
        libc::linkat(
            source_directory,
            source.as_ptr(),
            target_directory,
            target.as_ptr(),
            0,
        )
    } == -1
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn unlink_at(directory: std::os::fd::RawFd, name: &std::ffi::CStr) -> io::Result<()> {
    if unsafe { libc::unlinkat(directory, name.as_ptr(), 0) } == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
struct OutputDirectory {
    directory: File,
}

#[cfg(windows)]
impl OutputDirectory {
    fn open(path: &Path, identity: FileIdentity) -> Result<Self, DiagnosticsArchiveError> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };

        let directory = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        let metadata = directory
            .metadata()
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || !identity.matches_file(&directory)
        {
            return Err(DiagnosticsArchiveError::OutputUnavailable);
        }
        Ok(Self { directory })
    }

    fn publish(&self, staged_name: &str, published_name: &str, image: &[u8]) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation as F, Storage::FileSystem as FS};

        let published = wide_name(published_name)?;
        let mut file = nt_create_file(
            self.directory.as_raw_handle() as F::HANDLE,
            staged_name,
            F::GENERIC_WRITE | FS::DELETE | FS::SYNCHRONIZE,
            windows_sys::Wdk::Storage::FileSystem::FILE_CREATE,
        )?;
        let result = (|| {
            file.write_all(image)?;
            file.sync_all()?;
            rename_entry(
                file.as_raw_handle() as F::HANDLE,
                self.directory.as_raw_handle() as F::HANDLE,
                &published,
            )
        })();
        if result.is_err() {
            discard_file(file.as_raw_handle() as F::HANDLE);
        }
        result
    }

    fn remove(&self, name: &str) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation as F, Storage::FileSystem as FS};

        let file = match nt_create_file(
            self.directory.as_raw_handle() as F::HANDLE,
            name,
            FS::DELETE | FS::SYNCHRONIZE,
            windows_sys::Wdk::Storage::FileSystem::FILE_OPEN,
        ) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            result => result?,
        };
        discard_file(file.as_raw_handle() as F::HANDLE);
        Ok(())
    }

    fn open_archive(&self, name: &str) -> Result<File, DiagnosticsArchiveError> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation as F, Storage::FileSystem as FS};

        let file = nt_create_file(
            self.directory.as_raw_handle() as F::HANDLE,
            name,
            F::GENERIC_READ | FS::SYNCHRONIZE,
            windows_sys::Wdk::Storage::FileSystem::FILE_OPEN,
        )
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                DiagnosticsArchiveError::ArchiveNotFound
            } else {
                DiagnosticsArchiveError::OutputUnavailable
            }
        })?;
        let metadata = file
            .metadata()
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        (!metadata.file_type().is_symlink())
            .then_some(file)
            .ok_or(DiagnosticsArchiveError::OutputUnavailable)
    }
}

#[cfg(windows)]
fn nt_create_file(
    directory: windows_sys::Win32::Foundation::HANDLE,
    name: &str,
    access: u32,
    disposition: u32,
) -> io::Result<File> {
    use std::{
        mem::{size_of, size_of_val},
        os::windows::io::{FromRawHandle, RawHandle},
        ptr::{null, null_mut},
    };
    use windows_sys::{
        Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as NFS},
        Win32::{Foundation as F, Storage::FileSystem as FS, System::IO::IO_STATUS_BLOCK},
    };

    let name = wide_name(name)?;
    let mut object_name = F::UNICODE_STRING {
        Length: size_of_val(name.as_slice()) as u16,
        MaximumLength: size_of_val(name.as_slice()) as u16,
        Buffer: name.as_ptr().cast_mut(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: directory,
        ObjectName: &mut object_name,
        Attributes: F::OBJ_CASE_INSENSITIVE | F::OBJ_DONT_REPARSE,
        SecurityDescriptor: null(),
        SecurityQualityOfService: null(),
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut raw = null_mut();
    let result = unsafe {
        NFS::NtCreateFile(
            &mut raw,
            access,
            &attributes,
            &mut status,
            null(),
            FS::FILE_ATTRIBUTE_NORMAL,
            FS::FILE_SHARE_READ | FS::FILE_SHARE_WRITE | FS::FILE_SHARE_DELETE,
            disposition,
            NFS::FILE_NON_DIRECTORY_FILE
                | NFS::FILE_OPEN_REPARSE_POINT
                | NFS::FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if result == F::STATUS_OBJECT_NAME_NOT_FOUND || result == F::STATUS_OBJECT_PATH_NOT_FOUND {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    }
    if result == F::STATUS_OBJECT_NAME_COLLISION {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists));
    }
    if result < 0 {
        return Err(io::Error::from(io::ErrorKind::Other));
    }
    Ok(unsafe { File::from_raw_handle(raw as RawHandle) })
}

#[cfg(windows)]
fn rename_entry(
    file: windows_sys::Win32::Foundation::HANDLE,
    directory: windows_sys::Win32::Foundation::HANDLE,
    target: &[u16],
) -> io::Result<()> {
    use std::mem::{offset_of, size_of, size_of_val};
    use windows_sys::{Wdk::Storage::FileSystem as NFS, Win32::System::IO::IO_STATUS_BLOCK};

    let header = offset_of!(NFS::FILE_RENAME_INFORMATION, FileName);
    let length = header
        .checked_add(size_of_val(target))
        .ok_or_else(|| io::Error::from(io::ErrorKind::Other))?;
    let mut words = vec![0_u64; length.div_ceil(size_of::<u64>())];
    let buffer = words.as_mut_ptr().cast::<u8>();
    unsafe {
        let information = buffer.cast::<NFS::FILE_RENAME_INFORMATION>();
        (*information).Anonymous.ReplaceIfExists = false;
        (*information).RootDirectory = directory;
        (*information).FileNameLength = size_of_val(target) as u32;
        buffer
            .add(header)
            .cast::<u16>()
            .copy_from_nonoverlapping(target.as_ptr(), target.len());
    }
    let mut status = IO_STATUS_BLOCK::default();
    if unsafe {
        NFS::NtSetInformationFile(
            file,
            &mut status,
            buffer.cast(),
            length as u32,
            NFS::FileRenameInformation,
        )
    } < 0
    {
        Err(io::Error::from(io::ErrorKind::AlreadyExists))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn discard_file(file: windows_sys::Win32::Foundation::HANDLE) {
    use std::mem::size_of;
    use windows_sys::{Wdk::Storage::FileSystem as NFS, Win32::System::IO::IO_STATUS_BLOCK};

    let mut disposition = NFS::FILE_DISPOSITION_INFORMATION { DeleteFile: true };
    let mut status = IO_STATUS_BLOCK::default();
    unsafe {
        NFS::NtSetInformationFile(
            file,
            &mut status,
            (&mut disposition as *mut NFS::FILE_DISPOSITION_INFORMATION).cast(),
            size_of::<NFS::FILE_DISPOSITION_INFORMATION>() as u32,
            NFS::FileDispositionInformation,
        );
    }
}

#[cfg(windows)]
fn wide_name(name: &str) -> io::Result<Vec<u16>> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

    if name.is_empty() || name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let encoded = OsStr::new(name).encode_wide().collect::<Vec<_>>();
    (!encoded.is_empty() && encoded.len() <= usize::from(u16::MAX / 2))
        .then_some(encoded)
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))
}

#[cfg(not(any(unix, windows)))]
struct OutputDirectory {
    path: PathBuf,
}

#[cfg(not(any(unix, windows)))]
impl OutputDirectory {
    fn open(path: &Path, identity: FileIdentity) -> Result<Self, DiagnosticsArchiveError> {
        let metadata =
            fs::metadata(path).map_err(|_| DiagnosticsArchiveError::OutputUnavailable)?;
        if !metadata.is_dir() || !identity.matches(&metadata) {
            return Err(DiagnosticsArchiveError::OutputUnavailable);
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    fn publish(&self, staged_name: &str, published_name: &str, image: &[u8]) -> io::Result<()> {
        let staged = self.path.join(staged_name);
        let published = self.path.join(published_name);
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)?;
            file.write_all(image)?;
            file.sync_all()?;
            drop(file);
            fs::hard_link(&staged, &published)?;
            fs::remove_file(&staged)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&staged);
        }
        result
    }

    fn remove(&self, name: &str) -> io::Result<()> {
        match fs::remove_file(self.path.join(name)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }

    fn open_archive(&self, name: &str) -> Result<File, DiagnosticsArchiveError> {
        File::open(self.path.join(name)).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                DiagnosticsArchiveError::ArchiveNotFound
            } else {
                DiagnosticsArchiveError::OutputUnavailable
            }
        })
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl FileIdentity {
    fn from_path(path: &Path) -> Result<Self, DiagnosticsArchiveError> {
        let metadata = fs::metadata(path).map_err(|_| DiagnosticsArchiveError::InvalidRoot)?;
        Self::from_metadata(&metadata).ok_or(DiagnosticsArchiveError::InvalidRoot)
    }

    fn from_metadata(metadata: &fs::Metadata) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;

        Some(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    fn matches(self, metadata: &fs::Metadata) -> bool {
        Self::from_metadata(metadata) == Some(self)
    }
}

#[cfg(windows)]
#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    file: [u8; 16],
}

#[cfg(windows)]
impl FileIdentity {
    fn from_path(path: &Path) -> Result<Self, DiagnosticsArchiveError> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };

        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| DiagnosticsArchiveError::InvalidRoot)?;
        Self::from_file(&file).ok_or(DiagnosticsArchiveError::InvalidRoot)
    }

    fn from_file(file: &File) -> Option<Self> {
        use std::{mem::size_of, os::windows::io::AsRawHandle};
        use windows_sys::Win32::{Foundation as F, Storage::FileSystem as FS};

        let mut identity = FS::FILE_ID_INFO::default();
        (unsafe {
            FS::GetFileInformationByHandleEx(
                file.as_raw_handle() as F::HANDLE,
                FS::FileIdInfo,
                (&mut identity as *mut FS::FILE_ID_INFO).cast(),
                size_of::<FS::FILE_ID_INFO>() as u32,
            )
        } != 0)
            .then_some(Self {
                volume: identity.VolumeSerialNumber,
                file: identity.FileId.Identifier,
            })
    }

    fn matches_file(self, file: &File) -> bool {
        Self::from_file(file) == Some(self)
    }
}

#[cfg(not(any(unix, windows)))]
#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity;

#[cfg(not(any(unix, windows)))]
impl FileIdentity {
    fn from_path(_path: &Path) -> Result<Self, DiagnosticsArchiveError> {
        Ok(Self)
    }

    fn matches(self, _metadata: &fs::Metadata) -> bool {
        true
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf, DiagnosticsArchiveError> {
    if fs::symlink_metadata(path)
        .map_err(|_| DiagnosticsArchiveError::InvalidRoot)?
        .file_type()
        .is_symlink()
    {
        return Err(DiagnosticsArchiveError::InvalidRoot);
    }
    let path = fs::canonicalize(path).map_err(|_| DiagnosticsArchiveError::InvalidRoot)?;
    path.is_dir()
        .then_some(path)
        .ok_or(DiagnosticsArchiveError::InvalidRoot)
}

fn is_regular_directory(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return false;
    }
    fs::canonicalize(path).is_ok_and(|canonical| canonical == path)
}

fn is_archive_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::tests::fixture_root;

    const ARCHIVE_ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn publication_is_atomic_and_leaves_no_staging_artifact() {
        let state_root = fixture_root();
        let root = provisioned(&state_root);

        root.publish(ARCHIVE_ID, b"archive image").unwrap();

        let published = root
            .output_root()
            .join(format!("{ARCHIVE_PREFIX}{ARCHIVE_ID}{ARCHIVE_SUFFIX}"));
        assert_eq!(fs::read(&published).unwrap(), b"archive image");
        assert!(!staging_artifact_exists(root.output_root()));
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn discarded_publication_removes_the_archive_and_tolerates_absence() {
        let state_root = fixture_root();
        let root = provisioned(&state_root);
        root.publish(ARCHIVE_ID, b"archive image").unwrap();

        root.discard(ARCHIVE_ID).unwrap();
        root.discard(ARCHIVE_ID).unwrap();

        assert_eq!(fs::read_dir(root.output_root()).unwrap().count(), 0);
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn read_rejects_unsafe_and_unknown_archive_ids_but_returns_a_published_image() {
        let state_root = fixture_root();
        let root = provisioned(&state_root);

        for archive_id in ["../escape", "not-an-archive-id", ""] {
            assert_eq!(
                root.read(archive_id),
                Err(DiagnosticsArchiveError::ArchiveNotFound)
            );
        }
        assert_eq!(
            root.read("fedcba9876543210fedcba9876543210"),
            Err(DiagnosticsArchiveError::ArchiveNotFound)
        );

        root.publish(ARCHIVE_ID, b"archive image").unwrap();
        assert_eq!(root.read(ARCHIVE_ID), Ok(b"archive image".to_vec()));

        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn a_failed_publication_preserves_the_existing_archive_and_cleans_up_staging() {
        let state_root = fixture_root();
        let root = provisioned(&state_root);
        let published = root
            .output_root()
            .join(format!("{ARCHIVE_PREFIX}{ARCHIVE_ID}{ARCHIVE_SUFFIX}"));
        let staged = root
            .output_root()
            .join(format!("{STAGING_PREFIX}{ARCHIVE_ID}{STAGING_SUFFIX}"));
        root.publish(ARCHIVE_ID, b"existing archive").unwrap();

        assert_eq!(
            root.publish(ARCHIVE_ID, b"replacement"),
            Err(DiagnosticsArchiveError::OutputUnavailable)
        );

        assert_eq!(fs::read(&published).unwrap(), b"existing archive");
        assert!(!staged.exists());
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn a_removed_output_directory_marks_the_root_unavailable() {
        let state_root = fixture_root();
        let root = provisioned(&state_root);
        assert!(root.is_available());

        fs::remove_dir(root.output_root()).unwrap();

        assert!(!root.is_available());
        assert_eq!(
            root.publish(ARCHIVE_ID, b"archive image"),
            Err(DiagnosticsArchiveError::OutputUnavailable)
        );
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn a_symlinked_state_root_is_rejected() {
        let state_root = fixture_root();
        let link = state_root.with_extension("link");
        if create_directory_symlink(&state_root, &link).is_ok() {
            assert_eq!(
                DiagnosticsArchiveRoot::provision(&link, &link).err(),
                Some(DiagnosticsArchiveError::InvalidRoot)
            );
            let _ = fs::remove_file(link);
        }
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn a_non_directory_root_is_rejected_without_leaking_the_path() {
        let state_root = fixture_root();
        let file = state_root.join("root-token-canary");
        fs::write(&file, "runtime-secret-canary").unwrap();
        let missing = state_root.join("workspace-canary");

        for candidate in [&file, &missing] {
            let error = DiagnosticsArchiveRoot::provision(candidate, candidate)
                .err()
                .expect("a non-directory archive root must be rejected");
            let rendered = format!("{error:?} {error}");
            for canary in [
                candidate.to_string_lossy().as_ref(),
                "root-token-canary",
                "runtime-secret-canary",
                "workspace-canary",
            ] {
                assert!(!rendered.contains(canary));
            }
        }
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn an_absent_app_log_directory_resolves_to_no_root_without_failing_the_archive() {
        let state_root = fixture_root();
        let app_log_dir = state_root.join("userdata-logs");
        let root = DiagnosticsArchiveRoot::provision(&state_root, &app_log_dir).unwrap();
        assert!(root.is_available());
        assert!(root.app_log_root().is_none());

        fs::create_dir(&app_log_dir).unwrap();

        assert_eq!(
            root.app_log_root(),
            Some(fs::canonicalize(&app_log_dir).unwrap())
        );
        assert!(root.is_available());
        let _ = fs::remove_dir_all(state_root);
    }

    #[test]
    fn a_symlinked_app_log_directory_is_never_followed() {
        let state_root = fixture_root();
        let target = state_root.join("real-logs");
        fs::create_dir(&target).unwrap();
        let link = state_root.join("linked-logs");
        if create_directory_symlink(&target, &link).is_ok() {
            let root = DiagnosticsArchiveRoot::provision(&state_root, &link).unwrap();

            assert!(root.app_log_root().is_none());
            assert!(root.is_available());
        }
        let _ = fs::remove_dir_all(state_root);
    }

    /// Publication does not read the desktop shell's log directory, so these fixtures leave it
    /// unresolvable and assert only on the archive's own roots.
    fn provisioned(state_root: &Path) -> DiagnosticsArchiveRoot {
        DiagnosticsArchiveRoot::provision(state_root, state_root.join("userdata-logs")).unwrap()
    }

    fn staging_artifact_exists(output_root: &Path) -> bool {
        fs::read_dir(output_root).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .ends_with(STAGING_SUFFIX)
        })
    }

    #[cfg(unix)]
    fn create_directory_symlink(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_symlink(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }
}
