use std::collections::BTreeSet;

use world_protocol::{
    evaluation::{BranchBasis, EvaluationConditions, Replayability},
    ids::{Digest, SourceId, WorldRef},
    materials::BlobRef,
    query::ReadMode,
    sources::SourceGuarantee,
};

use super::{ConstraintFailure, Error};

pub(crate) fn data_digest(basis: &BranchBasis) -> Result<Digest, Error> {
    super::records::digest(&(&basis.snapshots, &basis.sources, &basis.read_receipts))
}

/// Content availability is measured by the owner after a pinned digest-checked
/// read, not inferred from the request's replayability claim.
pub(crate) fn assess_basis(
    world: &WorldRef,
    basis: &BranchBasis,
    conditions: &EvaluationConditions,
    available_snapshots: &[BlobRef],
) -> Result<(Replayability, Vec<SourceId>), ConstraintFailure> {
    if basis.activation_lock_id != conditions.tool_lock {
        return Err(ConstraintFailure::VersionMismatch);
    }
    let mut missing: BTreeSet<_> = basis.missing_sources.iter().cloned().collect();
    let mut incomplete = (!basis.sources.is_empty() && basis.snapshots.is_empty())
        || basis
            .snapshots
            .iter()
            .any(|snapshot| !available_snapshots.contains(snapshot));
    let mut observed = BTreeSet::new();
    for source in &basis.sources {
        if source.binding.world != *world {
            return Err(ConstraintFailure::CrossWorld);
        }
        if !observed.insert(&source.binding) {
            return Err(ConstraintFailure::Duplicate);
        }
        let lag = conditions.known_at.unix_nanos() - source.observed_at.unix_nanos();
        let readable = lag >= 0
            && source
                .captured_at
                .as_ref()
                .is_none_or(|captured| captured <= &conditions.known_at)
            && source
                .last_reconciled_at
                .as_ref()
                .is_none_or(|reconciled| reconciled <= &conditions.known_at)
            && match &conditions.read_mode {
                ReadMode::Projected { max_lag } => {
                    source.guarantee != SourceGuarantee::Assumed
                        && lag <= i128::from(max_lag.0) * 1_000_000
                }
                ReadMode::Authoritative => source.guarantee == SourceGuarantee::Authoritative,
                // The query owner checks the explicitly selected durable receipt and
                // compares each capture position under the current execution actor.
                ReadMode::After { .. } => source.guarantee != SourceGuarantee::Assumed,
            };
        // An authoritative current read is not a historical replay or a snapshot.
        if !readable
            || source.gap.is_some()
            || (source.snapshot.is_none() && source.guarantee != SourceGuarantee::RecordedReplay)
        {
            missing.insert(source.source_id.clone());
        }
    }
    for receipt in &basis.read_receipts {
        if receipt.world != *world {
            return Err(ConstraintFailure::CrossWorld);
        }
        if receipt.release_id != basis.release_id
            || receipt.activation_lock_id != basis.activation_lock_id
        {
            return Err(ConstraintFailure::VersionMismatch);
        }
        if receipt.policy_epoch != conditions.policy_epoch
            || receipt.grant_epoch != conditions.grant_epoch
        {
            return Err(ConstraintFailure::EpochChanged);
        }
        incomplete |=
            !receipt.coverage.complete || !receipt.dirty.is_empty() || receipt.truncation.is_some();
        missing.extend(receipt.coverage.missing_sources.iter().cloned());
        missing.extend(receipt.coverage.gap_sources.iter().cloned());
        for source in &receipt.basis {
            if !basis.sources.contains(source) {
                missing.insert(source.source_id.clone());
            }
        }
    }
    let availability = match basis.replayability {
        Replayability::NotReplayable => Replayability::NotReplayable,
        _ if available_snapshots.is_empty() && (!basis.sources.is_empty() || incomplete) => {
            Replayability::NotReplayable
        }
        Replayability::Partial => Replayability::Partial,
        _ if incomplete || !missing.is_empty() => Replayability::Partial,
        _ => Replayability::Complete,
    };
    Ok((availability, missing.into_iter().collect()))
}
