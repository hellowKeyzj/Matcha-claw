use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
};

use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::Digest,
    package::{PackageFailure, PackageManifest, SignatureEnvelope},
};

use super::{
    archive::{self, ArchiveIssue, ArchiveLimits},
    error::PackageError,
    path::{PathIndex, PathIssue},
};

pub struct PackageReadLimits {
    pub transport_bytes: u64,
    pub entries: usize,
    pub file_bytes: u64,
    pub expanded_bytes: u64,
    pub manifest_bytes: usize,
    pub signature_bytes: usize,
    pub signatures: usize,
}

impl Default for PackageReadLimits {
    fn default() -> Self {
        Self {
            transport_bytes: 1024 * 1024 * 1024,
            entries: 4096,
            file_bytes: 1024 * 1024 * 1024,
            expanded_bytes: 1024 * 1024 * 1024,
            manifest_bytes: 1024 * 1024,
            signature_bytes: 64 * 1024,
            // matcha.world-package/1 has one signatures/package.sig envelope.
            signatures: 1,
        }
    }
}

/// Bytes have passed transport, path, size and whole-payload digest validation.
/// This does not assert actual runtime imports/exports or grant requested access.
pub struct VerifiedPayload {
    pub manifest: PackageManifest,
    pub package_digest: Digest,
    pub transport_digest: Digest,
    pub(super) manifest_bytes: Vec<u8>,
    pub(super) files: BTreeMap<String, Vec<u8>>,
    pub(super) signatures: Vec<SignatureEnvelope>,
}

