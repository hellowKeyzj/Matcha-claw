use std::{path::Path, sync::Arc};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    bindings::ImplementationRef,
    commit::{CommitFailure, WriteFence},
    failure::FailureStage,
    ids::*,
    operation::{OperationAccepted, OperationReceipt},
    package::{InstalledRecord, PackageArtifact, PackageFailure},
    time::Timestamp,
};

use super::{
    error::PackageError,
    payload::{PackageReadLimits, VerifiedPayload},
    storage::{ArtifactLease, PackageFiles},
};
use crate::store::{CommitRequest, Committed, StoreError, WorldStore};

/// All installation and reclamation uses the same private inventory and PostgreSQL authority.
pub struct Inventory {
    pub(super) store: WorldStore,
    pub(super) world: WorldRef,
    pub(super) files: Arc<PackageFiles>,
    pub(super) limits: PackageReadLimits,
    // Serializes physical publication and GC claims; runtime leases pin independently.
    pub(super) mutation: Mutex<()>,
    pub(super) cleanup: Mutex<Option<super::cleanup::CleanupCustody>>,
}

pub(crate) struct InstallContext {
    pub admission: crate::authorization::Admission,
    pub accepted: OperationAccepted,
    pub storage_epoch: WriterEpoch,
    pub fences: Vec<WriteFence>,
    pub at: Timestamp,
}

impl Inventory {
    pub fn open(
        store: WorldStore,
        world: WorldRef,
        root: &Path,
        limits: PackageReadLimits,
    ) -> Result<Self, PackageError> {
        if limits.transport_bytes == 0
            || limits.transport_bytes > usize::MAX as u64
            || limits.expanded_bytes > usize::MAX as u64
            || limits.manifest_bytes == 0
            || limits.entries == 0
        {
            return Err(PackageError::new(PackageFailure::ArchiveLimit));
        }
        let files = PackageFiles::open(root)?;
        files.bind_world(&world)?;
        Ok(Self {
            store,
            world,
            files,
            limits,
            mutation: Mutex::new(()),
            cleanup: Mutex::new(None),
        })
    }

    pub(crate) fn validate_input_size(
        &self,
        blob: &world_protocol::materials::BlobRef,
    ) -> Result<(), PackageError> {
        if blob.byte_size == 0 || blob.byte_size > self.limits.transport_bytes {
            return Err(PackageError::new(PackageFailure::ArchiveLimit));
        }
        Ok(())
    }

