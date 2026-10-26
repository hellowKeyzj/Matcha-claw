use super::Error;
use crate::{
    authorization::Admission,
    extensions::invocation::CallBudget,
    store::{StoreFuture, WorldTransaction},
};
use std::collections::BTreeSet;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    evaluation::BranchBasis,
    ids::ResourceRef,
    provenance::ReadDependency,
    releases::{ReleaseFailure, WorldBranch},
    time::Timestamp,
};

/// Checks only the actual affected basis. A world-wide revision never substitutes for it.
pub(super) fn recheck<'a>(
    tx: &'a WorldTransaction<'_>,
    admission: &'a Admission,
    branch: &'a WorldBranch,
    budget: &'a CallBudget,
    cancellation: &'a CancellationToken,
    now: &'a Timestamp,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let basis = &branch.basis;
        let captures =
            crate::sources::sync::read_branch_sources(tx, admission, branch, budget, cancellation)
                .await?;
        let mut receipts = BTreeSet::new();
        let mut sources = BTreeSet::new();
        for source in &basis.sources {
            if !sources.insert((
                source.source_id.clone(),
                source
                    .position
                    .as_ref()
                    .map(|position| position.partition.clone()),
            )) {
                return Err(changed(vec![ResourceRef::Source {
                    id: source.source_id.clone(),
                }]));
            }
            if !captures
                .iter()
                .any(|capture| &capture.capture().basis == source)
            {
                crate::sources::sync::recheck_basis(tx, source).await?;
            }
        }
        let mut actual_snapshots = Vec::new();
        for source in &basis.sources {
            if let Some(capture) = captures
                .iter()
                .find(|capture| &capture.capture().basis == source)
            {
                let blob = &capture.source_version().blob;
                if !actual_snapshots.contains(blob) {
                    actual_snapshots.push(blob.clone());
                }
            } else if source.snapshot.is_some() {
                for version in crate::sources::sync::snapshot_materials(tx, source).await? {
                    if !actual_snapshots.contains(&version.blob) {
                        actual_snapshots.push(version.blob);
                    }
                }
            }
        }
        if basis.snapshots.len() != actual_snapshots.len()
            || basis.snapshots.iter().any(|blob| {
                actual_snapshots
                    .iter()
                    .filter(|actual| *actual == blob)
                    .count()
                    != 1
            })
        {
            return Err(changed(Vec::new()));
        }
        for receipt in &basis.read_receipts {
            if receipt.world != *tx.world()
                || receipt.release_id != basis.release_id
                || receipt.activation_lock_id != basis.activation_lock_id
                || !receipts.insert(&receipt.id)
                || crate::query::read_receipt(tx, &receipt.id).await? != *receipt
                || receipt
                    .expires_at
                    .as_ref()
                    .is_some_and(|expires| now >= expires)
                || receipt.policy_epoch != admission.decision().policy_epoch
                || receipt.grant_epoch != admission.decision().grant_epoch
                || !receipt.coverage.complete
                || !receipt.coverage.missing_fields.is_empty()
                || !receipt.coverage.missing_sources.is_empty()
                || !receipt.coverage.gap_sources.is_empty()
                || !receipt.dirty.is_empty()
                || receipt.truncation.is_some()
                || receipt.freshness.iter().any(|source| !source.satisfied)
                || receipt
                    .basis
                    .iter()
                    .any(|source| !basis.sources.contains(source))
            {
                return Err(changed(Vec::new()));
            }
            if crate::query::recheck_receipt_dependencies(tx, admission, &receipt.id, now).await?
                != *receipt
            {
                return Err(changed(Vec::new()));
            }
        }
        Ok(())
    })
}

pub(super) fn dependencies(basis: &BranchBasis) -> Vec<ReadDependency> {
    let mut dependencies = Vec::new();
    for receipt in &basis.read_receipts {
        for dependency in &receipt.actual_dependencies {
            if !dependencies.contains(dependency) {
                dependencies.push(dependency.clone());
            }
        }
    }
    dependencies
}
fn changed(resources: Vec<ResourceRef>) -> Error {
    ReleaseFailure::BasisChanged { resources }.into()
}
