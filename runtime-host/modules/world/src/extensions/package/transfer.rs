use std::collections::{BTreeMap, BTreeSet};

use platform::state_dir::CanonicalStateDir;
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::{Digest, WorldRef},
    package::{InstalledRecord, PackageFailure, PackageManifest},
};

use super::{Inventory, PackageError, VerifiedPayload, payload::check_cancelled};
use crate::store::{TransferCut, WorldSnapshot};

pub(crate) struct PackageTransferPlan {
    cut: TransferCut,
    packages: Vec<(Digest, Digest)>,
}

/// Real full-byte validation, bound to the target's private directory identity and exact catalog.
pub(crate) struct PackageTransferValidation {
    cut: TransferCut,
    root: CanonicalStateDir,
    catalog: Digest,
}
impl PackageTransferValidation {
    pub(crate) fn matches(&self, cut: &TransferCut, inventory: &Inventory) -> bool {
        &self.cut == cut && inventory.world == cut.world && &self.root == inventory.files.identity()
    }
    pub(crate) fn matches_catalog(&self, packages: &[(Digest, Digest)]) -> bool {
        self.catalog == catalog_digest(packages)
    }
}

impl Inventory {
    pub(crate) async fn prepare_transfer(
        &self,
        snapshot: &WorldSnapshot<'_>,
        cut: &TransferCut,
    ) -> Result<PackageTransferPlan, PackageError> {
        self.require_world(snapshot.world())?;
        self.require_world(&cut.world)?;
        let row = snapshot.query_opt(
            "SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2",
            &[&cut.world.tenant_id.as_str(), &cut.world.world_id.as_str()],
        ).await?.ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
        if row.get::<_, String>("storage_id") != cut.source_storage_id
            || row.get::<_, i64>("writer_epoch") as u64 != cut.source_epoch.0
            || row.get::<_, String>("mode") != "fenced"
            || row.get::<_, Option<String>>("transfer_id").as_deref()
                != Some(cut.transfer_id.as_str())
        {
            return Err(PackageError::new(PackageFailure::InstallConflict));
        }
        let packages = snapshot.package_catalog().await?;
        Ok(PackageTransferPlan {
            cut: cut.clone(),
            packages,
        })
    }

    pub(crate) async fn copy_transfer(
        &self,
        plan: &PackageTransferPlan,
        target: &Inventory,
        target_content: &crate::content::Content,
        cancellation: &CancellationToken,
    ) -> Result<PackageTransferValidation, PackageError> {
        self.require_world(&plan.cut.world)?;
        target.require_world(&plan.cut.world)?;
        if self.files.identity() == target.files.identity() {
            return Err(PackageError::new(PackageFailure::InstallConflict));
        }
        let _source = self.mutation.lock().await;
        let _target = target.mutation.lock().await;
        for (package, transport) in &plan.packages {
            check_cancelled(cancellation)?;
            let bytes = self.files.read_transport(
                package,
                transport,
                self.limits.transport_bytes as usize,
            )?;
            let payload = VerifiedPayload::read(&bytes, &target.limits, cancellation)?;
            if payload.package_digest != *package || payload.transport_digest != *transport {
                return Err(PackageError::new(PackageFailure::DigestMismatch {
                    path: "package.json".into(),
                }));
            }
            // Activation and abort take this same physical gate before changing prepared state.
            let _publication = target_content
                .lock_transfer_publication()
                .map_err(|cause| PackageError::caused(PackageFailure::IoWrite, cause))?;
            let cut = plan.cut.clone();
            target.store.snapshot(cut.world.clone(), move |snapshot| Box::pin(async move {
                let row = snapshot.query_opt("SELECT storage_id,writer_epoch,mode,transfer_id FROM world_storage_head WHERE tenant_id=$1 AND world_id=$2", &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str()]).await?
                    .ok_or_else(|| PackageError::new(PackageFailure::InstallConflict))?;
                if row.get::<_, String>("storage_id") != cut.target_storage_id || row.get::<_, i64>("writer_epoch") as u64 != cut.target_epoch.0
                    || row.get::<_, String>("mode") != "prepared" || row.get::<_, Option<String>>("transfer_id").as_deref() != Some(cut.transfer_id.as_str()) {
                    return Err(PackageError::new(PackageFailure::InstallConflict));
                }
                Ok::<_, PackageError>(())
            })).await?;
            target.files.publish(
                &payload,
                &bytes,
                target.limits.transport_bytes as usize,
                cancellation,
            )?;
            target
                .files
                .read(package, transport, &target.limits, cancellation)?;
        }
        Ok(PackageTransferValidation {
            cut: plan.cut.clone(),
            root: target.files.identity().clone(),
            catalog: catalog_digest(&plan.packages),
        })
    }
}

