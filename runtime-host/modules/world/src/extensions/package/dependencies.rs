use std::collections::BTreeMap;

use world_protocol::{
    ids::{PackageId, PublisherId},
    package::{InstallLock, InstalledRecord, LockedArtifact, LockedPackage, PackageFailure},
    sources::ContractRef,
};

use super::{error::PackageError, payload::VerifiedPayload};

pub(super) fn resolve(
    payload: &VerifiedPayload,
    inventory: &[InstalledRecord],
) -> Result<InstallLock, PackageError> {
    let mut selected = BTreeMap::new();
    for dependency in &payload.manifest.dependencies {
        select(dependency, inventory, &mut selected)?;
    }
    if selected.contains_key(&(
        payload.manifest.identity.publisher.clone(),
        payload.manifest.identity.id.clone(),
    )) {
        return Err(PackageError::new(PackageFailure::DependencyCycle));
    }
    let mut contracts: Vec<ContractRef> = payload
        .manifest
        .contracts
        .iter()
        .map(|contract| contract.reference.clone())
        .collect();
    for dependency in selected.values() {
        contracts.extend(
            dependency
                .manifest
                .contracts
                .iter()
                .map(|contract| contract.reference.clone()),
        );
    }
    for requirement in &payload.manifest.requires {
        let matches = payload
            .manifest
            .contracts
            .iter()
            .chain(
                selected
                    .values()
                    .flat_map(|record| record.manifest.contracts.iter()),
            )
            .any(|contract| {
                contract.reference.id == requirement.id
                    && semver::Version::parse(&contract.reference.version)
                        .is_ok_and(|version| requirement.version.matches(&version))
                    && contract.request_schema.digest == requirement.request_schema
                    && contract.result_schema.digest == requirement.result_schema
            });
        // Host service contracts are resolved by the typed activation graph, not installed from the network.
        if !matches
            && selected.values().any(|record| {
                record
                    .manifest
                    .contracts
                    .iter()
                    .any(|contract| contract.reference.id == requirement.id)
            })
        {
            return Err(PackageError::new(PackageFailure::ContractMismatch {
                contract_id: requirement.id.clone(),
            }));
        }
    }
    contracts.sort_by(|left, right| {
        (&left.id, &left.version, &left.schema_digest).cmp(&(
            &right.id,
            &right.version,
            &right.schema_digest,
        ))
    });
    contracts.dedup();
    let mut packages = vec![LockedPackage {
        identity: payload.manifest.identity.clone(),
        package_digest: payload.package_digest.clone(),
        transport_digest: payload.transport_digest.clone(),
    }];
    let mut artifacts: Vec<_> = payload
        .manifest
        .artifacts
        .iter()
        .map(|artifact| LockedArtifact {
            package_digest: payload.package_digest.clone(),
            artifact_id: artifact.id.clone(),
            digest: artifact.digest.clone(),
            target: artifact.target.clone(),
        })
        .collect();
    for record in selected.values() {
        packages.push(LockedPackage {
            identity: record.manifest.identity.clone(),
            package_digest: record.package_digest.clone(),
            transport_digest: record.transport_digest.clone(),
        });
        artifacts.extend(
            record
                .manifest
                .artifacts
                .iter()
                .map(|artifact| LockedArtifact {
                    package_digest: record.package_digest.clone(),
                    artifact_id: artifact.id.clone(),
                    digest: artifact.digest.clone(),
                    target: artifact.target.clone(),
                }),
        );
    }
    packages.sort_by(|left, right| {
        (
            &left.identity.publisher,
            &left.identity.id,
            &left.identity.version,
        )
            .cmp(&(
                &right.identity.publisher,
                &right.identity.id,
                &right.identity.version,
            ))
    });
    artifacts.sort_by(|left, right| {
        (&left.package_digest, &left.artifact_id).cmp(&(&right.package_digest, &right.artifact_id))
    });
    let digest = world_protocol::package::install_lock_digest(&packages, &contracts, &artifacts)
        .map_err(PackageError::new)?;
    Ok(InstallLock {
        digest,
        packages,
        contracts,
        artifacts,
    })
}

fn select<'a>(
    dependency: &world_protocol::package::PackageDependency,
    inventory: &'a [InstalledRecord],
    selected: &mut BTreeMap<(PublisherId, PackageId), &'a InstalledRecord>,
) -> Result<(), PackageError> {
    let key = (dependency.publisher.clone(), dependency.id.clone());
    let matches = |record: &&InstalledRecord| {
        record.manifest.identity.publisher == dependency.publisher
            && record.manifest.identity.id == dependency.id
            && dependency
                .version
                .matches(&record.manifest.identity.version)
            && dependency
                .digest
                .as_ref()
                .is_none_or(|digest| digest == &record.package_digest)
    };
    let record = if let Some(record) = selected.get(&key) {
        if !matches(record) {
            return Err(PackageError::new(PackageFailure::DependencyConflict {
                package_id: dependency.id.clone(),
            }));
        }
        *record
    } else {
        let mut candidates = inventory.iter().filter(matches);
        let candidate = candidates.next().ok_or_else(|| {
            PackageError::new(PackageFailure::DependencyMissing {
                package_id: dependency.id.clone(),
            })
        })?;
        if candidates.any(|other| other.package_digest != candidate.package_digest) {
            return Err(PackageError::new(PackageFailure::DependencyConflict {
                package_id: dependency.id.clone(),
            }));
        }
        candidate
    };
    if world_protocol::package::install_lock_digest(
        &record.lock.packages,
        &record.lock.contracts,
        &record.lock.artifacts,
    )
    .map_err(PackageError::new)?
        != record.lock.digest
        || !record.lock.packages.iter().any(|locked| {
            locked.identity == record.manifest.identity
                && locked.package_digest == record.package_digest
                && locked.transport_digest == record.transport_digest
        })
    {
        return Err(PackageError::new(PackageFailure::InstallConflict));
    }
    // An installed lock is already the full closure; never resolve its version ranges again.
    for locked in &record.lock.packages {
        let exact = inventory
            .iter()
            .find(|candidate| {
                candidate.manifest.identity == locked.identity
                    && candidate.package_digest == locked.package_digest
                    && candidate.transport_digest == locked.transport_digest
            })
            .ok_or_else(|| {
                PackageError::new(PackageFailure::DependencyMissing {
                    package_id: locked.identity.id.clone(),
                })
            })?;
        let key = (
            locked.identity.publisher.clone(),
            locked.identity.id.clone(),
        );
        if selected.get(&key).is_some_and(|previous| {
            previous.package_digest != locked.package_digest
                || previous.transport_digest != locked.transport_digest
        }) {
            return Err(PackageError::new(PackageFailure::DependencyConflict {
                package_id: locked.identity.id.clone(),
            }));
        }
        selected.insert(key, exact);
    }
    Ok(())
}
