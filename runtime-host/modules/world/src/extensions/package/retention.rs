use world_protocol::{ids::*, package::PackageFailure};

use super::PackageError;
use crate::store::{WorldSnapshot, WorldTransaction};

#[derive(Clone, Copy)]
pub(crate) enum RetentionOwner<'a> {
    InstallLock(&'a InstallId),
    ActivationLock(&'a ActivationLockId),
    Run(&'a RunId),
    Step(&'a StepId),
    Release(&'a ReleaseId),
    Migration(&'a MigrationId),
    State(&'a StateRootId),
}

impl RetentionOwner<'_> {
    fn key(&self) -> (&'static str, &str) {
        match self {
            Self::InstallLock(id) => ("install_lock", id.as_str()),
            Self::ActivationLock(id) => ("activation_lock", id.as_str()),
            Self::Run(id) => ("run", id.as_str()),
            Self::Step(id) => ("step", id.as_str()),
            Self::Release(id) => ("release", id.as_str()),
            Self::Migration(id) => ("migration", id.as_str()),
            Self::State(id) => ("state", id.as_str()),
        }
    }
}

/// Called in the owner's transaction before publishing a durable reference.
/// A released owner/revision is immutable: republishing requires a new owner identity or revision.
pub(crate) async fn retain_packages(
    tx: &WorldTransaction<'_>,
    owner: RetentionOwner<'_>,
    revision: Revision,
    packages: &[Digest],
) -> Result<(), PackageError> {
    let number = i64::try_from(revision.0)
        .map_err(|_| PackageError::new(PackageFailure::InstallConflict))?;
    let (kind, id) = owner.key();
    let world = tx.world();
    let ordered: std::collections::BTreeSet<_> = packages.iter().collect();
    for package in ordered {
        let gc = tx.query_opt("SELECT state FROM world_package_gc WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 FOR UPDATE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str()]).await?;
        if gc.is_none_or(|row| row.get::<_, String>("state") != "live") {
            return Err(PackageError::new(PackageFailure::RetainedReferences));
        }
        tx.execute("INSERT INTO world_package_retention(tenant_id,world_id,package_digest,owner_kind,owner_id,owner_revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str(), &kind, &id, &number]).await?;
    }
    require_retained_packages(tx, owner, revision, packages).await
}

/// Existing-reference proof, never an insert: a retired graph cannot be revived under a new owner.
pub(crate) async fn require_retained_packages(
    tx: &WorldTransaction<'_>,
    owner: RetentionOwner<'_>,
    revision: Revision,
    packages: &[Digest],
) -> Result<(), PackageError> {
    let revision = i64::try_from(revision.0)
        .map_err(|_| PackageError::new(PackageFailure::InstallConflict))?;
    let (kind, id) = owner.key();
    let world = tx.world();
    let ordered: std::collections::BTreeSet<_> = packages.iter().collect();
    for package in ordered {
        let live = tx.query_opt("SELECT 1 FROM world_package_retention WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND owner_kind=$4 AND owner_id=$5 AND owner_revision=$6 AND released_at IS NULL FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str(), &kind, &id, &revision]).await?.is_some();
        if !live {
            return Err(PackageError::new(PackageFailure::RetainedReferences));
        }
    }
    Ok(())
}

/// Read-only custody check; it cannot mint a reference or revive a released owner.
pub(crate) async fn require_retained_packages_snapshot(
    snapshot: &WorldSnapshot<'_>,
    owner: RetentionOwner<'_>,
    revision: Revision,
    packages: &[Digest],
) -> Result<(), PackageError> {
    let revision = i64::try_from(revision.0)
        .map_err(|_| PackageError::new(PackageFailure::InstallConflict))?;
    let (kind, id) = owner.key();
    let world = snapshot.world();
    let ordered: std::collections::BTreeSet<_> = packages.iter().collect();
    for package in ordered {
        if snapshot.query_opt("SELECT 1 FROM world_package_retention WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND owner_kind=$4 AND owner_id=$5 AND owner_revision=$6 AND released_at IS NULL",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str(), &kind, &id, &revision]).await?.is_none() {
            return Err(PackageError::new(PackageFailure::RetainedReferences));
        }
    }
    Ok(())
}

/// Only the reference owner decides when its exact durable references can be released.
/// This never deletes facts, locks, operations, package metadata or payloads.
pub(crate) async fn release_packages(
    tx: &WorldTransaction<'_>,
    owner: RetentionOwner<'_>,
    revision: Revision,
    packages: &[Digest],
) -> Result<(), PackageError> {
    let revision = i64::try_from(revision.0)
        .map_err(|_| PackageError::new(PackageFailure::InstallConflict))?;
    let (kind, id) = owner.key();
    let world = tx.world();
    let ordered: std::collections::BTreeSet<_> = packages.iter().collect();
    for package in ordered {
        tx.execute("UPDATE world_package_retention SET released_at=clock_timestamp() WHERE tenant_id=$1 AND world_id=$2 AND package_digest=$3 AND owner_kind=$4 AND owner_id=$5 AND owner_revision=$6 AND released_at IS NULL",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &package.as_str(), &kind, &id, &revision]).await?;
    }
    Ok(())
}
