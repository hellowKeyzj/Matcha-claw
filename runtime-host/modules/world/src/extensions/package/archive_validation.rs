use platform::state_dir::CanonicalStateDir;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    ids::{Digest, WorldRef},
    package::PackageFailure,
};

use super::{Inventory, PackageError, payload::check_cancelled};
use crate::store::ArchiveSnapshot;

/// Physical byte evidence only; restoration still requires current authority and catalog locks.
pub(crate) struct PackageArchiveValidation {
    world: WorldRef,
    storage: String,
    snapshot: Digest,
    root: CanonicalStateDir,
    catalog: Digest,
}

impl PackageArchiveValidation {
    pub(crate) fn matches(&self, snapshot: &ArchiveSnapshot, inventory: &Inventory) -> bool {
        &self.world == snapshot.world()
            && &inventory.world == snapshot.world()
            && self.storage == snapshot.storage_id()
            && self.storage == inventory.store.identity_receipt().storage_id()
            && &self.snapshot == snapshot.digest()
            && &self.root == inventory.files.identity()
    }
    pub(crate) fn matches_catalog(&self, catalog: &[(Digest, Digest)]) -> bool {
        self.catalog == super::transfer::catalog_digest(catalog)
    }
}

impl Inventory {
    pub(crate) async fn validate_archive(
        &self,
        snapshot: &ArchiveSnapshot,
        cancellation: &CancellationToken,
    ) -> Result<PackageArchiveValidation, PackageError> {
        let _mutation = self.mutation.lock().await;
        self.require_world(snapshot.world())?;
        if snapshot.storage_id() != self.store.identity_receipt().storage_id()
            || snapshot
                .package_catalog()
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
        {
            return Err(PackageError::new(PackageFailure::InstallConflict));
        }
        for (package, transport) in snapshot.package_catalog() {
            check_cancelled(cancellation)?;
            // This reads the exact durable ZIP, verifies its transport hash and validates
            // raw package.json, every declared payload and the complete ZIP structure.
            self.files
                .read(package, transport, &self.limits, cancellation)?;
        }
        check_cancelled(cancellation)?;
        Ok(PackageArchiveValidation {
            world: snapshot.world().clone(),
            storage: snapshot.storage_id().to_owned(),
            snapshot: snapshot.digest().clone(),
            root: self.files.identity().clone(),
            catalog: super::transfer::catalog_digest(snapshot.package_catalog()),
        })
    }
}
