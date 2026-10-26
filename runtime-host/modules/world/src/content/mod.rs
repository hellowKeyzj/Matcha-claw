mod archive;
mod blob;
mod cleanup;
mod records;
mod retention;
mod staging;
mod transfer;
mod upload;
mod world_deletion;

use std::{error::Error as StdError, fmt, io::Read, path::Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::{ContentId, Digest, WorldRef},
    materials::{BlobRef, MaterialFailure},
};

use crate::store::{Committed, StoreError};

pub(crate) use archive::{ArchiveMaterials, BlobArchiveValidation, archive_materials};
pub(crate) use cleanup::{
    CleanupBatch, CleanupCheckpoint, cleanup_batch_finished, cleanup_candidates, cleanup_impact,
};
pub(crate) use records::{
    LoadedParse, ParseInput, ParseRead, PreparedParse, SourceOriginError, list_source_versions,
    parse_origin, parse_source_version, read_source_version_in_transaction,
    read_source_version_metadata_snapshot, read_source_version_snapshot,
    require_loaded_parse_in_transaction, require_parse_artifact_in_transaction,
    require_parse_artifact_snapshot, source_metadata as read_source_version_metadata,
    source_origin_family, validate_archive_restore,
};
pub(crate) use retention::{
    BlobPin, CleanupOwner, CleanupTarget, ContentOwner, ContentReference, DeletionClaim,
    DeletionPlan, DeletionReason, DeletionState, DeletionStatus, HoldKind, PinKind, RetentionHold,
    acknowledge_cleanup, begin_deletion, claim_deletion, cleanup_owner, finish_deletion, hold,
    owner_references, pending_deletions, pin, read_deletion, release_hold, release_pin,
    release_reference, require_source_cleanup, require_source_deletion, retain, validate_pin,
};
pub(crate) use staging::{StageCleanupOutcome, StagedCommit};

pub(crate) use transfer::{BlobTransferPlan, BlobTransferValidation};
pub(crate) use upload::{PreparedUploadChunk, PreparedUploadSeal, UploadError};
pub(crate) use world_deletion::world_deletion_roots;

#[derive(Clone)]
pub(crate) enum Error {
    Material {
        reason: MaterialFailure,
        source: Option<std::sync::Arc<dyn StdError + Send + Sync>>,
        cleanup_failed: bool,
    },
    Store(StoreError),
}

impl Error {
    pub(crate) fn material(reason: MaterialFailure) -> Self {
        Self::Material {
            reason,
            source: None,
            cleanup_failed: false,
        }
    }

    fn caused(reason: MaterialFailure, source: impl StdError + Send + Sync + 'static) -> Self {
        Self::Material {
            reason,
            source: Some(std::sync::Arc::new(source)),
            cleanup_failed: false,
        }
    }

    pub(crate) fn reason(&self) -> Option<&MaterialFailure> {
        match self {
            Self::Material { reason, .. } => Some(reason),
            Self::Store(_) => None,
        }
    }

    pub(crate) fn write_diagnostic(&self) -> Option<serde_json::Value> {
        let Self::Material {
            reason: MaterialFailure::WriteFailed,
            source,
            cleanup_failed,
        } = self
        else {
            return None;
        };
        let step = source
            .as_deref()
            .and_then(|cause| cause.downcast_ref::<blob::Error>())
            .and_then(|error| error.step);
        let mut cause = self.source();
        let mut io = None;
        while let Some(error) = cause {
            if let Some(error) = error.downcast_ref::<std::io::Error>() {
                io = Some(error);
                break;
            }
            cause = error.source();
        }
        Some(serde_json::json!({
            "step": step,
            "ioKind": io.map(|error| format!("{:?}", error.kind())),
            "rawOsError": io.and_then(std::io::Error::raw_os_error),
            "cleanupFailed": cleanup_failed,
        }))
    }
}

