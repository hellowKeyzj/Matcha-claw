use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use sha2::{Digest as _, Sha256};

use platform::state_dir::{CanonicalStateDir, StateDirHandle};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::Digest,
    package::{PackageArtifact, PackageFailure, PackageFile, PackageLimits},
};

use super::{
    error::PackageError,
    payload::{PackageReadLimits, VerifiedPayload, check_cancelled, digest},
};

pub(super) struct PackageFiles {
    root: CanonicalStateDir,
    _owner: File,
    live: Mutex<BTreeMap<Digest, usize>>,
}

/// Holds the package live until the runtime has confirmed resource cleanup.
/// Drop releases the pin; it never removes a binary or changes durable inventory.
pub struct ArtifactLease {
    pub artifact: PackageArtifact,
    pub(super) package: Digest,
    path: Option<PathBuf>,
    files: Vec<ExecutionFile>,
    owner: Arc<PackageFiles>,
    limits: PackageLimits,
}

struct ExecutionFile {
    file: PackageFile,
    path: PathBuf,
    _handle: File,
}

impl ArtifactLease {
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
    pub fn package_digest(&self) -> &Digest {
        &self.package
    }
    pub fn package_limits(&self) -> &PackageLimits {
        &self.limits
    }
    pub(crate) fn file_path(&self, file: &PackageFile) -> Option<&Path> {
        self.files.iter().find(|member| &member.file == file)
            .map(|member| member.path.as_path())
    }
    /// Hashes and returns the same read-only execution handle; callers must not reopen its path.
    pub fn open_binary(
        &self,
        maximum: usize,
        cancellation: &CancellationToken,
    ) -> Result<File, PackageError> {
        check_cancelled(cancellation)?;
        let member = self.files.iter().find(|member| {
            self.artifact.path.as_ref() == Some(&member.file.path)
                && member.file.digest == self.artifact.digest
        }).ok_or_else(|| PackageError::new(PackageFailure::ArtifactInvalid {
            artifact_id: self.artifact.id.clone(),
        }))?;
        let mut file = member._handle.try_clone()
            .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
        file.rewind().map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
        if file
            .metadata()
            .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?
            .len()
            > maximum as u64
        {
            return Err(PackageError::new(PackageFailure::ArchiveLimit));
        }
        let mut hash = Sha256::new();
        let mut total = 0usize;
        let mut buffer = [0u8; 65536];
        loop {
            check_cancelled(cancellation)?;
            let read = file
                .read(&mut buffer)
                .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
            if read == 0 {
                break;
            }
            total = total
                .checked_add(read)
                .filter(|size| *size <= maximum)
                .ok_or_else(|| PackageError::new(PackageFailure::ArchiveLimit))?;
            hash.update(&buffer[..read]);
        }
        let actual =
            Digest::try_new(format!("sha256:{:x}", hash.finalize())).expect("SHA256 digest");
        if actual != self.artifact.digest {
            return Err(PackageError::new(PackageFailure::DigestMismatch {
                path: self.artifact.path.clone().unwrap_or_default(),
            }));
        }
        file.rewind()
            .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
        check_cancelled(cancellation)?;
        Ok(file)
    }

    pub fn read_bytes(
        &self,
        maximum: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, PackageError> {
        check_cancelled(cancellation)?;
        let mut file = self.open_binary(maximum, cancellation)?;
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 65536];
        loop {
            check_cancelled(cancellation)?;
            let read = file.read(&mut buffer)
                .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
            if read == 0 { break; }
            if read > maximum.saturating_sub(bytes.len()) {
                return Err(PackageError::new(PackageFailure::ArchiveLimit));
            }
            bytes.extend_from_slice(&buffer[..read]);
        }
        if digest(&bytes) != self.artifact.digest {
            return Err(PackageError::new(PackageFailure::DigestMismatch {
                path: self.artifact.path.clone().unwrap_or_default(),
            }));
        }
        check_cancelled(cancellation)?;
        Ok(bytes)
    }
}
impl std::fmt::Debug for ArtifactLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ArtifactLease")
            .field("artifact", &self.artifact.id)
            .field("package", &self.package)
            .finish_non_exhaustive()
    }
}
impl Drop for ArtifactLease {
    fn drop(&mut self) {
        self.files.clear();
        let mut live = self.owner.live.lock().expect("package live pins poisoned");
        if let Some(count) = live.get_mut(&self.package) {
            *count -= 1;
            if *count == 0 {
                live.remove(&self.package);
            }
        }
    }
}