/// Sole typed decoder for the immutable package rows and historical install transport references.
/// Physical bytes and current execution trust are checked separately by the inventory.
pub(crate) fn catalog_from_rows(
    package_rows: &[serde_json::Value],
    install_rows: &[serde_json::Value],
    gc_rows: &[serde_json::Value],
    world: &WorldRef,
) -> Result<Vec<(Digest, Digest)>, PackageError> {
    #[derive(serde::Deserialize)]
    struct PackageRow {
        tenant_id: world_protocol::ids::TenantId,
        world_id: world_protocol::ids::WorldId,
        publisher_id: world_protocol::ids::PublisherId,
        package_id: world_protocol::ids::PackageId,
        version: String,
        package_digest: Digest,
        transport_digest: Digest,
        manifest: PackageManifest,
    }
    #[derive(serde::Deserialize)]
    struct GcRow {
        tenant_id: world_protocol::ids::TenantId,
        world_id: world_protocol::ids::WorldId,
        package_digest: Digest,
        state: String,
    }
    #[derive(serde::Deserialize)]
    struct InstallRow {
        tenant_id: world_protocol::ids::TenantId,
        world_id: world_protocol::ids::WorldId,
        install_id: world_protocol::ids::InstallId,
        package_digest: Option<Digest>,
        revision: i64,
        phase: String,
        pending_removal: bool,
        body: serde_json::Value,
    }
    let invalid = || PackageError::new(PackageFailure::InstallConflict);
    let decode = |cause| PackageError::caused(PackageFailure::InstallConflict, cause);
    let mut gc = BTreeMap::new();
    for row in gc_rows {
        let row: GcRow = serde_json::from_value(row.clone()).map_err(decode)?;
        if row.tenant_id != world.tenant_id
            || row.world_id != world.world_id
            || !matches!(
                row.state.as_str(),
                "live" | "claimed" | "pending_removal" | "removed"
            )
            || gc.insert(row.package_digest, row.state).is_some()
        {
            return Err(invalid());
        }
    }
    let mut packages = BTreeMap::new();
    let mut catalog = BTreeSet::new();
    for row in package_rows {
        let row: PackageRow = serde_json::from_value(row.clone()).map_err(decode)?;
        if row.tenant_id != world.tenant_id
            || row.world_id != world.world_id
            || row.publisher_id != row.manifest.identity.publisher
            || row.package_id != row.manifest.identity.id
            || row.version != row.manifest.identity.version.to_string()
        {
            return Err(invalid());
        }
        match gc.get(&row.package_digest).map(String::as_str) {
            Some("live") => {
                catalog.insert((row.package_digest.clone(), row.transport_digest));
            }
            Some("removed") => {}
            Some(_) => return Err(PackageError::new(PackageFailure::RetainedReferences)),
            None => return Err(invalid()),
        }
        if packages.insert(row.package_digest, row.manifest).is_some() {
            return Err(invalid());
        }
    }
    for row in install_rows {
        let row: InstallRow = serde_json::from_value(row.clone()).map_err(decode)?;
        if row.tenant_id != world.tenant_id || row.world_id != world.world_id {
            return Err(invalid());
        }
        if row.phase != "installed" || row.pending_removal {
            continue;
        }
        let record: InstalledRecord = serde_json::from_value(row.body).map_err(decode)?;
        if &record.world != world
            || record.install_id != row.install_id
            || record.revision.0 == 0
            || i64::try_from(record.revision.0).ok() != Some(row.revision)
            || row.package_digest.as_ref() != Some(&record.package_digest)
            || packages.get(&record.package_digest) != Some(&record.manifest)
            || gc.get(&record.package_digest).map(String::as_str) != Some("live")
        {
            return Err(invalid());
        }
        catalog.insert((record.package_digest, record.transport_digest));
    }
    if catalog.len() > 4096 {
        return Err(PackageError::new(PackageFailure::ArchiveLimit));
    }
    Ok(catalog.into_iter().collect())
}

pub(super) fn catalog_digest(packages: &[(Digest, Digest)]) -> Digest {
    let mut hash = Sha256::new();
    hash.update(b"matcha.world-package-transfer/1\n");
    for (package, transport) in packages {
        hash.update(package.as_str().as_bytes());
        hash.update(transport.as_str().as_bytes());
    }
    Digest::try_new(format!("sha256:{:x}", hash.finalize())).expect("SHA256 digest syntax")
}
