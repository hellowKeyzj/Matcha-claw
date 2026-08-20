//! Output root ownership and atomic publication for the diagnostics archive.
//!
//! The collection roots are provisioned once and never re-resolved, so a symlink swapped in later
//! cannot redirect a read or a write. Publication stages the image under a hidden name, links it to
//! its final name and only then drops the staging file: a reader therefore observes either no
//! archive or a complete one, never a partial image.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use super::{ARCHIVE_BYTE_LIMIT, DiagnosticsArchiveError};

const OUTPUT_DIRECTORY: &str = "host-diagnostics";
const ARCHIVE_PREFIX: &str = "host-diagnostics-";
const ARCHIVE_SUFFIX: &str = ".zip";
const STAGING_PREFIX: &str = ".host-diagnostics-";
const STAGING_SUFFIX: &str = ".tmp";

#[derive(Clone)]
pub(crate) struct DiagnosticsArchiveRoot {
    state_root: PathBuf,
    output_root: PathBuf,
    app_log_dir: PathBuf,
}

impl DiagnosticsArchiveRoot {
    pub(crate) fn provision(
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
        Ok(Self {
            output_root: canonical_directory(&output_root)?,
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
        is_regular_directory(&self.state_root) && is_regular_directory(&self.output_root)
    }

    pub(super) fn publish(
        &self,
        archive_id: &str,
        image: &[u8],
    ) -> Result<(), DiagnosticsArchiveError> {
        let staged = self.contained(STAGING_PREFIX, archive_id, STAGING_SUFFIX)?;
        let published = self.contained(ARCHIVE_PREFIX, archive_id, ARCHIVE_SUFFIX)?;
        link_atomically(&staged, &published, image)
            .map_err(|_| DiagnosticsArchiveError::OutputUnavailable)
    }

    pub(super) fn discard(&self, archive_id: &str) -> Result<(), DiagnosticsArchiveError> {
        let published = self.contained(ARCHIVE_PREFIX, archive_id, ARCHIVE_SUFFIX)?;
        remove_if_present(&published).map_err(|_| DiagnosticsArchiveError::OutputUnavailable)
    }

    pub(super) fn read(&self, archive_id: &str) -> Result<Vec<u8>, DiagnosticsArchiveError> {
        if !is_archive_id(archive_id) {
            return Err(DiagnosticsArchiveError::ArchiveNotFound);
        }
        let path = self.contained(ARCHIVE_PREFIX, archive_id, ARCHIVE_SUFFIX)?;
        let file = open_archive(&path)?;
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

    fn contained(
        &self,
        prefix: &str,
        archive_id: &str,
        suffix: &str,
    ) -> Result<PathBuf, DiagnosticsArchiveError> {
        let path = self
            .output_root
            .join(format!("{prefix}{archive_id}{suffix}"));
        is_contained_regular_path(&self.output_root, &path)
            .then_some(path)
            .ok_or(DiagnosticsArchiveError::OutputUnavailable)
    }
}

#[cfg(unix)]
fn open_archive(path: &Path) -> Result<File, DiagnosticsArchiveError> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                DiagnosticsArchiveError::ArchiveNotFound
            } else {
                DiagnosticsArchiveError::OutputUnavailable
            }
        })
}

#[cfg(windows)]
fn open_archive(path: &Path) -> Result<File, DiagnosticsArchiveError> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
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

fn link_atomically(staged: &Path, published: &Path, image: &[u8]) -> io::Result<()> {
    let mut published_created = false;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(staged)?;
        file.write_all(image)?;
        file.sync_all()?;
        drop(file);
        fs::hard_link(staged, published)?;
        published_created = true;
        fs::remove_file(staged)
    })();
    if result.is_err() {
        let published_cleanup = published_created.then(|| remove_if_present(published));
        let staged_cleanup = remove_if_present(staged);
        if let Some(Err(error)) = published_cleanup {
            return Err(error);
        }
        staged_cleanup?;
    }
    result
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
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

fn is_contained_regular_path(root: &Path, candidate: &Path) -> bool {
    let Ok(relative) = candidate.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return false;
        };
        current.push(segment);
        let symlinked = fs::symlink_metadata(&current)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false);
        if symlinked {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::archive::tests::fixture_root;

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
    fn a_failed_link_preserves_the_existing_archive_and_cleans_up_staging() {
        let state_root = fixture_root();
        let root = provisioned(&state_root);
        let published = root
            .output_root()
            .join(format!("{ARCHIVE_PREFIX}{ARCHIVE_ID}{ARCHIVE_SUFFIX}"));
        let staged = root
            .output_root()
            .join(format!("{STAGING_PREFIX}{ARCHIVE_ID}{STAGING_SUFFIX}"));
        fs::write(&published, "existing archive").unwrap();

        let error = link_atomically(&staged, &published, b"replacement")
            .expect_err("an existing archive must reject the atomic link");

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
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