impl From<StoreError> for Error {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl From<blob::Error> for Error {
    fn from(error: blob::Error) -> Self {
        if error.reason == blob::Failure::Publish && platform::trace::enabled() {
            platform::trace::runtime_trace("world.content.publish_failed", || {
                let mut cause = error.source();
                let mut io = None;
                while let Some(source) = cause {
                    if let Some(error) = source.downcast_ref::<std::io::Error>() {
                        io = Some(error);
                        break;
                    }
                    cause = source.source();
                }
                serde_json::json!({
                    "step": error.step,
                    "ioKind": io.map(|error| format!("{:?}", error.kind())),
                    "rawOsError": io.and_then(std::io::Error::raw_os_error),
                    "cleanupFailed": error.cleanup_failed(),
                })
            });
        }
        let reason = match error.reason {
            blob::Failure::InvalidInput | blob::Failure::UnsafeFile => {
                MaterialFailure::InputInvalid
            }
            blob::Failure::SizeLimit => MaterialFailure::SizeLimit,
            blob::Failure::DigestMismatch => MaterialFailure::DigestMismatch,
            blob::Failure::Read => MaterialFailure::ReadFailed,
            blob::Failure::Write => MaterialFailure::WriteFailed,
            blob::Failure::Sync => MaterialFailure::SyncFailed,
            blob::Failure::Publish => MaterialFailure::PublishFailed,
            blob::Failure::NotFound => MaterialFailure::ContentNotFound,
            blob::Failure::Cleanup => MaterialFailure::CleanupFailed,
            blob::Failure::Cancelled => MaterialFailure::Cancelled,
        };
        Self::Material {
            reason,
            cleanup_failed: error.cleanup_failed(),
            source: Some(std::sync::Arc::new(error)),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Material { reason, .. } => write!(formatter, "world content {reason:?}"),
            Self::Store(error) => error.fmt(formatter),
        }
    }
}
impl fmt::Debug for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Material {
                reason,
                cleanup_failed,
                ..
            } => formatter
                .debug_struct("ContentError")
                .field("reason", reason)
                .field("cleanup_failed", cleanup_failed)
                .finish_non_exhaustive(),
            Self::Store(error) => error.fmt(formatter),
        }
    }
}
impl StdError for Error {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Material { source, .. } => source
                .as_deref()
                .map(|cause| cause as &(dyn StdError + 'static)),
            Self::Store(error) => Some(error),
        }
    }
}

/// Physical bytes only. All durable authority is in the same world's PostgreSQL transaction.
pub(crate) struct Content {
    world: WorldRef,
    blobs: blob::Blobs,
    cleanup: tokio::sync::Mutex<Option<cleanup::CleanupCustody>>,
}

pub(crate) struct PreparedBlob {
    world: WorldRef,
    reference: BlobRef,
    staged: blob::Prepared,
}

impl PreparedBlob {
    pub(crate) fn reference(&self) -> &BlobRef {
        &self.reference
    }
}

/// Physical result cannot be fabricated by a deletion caller.
pub(crate) struct CleanupResult {
    claim: DeletionClaim,
    result: Result<(), Error>,
}

impl CleanupResult {
    pub(crate) fn result(&self) -> Result<(), &Error> {
        self.result.as_ref().map(|_| ())
    }
}