impl PackageFiles {
    pub(super) fn open(path: &Path) -> Result<Arc<Self>, PackageError> {
        let root = CanonicalStateDir::provision_private(path)
            .map_err(|cause| PackageError::caused(PackageFailure::IoWrite, cause))?;
        let directory = root
            .open()
            .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
        let owner = directory
            .lock_regular_file(".package-owner.lock")
            .map_err(|cause| PackageError::caused(PackageFailure::IoWrite, cause))?;
        Ok(Arc::new(Self {
            root,
            _owner: owner,
            live: Mutex::new(BTreeMap::new()),
        }))
    }

    pub(super) fn bind_world(
        &self,
        world: &world_protocol::ids::WorldRef,
    ) -> Result<(), PackageError> {
        let bytes = serde_json::to_vec(world)
            .map_err(|cause| PackageError::caused(PackageFailure::InternalFault, cause))?;
        self.write_once(".package-world", &bytes, bytes.len())
    }

    pub(super) fn is_live(&self, package: &Digest) -> bool {
        self.live
            .lock()
            .expect("package live pins poisoned")
            .contains_key(package)
    }

    pub(super) fn publish(
        &self,
        payload: &VerifiedPayload,
        bytes: &[u8],
        maximum: usize,
        cancellation: &CancellationToken,
    ) -> Result<(), PackageError> {
        check_cancelled(cancellation)?;
        if digest(bytes) != payload.transport_digest {
            return Err(PackageError::new(PackageFailure::InvalidArchive));
        }
        self.write_once(
            &transport_name(&payload.package_digest, &payload.transport_digest),
            bytes,
            maximum,
        )?;
        check_cancelled(cancellation)
    }

    pub(super) fn read(
        &self,
        package: &Digest,
        transport: &Digest,
        limits: &PackageReadLimits,
        cancellation: &CancellationToken,
    ) -> Result<VerifiedPayload, PackageError> {
        let bytes = self.read_transport(package, transport, limits.transport_bytes as usize)?;
        let payload = VerifiedPayload::read(&bytes, limits, cancellation)?;
        if &payload.package_digest != package || &payload.transport_digest != transport {
            return Err(PackageError::new(PackageFailure::DigestMismatch {
                path: "package.json".into(),
            }));
        }
        Ok(payload)
    }

    pub(super) fn identity(&self) -> &CanonicalStateDir {
        &self.root
    }

    pub(super) fn read_transport(
        &self,
        package: &Digest,
        transport: &Digest,
        maximum: usize,
    ) -> Result<Vec<u8>, PackageError> {
        let bytes = self
            .root
            .read_regular_file_bounded(&transport_name(package, transport), maximum)
            .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?
            .ok_or_else(|| PackageError::new(PackageFailure::IoRead))?;
        if digest(&bytes) != *transport {
            return Err(PackageError::new(PackageFailure::DigestMismatch {
                path: "package".into(),
            }));
        }
        Ok(bytes)
    }

    pub(super) fn artifact(
        self: &Arc<Self>,
        payload: &VerifiedPayload,
        artifact: &PackageArtifact,
        cancellation: &CancellationToken,
    ) -> Result<ArtifactLease, PackageError> {
        check_cancelled(cancellation)?;
        if !payload.manifest.artifacts.contains(artifact) {
            return Err(PackageError::new(PackageFailure::ArtifactInvalid {
                artifact_id: artifact.id.clone(),
            }));
        }
        let mut live = self.live.lock().expect("package live pins poisoned");
        let (path, files) = match artifact.runtime {
            world_protocol::package::ArtifactRuntime::Native => {
                if artifact.path.is_some() {
                    return Err(PackageError::new(PackageFailure::ArtifactInvalid {
                        artifact_id: artifact.id.clone(),
                    }));
                }
                (None, Vec::new())
            }
            world_protocol::package::ArtifactRuntime::TrustedProcess => {
                let (path, files) = self.execution_files(payload, artifact, cancellation)?;
                (Some(path), files)
            }
            world_protocol::package::ArtifactRuntime::WasmComponent => {
                let path = artifact.path.as_ref().ok_or_else(|| {
                    PackageError::new(PackageFailure::ArtifactInvalid {
                        artifact_id: artifact.id.clone(),
                    })
                })?;
                let bytes = payload.files.get(path).ok_or_else(|| {
                    PackageError::new(PackageFailure::FileMissing { path: path.clone() })
                })?;
                let name = format!("a-{}-{}.bin", hex(&payload.package_digest), hex(&artifact.digest));
                self.write_once(&name, bytes, bytes.len())?;
                let member = payload.manifest.files.iter().find(|file| &file.path == path)
                    .ok_or_else(|| PackageError::new(PackageFailure::FileMissing { path: path.clone() }))?;
                let handle = verified_file(&self.root, &name, member, cancellation)?;
                let path = self.root.as_path().join(name);
                (Some(path.clone()), vec![ExecutionFile { file: member.clone(), path, _handle: handle }])
            }
        };
        *live.entry(payload.package_digest.clone()).or_default() += 1;
        Ok(ArtifactLease {
            artifact: artifact.clone(),
            package: payload.package_digest.clone(),
            path,
            files,
            owner: self.clone(),
            limits: payload.manifest.limits.clone(),
        })
    }