    pub async fn lookup(
        &self,
        world: &WorldRef,
        install: &InstallId,
        package: &Digest,
    ) -> Result<InstalledRecord, PackageError> {
        self.require_world(world)?;
        let install = install.clone();
        let package = package.clone();
        self.store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let row = snapshot.query_opt(
                "SELECT phase,package_digest,body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND install_id=$3",
                &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &install.as_str()],
            ).await?;
            let Some(row) = row else { return Ok(Err(PackageFailure::InstallConflict)); };
            if row.get::<_, String>("phase") != "installed" || row.get::<_, Option<String>>("package_digest").as_deref() != Some(package.as_str()) {
                return Ok(Err(PackageFailure::InstallConflict));
            }
            Ok(serde_json::from_value::<InstalledRecord>(row.get("body")).map_err(|_| PackageFailure::InternalFault))
        })).await.map_err(store_error)?.map_err(PackageError::new)
    }

    pub async fn list(&self, world: &WorldRef) -> Result<Vec<InstalledRecord>, PackageError> {
        self.require_world(world)?;
        self.store.snapshot(world.clone(), |snapshot| Box::pin(async move {
            let rows = snapshot.query(
                "SELECT body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND phase='installed' ORDER BY install_id",
                &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()],
            ).await?;
            rows.iter().map(|row| serde_json::from_value(row.get("body"))
                .map_err(|cause| StoreError::caused_by(CommitFailure::InternalFault, FailureStage::Read, cause))).collect()
        })).await.map_err(store_error)
    }

    pub async fn artifact(
        &self,
        world: &WorldRef,
        implementation: &ImplementationRef,
        at: Timestamp,
        cancellation: &CancellationToken,
    ) -> Result<ArtifactLease, PackageError> {
        let _mutation = self.mutation.lock().await;
        let (payload, artifact) = self
            .verified_artifact(world, implementation, at, cancellation)
            .await?;
        self.files.artifact(&payload, &artifact, cancellation)
    }

    async fn verified_artifact(
        &self,
        world: &WorldRef,
        implementation: &ImplementationRef,
        at: Timestamp,
        cancellation: &CancellationToken,
    ) -> Result<(VerifiedPayload, PackageArtifact), PackageError> {
        let record = self
            .lookup(
                world,
                &implementation.install_id,
                &implementation.package_digest,
            )
            .await?;
        let artifact = record
            .manifest
            .artifacts
            .iter()
            .find(|artifact| artifact.id == implementation.artifact_id)
            .filter(|artifact| {
                artifact.digest == implementation.artifact_digest
                    && artifact.entrypoint == implementation.entrypoint
            })
            .ok_or_else(|| {
                PackageError::new(PackageFailure::ArtifactInvalid {
                    artifact_id: implementation.artifact_id.clone(),
                })
            })?;
        if record.lock.digest != implementation.dependency_lock
            || !implementation.contracts.iter().all(|reference| {
                record
                    .manifest
                    .contracts
                    .iter()
                    .any(|contract| &contract.reference == reference)
            })
        {
            return Err(PackageError::new(PackageFailure::InstallConflict));
        }
        self.require_live(world, &record.package_digest).await?;
        let current = implementation.clone();
        self.store
            .snapshot(world.clone(), move |snapshot| {
                Box::pin(async move {
                    super::read_package_grants(snapshot, &current)
                        .await
                        .map(|_| ())
                })
            })
            .await?;
        let payload = self.files.read(
            &record.package_digest,
            &record.transport_digest,
            &self.limits,
            cancellation,
        )?;
        let policy = self.trust_policy(world).await?;
        payload.verify_trust(&policy, at)?;
        if payload.manifest != record.manifest {
            return Err(PackageError::new(PackageFailure::InstallConflict));
        }
        Ok((payload, artifact.clone()))
    }

    pub(super) async fn require_live(
        &self,
        world: &WorldRef,
        package: &Digest,
    ) -> Result<(), PackageError> {
        let package = package.clone();
        let live = self.store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
            let row = snapshot.query_opt(
                "SELECT g.state,t.trusted,t.quarantined FROM world_package_gc g JOIN world_extension_trust t USING(tenant_id,world_id,package_digest) WHERE g.tenant_id=$1 AND g.world_id=$2 AND g.package_digest=$3",
                &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &package.as_str()],
            ).await?;
            Ok(row.is_some_and(|row| row.get::<_, String>("state") == "live" && row.get::<_, bool>("trusted") && !row.get::<_, bool>("quarantined")))
        })).await.map_err(store_error)?;
        if live {
            Ok(())
        } else {
            Err(PackageError::new(PackageFailure::PublisherUntrusted))
        }
    }

    pub(crate) async fn lock_transfer_publication(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.mutation.lock().await
    }

    pub(super) fn require_world(&self, world: &WorldRef) -> Result<(), PackageError> {
        if &self.world == world {
            Ok(())
        } else {
            Err(PackageError::new(PackageFailure::InstallConflict))
        }
    }

    pub(super) fn commit_request(
        context: &InstallContext,
        commit_id: CommitId,
        input_digest: Digest,
    ) -> Result<crate::store::PreparedBatch, PackageError> {
        if ["packages", "operation"].iter().any(|domain| {
            !context
                .fences
                .iter()
                .any(|fence| fence.domain.as_str() == *domain)
        }) {
            return Err(PackageError::new(PackageFailure::Commit {
                failure: CommitFailure::InvalidBatch,
            }));
        }
        CommitRequest {
            world: context.accepted.world.clone(),
            commit_id,
            input_digest,
            storage_epoch: context.storage_epoch,
            fences: context.fences.clone(),
            watch_basis: Vec::new(),
        }
        .prepare()
        .map_err(store_error)
    }

    pub async fn read_install_commit(
        &self,
        world: &WorldRef,
        commit: &CommitId,
        input: &Digest,
    ) -> Result<OperationReceipt, PackageError> {
        self.require_world(world)?;
        let committed: Committed<OperationReceipt> = self
            .store
            .read_commit(world, commit, input)
            .await
            .map_err(store_error)?;
        let mut receipt = committed.value;
        receipt.commit = Some(committed.receipt);
        Ok(receipt)
    }
}

pub(super) fn store_error(error: StoreError) -> PackageError {
    PackageError::caused(
        PackageFailure::Commit {
            failure: error.reason.clone(),
        },
        error,
    )
}

pub(super) fn encode(value: &impl serde::Serialize) -> Result<serde_json::Value, StoreError> {
    serde_json::to_value(value).map_err(|cause| {
        StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, cause)
    })
}