impl Content {
    pub(crate) fn open(root: &Path, world: WorldRef, maximum_bytes: u64) -> Result<Self, Error> {
        let root = platform::state_dir::CanonicalStateDir::provision_private(root)
            .map_err(|cause| Error::caused(MaterialFailure::InputInvalid, cause))?;
        let scope = serde_json::to_vec(&world)
            .map_err(|cause| Error::caused(MaterialFailure::InputInvalid, cause))?;
        let directory = root
            .as_path()
            .join(blob::digest_name(&Sha256::digest(scope).into()));
        let blobs = blob::Blobs::open(&directory, maximum_bytes)?;
        Ok(Self {
            world,
            blobs,
            cleanup: tokio::sync::Mutex::new(None),
        })
    }

    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }

    pub(crate) fn prepare_blob(
        &self,
        reader: &mut impl Read,
        expected: Option<&Digest>,
        cancellation: &CancellationToken,
    ) -> Result<PreparedBlob, Error> {
        let prepared = self
            .blobs
            .prepare(reader, expected.map(digest_bytes), cancellation)?;
        Ok(self.prepared_blob(prepared))
    }

    fn prepared_blob(&self, prepared: blob::Prepared) -> PreparedBlob {
        let digest = Digest::try_new(format!("sha256:{}", blob::digest_name(&prepared.digest)))
            .expect("SHA-256 produces a protocol digest");
        PreparedBlob {
            world: self.world.clone(),
            reference: BlobRef {
                digest,
                byte_size: prepared.byte_size,
            },
            staged: prepared,
        }
    }

    /// Removes only this upload's private stage, never a published/shared content name.
    pub(crate) fn discard_prepared(&self, prepared: &PreparedBlob) -> Result<(), Error> {
        self.check_world(&prepared.world)?;
        self.blobs.discard(&prepared.staged).map_err(Into::into)
    }

    /// Revalidate a concurrent publisher outside SQL before retrying this upload's registration.
    pub(crate) fn refresh_prepared(&self, prepared: &mut PreparedBlob) -> Result<(), Error> {
        self.check_world(&prepared.world)?;
        self.blobs.refresh(&mut prepared.staged).map_err(Into::into)
    }

    /// Register a durable blob and its owner reference in the caller's single world transaction.
    pub(crate) async fn retain_prepared(
        &self,
        transaction: &crate::store::WorldTransaction<'_>,
        prepared: &PreparedBlob,
        owner: ContentOwner,
    ) -> Result<ContentReference, Error> {
        self.check_world(transaction.world())?;
        retention::register_blob(self, transaction, prepared).await?;
        let reference = ContentReference::new(owner, prepared.reference.clone())?;
        retention::retain(transaction, &reference).await?;
        Ok(reference)
    }

    /// Protect prepared bytes across upload/recovery/backup work; expiry is not a release.
    pub(crate) async fn pin_prepared(
        &self,
        transaction: &crate::store::WorldTransaction<'_>,
        prepared: &PreparedBlob,
        owner: ContentOwner,
        id: ContentId,
        kind: PinKind,
    ) -> Result<BlobPin, Error> {
        self.check_world(transaction.world())?;
        retention::register_blob(self, transaction, prepared).await?;
        let generation = retention::lock_live_blob(transaction, &prepared.reference).await?;
        retention::pin_registered(
            transaction,
            &prepared.reference,
            owner,
            id,
            kind,
            generation,
        )
        .await
    }

    /// Revalidate a confirmed pin in a short readonly snapshot, then read outside SQL custody.
    pub(crate) async fn read_pinned(
        &self,
        store: &crate::store::WorldStore,
        committed: &Committed<BlobPin>,
    ) -> Result<Vec<u8>, Error> {
        let pin = &committed.value;
        if pin.world != self.world || committed.receipt.world != self.world {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        // The filesystem custody gate excludes cleanup even if the caller releases its DB pin now.
        let _physical = self.blobs.lock()?;
        let current = pin.clone();
        store
            .snapshot(self.world.clone(), move |snapshot| {
                Box::pin(async move { retention::validate_pin_snapshot(snapshot, &current).await })
            })
            .await?;
        self.blobs
            .read_locked(&digest_bytes(&pin.blob.digest), pin.blob.byte_size)
            .map_err(Into::into)
    }

    /// The claim is exclusive and remains durable until finish_deletion confirms physical cleanup.
    pub(crate) async fn remove_claimed(
        &self,
        store: &crate::store::WorldStore,
        committed: &Committed<DeletionClaim>,
    ) -> Result<CleanupResult, Error> {
        if committed.value.world != self.world || committed.receipt.world != self.world {
            return Err(Error::material(MaterialFailure::InputInvalid));
        }
        let _physical = self.blobs.lock()?;
        let claim = committed.value.clone();
        store
            .snapshot(self.world.clone(), move |snapshot| {
                Box::pin(async move {
                    retention::validate_claim_snapshot(snapshot, &claim).await?;
                    cleanup::require_unretained_snapshot(snapshot, &claim.blob).await
                })
            })
            .await?;
        Ok(CleanupResult {
            claim: committed.value.clone(),
            result: self
                .blobs
                .remove_locked(&digest_bytes(&committed.value.blob.digest))
                .map_err(Into::into),
        })
    }

    fn check_world(&self, world: &WorldRef) -> Result<(), Error> {
        if world == &self.world {
            Ok(())
        } else {
            Err(Error::material(MaterialFailure::InputInvalid))
        }
    }
}

fn digest_bytes(digest: &Digest) -> [u8; 32] {
    let hex = &digest.as_str().as_bytes()[7..];
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let digit = |value: u8| {
            if value.is_ascii_digit() {
                value - b'0'
            } else {
                value - b'a' + 10
            }
        };
        *byte = digit(hex[index * 2]) * 16 + digit(hex[index * 2 + 1]);
    }
    bytes
}

fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(|cause| Error::caused(MaterialFailure::InputInvalid, cause))
}

fn decode<T: for<'de> Deserialize<'de>>(value: serde_json::Value) -> Result<T, Error> {
    serde_json::from_value(value)
        .map_err(|cause| Error::caused(MaterialFailure::CorruptContent, cause))
}

fn stable_id(value: &impl Serialize) -> Result<ContentId, Error> {
    let bytes = serde_json::to_vec(value)
        .map_err(|cause| Error::caused(MaterialFailure::InputInvalid, cause))?;
    Ok(
        ContentId::try_new(blob::digest_name(&Sha256::digest(bytes).into()))
            .expect("bounded digest identifier"),
    )
}