    fn execution_files(
        &self,
        payload: &VerifiedPayload,
        artifact: &PackageArtifact,
        cancellation: &CancellationToken,
    ) -> Result<(PathBuf, Vec<ExecutionFile>), PackageError> {
        let _root = self.root.open()
            .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
        let directory = CanonicalStateDir::provision_private(self.root.as_path().join(format!(
            "e-{}-{}", hex(&payload.package_digest), hex(&artifact.digest),
        ))).map_err(|cause| PackageError::caused(PackageFailure::IoWrite, cause))?;
        let executable = artifact.path.as_ref().ok_or_else(|| {
            PackageError::new(PackageFailure::ArtifactInvalid { artifact_id: artifact.id.clone() })
        })?;
        let mut files = Vec::with_capacity(payload.manifest.files.len());
        for file in &payload.manifest.files {
            check_cancelled(cancellation)?;
            let bytes = payload.files.get(&file.path).ok_or_else(|| {
                PackageError::new(PackageFailure::FileMissing { path: file.path.clone() })
            })?;
            let mut parent = directory.clone();
            let mut components = file.path.split('/').peekable();
            while let Some(name) = components.next() {
                if components.peek().is_none() {
                    write_once(&parent, name, bytes, bytes.len())?;
                    let handle = verified_file(&parent, name, file, cancellation)?;
                    #[cfg(unix)]
                    if &file.path == executable {
                        use std::os::unix::fs::PermissionsExt;
                        handle.set_permissions(fs::Permissions::from_mode(0o700))
                            .map_err(|cause| PackageError::caused(PackageFailure::IoWrite, cause))?;
                    }
                    files.push(ExecutionFile {
                        file: file.clone(), path: parent.as_path().join(name), _handle: handle,
                    });
                } else {
                    parent = CanonicalStateDir::provision_private(parent.as_path().join(name))
                        .map_err(|cause| PackageError::caused(PackageFailure::IoWrite, cause))?;
                }
            }
        }
        if !files.iter().any(|file| &file.file.path == executable && file.file.digest == artifact.digest) {
            return Err(PackageError::new(PackageFailure::FileMissing { path: executable.clone() }));
        }
        Ok((directory.as_path().join(executable), files))
    }

    pub(super) fn remove(
        &self,
        package: &Digest,
        cancellation: &CancellationToken,
    ) -> Result<(), PackageError> {
        let live = self.live.lock().expect("package live pins poisoned");
        if live.contains_key(package) {
            return Err(PackageError::new(PackageFailure::RetainedReferences));
        }
        let execution_prefix = format!("e-{}-", hex(package));
        let prefixes = [
            format!("p-{}-", hex(package)),
            format!("a-{}-", hex(package)),
            execution_prefix.clone(),
        ];
        let directory = self
            .root
            .open()
            .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
        for entry in fs::read_dir(self.root.as_path())
            .map_err(|cause| PackageError::caused(PackageFailure::CleanupFailed, cause))?
        {
            check_cancelled(cancellation)?;
            let entry = entry
                .map_err(|cause| PackageError::caused(PackageFailure::CleanupFailed, cause))?;
            let name = entry.file_name();
            if name
                .to_str()
                .is_some_and(|name| prefixes.iter().any(|prefix| name.starts_with(prefix)))
            {
                let metadata = entry
                    .file_type()
                    .map_err(|cause| PackageError::caused(PackageFailure::CleanupFailed, cause))?;
                if metadata.is_dir() && name.to_str().is_some_and(|name| name.starts_with(&execution_prefix)) {
                    remove_execution_directory(&entry.path(), cancellation)?;
                } else if metadata.is_file() {
                    fs::remove_file(entry.path())
                        .map_err(|cause| PackageError::caused(PackageFailure::CleanupFailed, cause))?;
                } else {
                    return Err(PackageError::new(PackageFailure::CleanupFailed));
                }
            }
        }
        sync_directory(&directory)
    }