impl VerifiedPayload {
    pub fn read(
        bytes: &[u8],
        limits: &PackageReadLimits,
        cancellation: &CancellationToken,
    ) -> Result<Self, PackageError> {
        check_cancelled(cancellation)?;
        let entries = archive::inspect(
            bytes,
            &ArchiveLimits {
                transport_bytes: limits.transport_bytes,
                entries: limits.entries,
                file_bytes: limits.file_bytes,
                expanded_bytes: limits.expanded_bytes,
            },
        )
        .map_err(archive_error)?;
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|cause| PackageError::caused(PackageFailure::InvalidArchive, cause))?;
        if archive.len() != entries.len() {
            return Err(PackageError::new(PackageFailure::InvalidArchive));
        }
        let mut files = BTreeMap::new();
        let mut directories = Vec::new();
        let mut signatures = Vec::new();
        let mut manifest_bytes = None;
        let mut expanded = 0u64;
        for (index, entry) in entries.iter().enumerate() {
            check_cancelled(cancellation)?;
            let mut file = archive
                .by_index(index)
                .map_err(|cause| PackageError::caused(PackageFailure::InvalidArchive, cause))?;
            if file.name() != entry.path
                || file.header_start() != entry.header_offset
                || file.data_start() != entry.data_offset
                || file.size() != entry.bytes
                || file.compressed_size() != entry.compressed_bytes
                || file.crc32() != entry.crc32
                || file.is_dir() != entry.directory
                || file.is_symlink()
            {
                return Err(PackageError::new(PackageFailure::InvalidArchive));
            }
            if entry.directory {
                let mut byte = [0u8; 1];
                if file
                    .read(&mut byte)
                    .map_err(|cause| PackageError::caused(PackageFailure::InvalidArchive, cause))?
                    != 0
                {
                    return Err(PackageError::new(PackageFailure::SizeMismatch {
                        path: entry.path.clone(),
                    }));
                }
                directories.push(entry.path.trim_end_matches('/').to_owned());
                continue;
            }
            let maximum = if entry.path == "package.json" {
                limits.manifest_bytes as u64
            } else if signature_path(&entry.path) {
                limits.signature_bytes as u64
            } else {
                limits.file_bytes
            };
            if entry.bytes > maximum {
                return Err(PackageError::new(PackageFailure::ArchiveLimit));
            }
            let mut contents = Vec::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                check_cancelled(cancellation)?;
                let available = entry.bytes.saturating_sub(contents.len() as u64);
                let read_limit = available.saturating_add(1).min(buffer.len() as u64) as usize;
                let length = file
                    .read(&mut buffer[..read_limit])
                    .map_err(|cause| PackageError::caused(PackageFailure::InvalidArchive, cause))?;
                if length == 0 {
                    break;
                }
                expanded = expanded
                    .checked_add(length as u64)
                    .filter(|size| *size <= limits.expanded_bytes)
                    .ok_or_else(|| PackageError::new(PackageFailure::ArchiveLimit))?;
                if length as u64 > available {
                    return Err(PackageError::new(PackageFailure::SizeMismatch {
                        path: entry.path.clone(),
                    }));
                }
                contents.extend_from_slice(&buffer[..length]);
            }
            if contents.len() as u64 != entry.bytes {
                return Err(PackageError::new(PackageFailure::SizeMismatch {
                    path: entry.path.clone(),
                }));
            }
            if entry.path == "package.json" {
                manifest_bytes = Some(contents);
            } else if signature_path(&entry.path) {
                if signatures.len() >= limits.signatures {
                    return Err(PackageError::new(PackageFailure::ArchiveLimit));
                }
                signatures.push(serde_json::from_slice(&contents).map_err(|cause| {
                    PackageError::caused(PackageFailure::SignatureInvalid, cause)
                })?);
            } else {
                files.insert(entry.path.clone(), contents);
            }
        }
        let manifest_bytes =
            manifest_bytes.ok_or_else(|| PackageError::new(PackageFailure::ManifestMissing))?;
        let manifest: PackageManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|cause| {
                PackageError::caused(super::manifest::invalid("package.json"), cause)
            })?;
        let mut paths = PathIndex::default();
        for declared in &manifest.files {
            paths.insert(&declared.path, false).map_err(path_error)?;
            if declared.path == "package.json" || signature_path(&declared.path) {
                return Err(PackageError::new(super::manifest::invalid("files")));
            }
            let contents = files.get(&declared.path).ok_or_else(|| {
                PackageError::new(PackageFailure::FileMissing {
                    path: declared.path.clone(),
                })
            })?;
            if declared.size != contents.len() as u64 {
                return Err(PackageError::new(PackageFailure::SizeMismatch {
                    path: declared.path.clone(),
                }));
            }
            if declared.digest != digest(contents) {
                return Err(PackageError::new(PackageFailure::DigestMismatch {
                    path: declared.path.clone(),
                }));
            }
        }
        for path in files.keys() {
            if !manifest.files.iter().any(|entry| &entry.path == path) {
                return Err(PackageError::new(PackageFailure::UnlistedFile {
                    path: path.clone(),
                }));
            }
        }
        // Explicit empty directories are not payload and cannot conceal another archive tree.
        for directory in directories {
            let prefix = format!("{directory}/");
            if !entries
                .iter()
                .any(|entry| !entry.directory && entry.path.starts_with(&prefix))
            {
                return Err(PackageError::new(PackageFailure::UnlistedFile {
                    path: directory,
                }));
            }
        }
        super::manifest::validate(&manifest, &files)?;
        Ok(Self {
            package_digest: digest(&manifest_bytes),
            transport_digest: digest(bytes),
            manifest,
            manifest_bytes,
            files,
            signatures,
        })
    }
}

pub(super) fn signature_path(path: &str) -> bool {
    path == world_protocol::package::SIGNATURE_PATH
}

pub(super) fn digest(bytes: &[u8]) -> Digest {
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .expect("SHA256 renders a valid digest")
}

pub(super) fn check_cancelled(cancellation: &CancellationToken) -> Result<(), PackageError> {
    if cancellation.is_cancelled() {
        Err(PackageError::new(PackageFailure::Cancelled))
    } else {
        Ok(())
    }
}

fn archive_error(issue: ArchiveIssue) -> PackageError {
    PackageError::new(match issue {
        ArchiveIssue::Malformed => PackageFailure::InvalidArchive,
        ArchiveIssue::Unsupported => PackageFailure::UnsupportedCompression,
        ArchiveIssue::Encrypted => PackageFailure::EncryptedArchive,
        ArchiveIssue::Path { issue, .. } => return path_error(issue),
        ArchiveIssue::Link { .. } => PackageFailure::LinkEntry,
        ArchiveIssue::Limit { .. } => PackageFailure::ArchiveLimit,
    })
}
fn path_error(issue: PathIssue) -> PackageError {
    PackageError::new(match issue {
        PathIssue::Invalid | PathIssue::FileDirectoryConflict => PackageFailure::InvalidPath,
        PathIssue::Duplicate => PackageFailure::DuplicatePath,
        PathIssue::CaseCollision => PackageFailure::CaseCollision,
    })
}