    fn write_once(&self, name: &str, bytes: &[u8], maximum: usize) -> Result<(), PackageError> {
        write_once(&self.root, name, bytes, maximum)
    }
}

fn write_once(root: &CanonicalStateDir, name: &str, bytes: &[u8], maximum: usize) -> Result<(), PackageError> {
    let directory = root.open()
        .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
    if let Some(existing) = directory.read_regular_file_bounded(name, maximum)
        .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?
    {
        if existing != bytes {
            return Err(PackageError::new(PackageFailure::InstallConflict));
        }
        return Ok(());
    }
    directory.replace_regular_file_bounded_detailed(name, bytes, maximum)
        .map_err(|cause| {
            if cause.cleanup_failed() {
                PackageError::new(PackageFailure::IoSync).with_cleanup(cause)
            } else {
                PackageError::caused(PackageFailure::IoSync, cause)
            }
        })?;
    sync_directory(&directory)
}

fn verified_file(
    directory: &CanonicalStateDir,
    name: &str,
    member: &PackageFile,
    cancellation: &CancellationToken,
) -> Result<File, PackageError> {
    let mut file = directory.open_regular_file_readonly(name)
        .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?
        .ok_or_else(|| PackageError::new(PackageFailure::IoRead))?;
    if file.metadata().map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?.len() != member.size {
        return Err(PackageError::new(PackageFailure::SizeMismatch { path: member.path.clone() }));
    }
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        check_cancelled(cancellation)?;
        let read = file.read(&mut buffer)
            .map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
        if read == 0 { break; }
        total = total.checked_add(read as u64).filter(|size| *size <= member.size)
            .ok_or_else(|| PackageError::new(PackageFailure::SizeMismatch { path: member.path.clone() }))?;
        hash.update(&buffer[..read]);
    }
    let actual = Digest::try_new(format!("sha256:{:x}", hash.finalize())).expect("SHA256 digest");
    if total != member.size || actual != member.digest {
        return Err(PackageError::new(PackageFailure::DigestMismatch { path: member.path.clone() }));
    }
    file.rewind().map_err(|cause| PackageError::caused(PackageFailure::IoRead, cause))?;
    check_cancelled(cancellation)?;
    Ok(file)
}

fn remove_execution_directory(path: &Path, cancellation: &CancellationToken) -> Result<(), PackageError> {
    let directory = CanonicalStateDir::open_existing(path)
        .map_err(|cause| PackageError::caused(PackageFailure::CleanupFailed, cause))?;
    drop(directory.open().map_err(|cause| PackageError::caused(PackageFailure::CleanupFailed, cause))?);
    check_cancelled(cancellation)?;
    // std removes directory entries without traversing symbolic links or Windows reparse points.
    fs::remove_dir_all(directory.as_path())
        .map_err(|cause| PackageError::caused(PackageFailure::CleanupFailed, cause))
}

fn transport_name(package: &Digest, transport: &Digest) -> String {
    format!("p-{}-{}.zip", hex(package), hex(transport))
}
fn hex(digest: &Digest) -> &str {
    &digest.as_str()[7..]
}

fn sync_directory(directory: &StateDirHandle) -> Result<(), PackageError> {
    #[cfg(unix)]
    {
        let file = File::from(
            directory
                .clone_descriptor()
                .map_err(|cause| PackageError::caused(PackageFailure::IoSync, cause))?,
        );
        file.sync_all()
            .map_err(|cause| PackageError::caused(PackageFailure::IoSync, cause))
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::FlushFileBuffers;
        if unsafe { FlushFileBuffers(directory.raw_handle()) } == 0 {
            let cause = std::io::Error::last_os_error();
            // Windows directories may reject FlushFileBuffers; per-file publication uses WRITE_THROUGH.
            if cause.raw_os_error() != Some(5) {
                return Err(PackageError::caused(PackageFailure::IoSync, cause));
            }
        }
        Ok(())
    }
}
