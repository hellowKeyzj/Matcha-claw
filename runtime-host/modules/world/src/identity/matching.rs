use std::collections::BTreeSet;
use world_protocol::{
    identity::{AliasResolution, IdentityFailure, IdentityProposal, IdentityReceipt, IdentityResolveRequest, IdentitySnapshot},
    provenance::ReadDependency,
};

use super::{IdentityError, subject, type_id, world};

/// The world, not a proposer, allocates IDs and atomically binds the reliable source key.
pub(crate) async fn accept_proposal(
    transaction: &mut crate::store::WorldTransaction<'_>, request: &IdentityResolveRequest,
    receipt: &IdentityReceipt, proposal: &IdentityProposal, admission: &crate::authorization::Admission,
    now: &world_protocol::time::Timestamp, budget: &crate::extensions::invocation::CallBudget, cancellation: &tokio_util::sync::CancellationToken,
) -> Result<IdentitySnapshot, IdentityError> {
    if request.key != receipt.key || request.scope != receipt.scope || &request.key.world != transaction.world()
        || request.type_ref.world != request.key.world { return Err(IdentityFailure::CrossWorld.into()); }
    crate::facts::support::lock_ranges(transaction, std::slice::from_ref(&request.type_ref.id), &[]).await?;
    match (&receipt.resolution, proposal) {
        (AliasResolution::Ambiguous { candidates, .. }, _) => return Err(IdentityFailure::Ambiguous { candidates: candidates.clone() }.into()),
        (_, IdentityProposal::Ambiguous { candidates, .. }) => return Err(IdentityFailure::Ambiguous { candidates: candidates.clone() }.into()),
        (AliasResolution::Existing { identity, .. }, IdentityProposal::Same { target, .. }) if subject(&identity.record) == *target => {
            if type_id(&identity.record) != &request.type_ref.id { return Err(IdentityFailure::AliasConflict { key: request.key.clone() }.into()); }
            super::authorize(transaction, admission, &request.scope, &request.key.valid_time,
                &[super::resource(target)], &[request.key.source_id.clone()], now).await?;
            super::recheck_receipt(transaction, receipt).await?;
            return Ok(identity.clone());
        }
        (AliasResolution::Existing { .. }, _) => return Err(IdentityFailure::AliasConflict { key: request.key.clone() }.into()),
        (AliasResolution::NotFound, _) => {}
    }
    if !request.candidates_complete || receipt.dependencies.iter().any(|dependency| !request.dependencies.contains(dependency)) {
        return Err(IdentityFailure::CandidateScopeIncomplete.into());
    }
    let (target, evidence) = match proposal {
        IdentityProposal::Same { target, evidence } => {
            let candidate = request.candidates.iter().find(|candidate| subject(&candidate.identity.record) == *target)
                .ok_or(IdentityFailure::CandidateScopeIncomplete)?;
            if world(&candidate.identity.record) != transaction.world() || type_id(&candidate.identity.record) != &request.type_ref.id {
                return Err(IdentityFailure::CandidateScopeIncomplete.into());
            }
            let definition = super::records::resolve_type(transaction, &request.type_ref, &request.scope, &request.key.valid_time).await?;
            if !matches!((&definition.body, &candidate.identity.record),
                (world_protocol::definitions::DefinitionBody::ObjectType(_), world_protocol::identity::IdentityRecord::Object(_))
                | (world_protocol::definitions::DefinitionBody::RelationType(_), world_protocol::identity::IdentityRecord::Relation(_))) {
                return Err(IdentityFailure::TypeKindMismatch { reference: request.type_ref.clone() }.into());
            }
            (candidate.identity.clone(), evidence)
        }
        IdentityProposal::New { type_ref, evidence } => {
            if type_ref != &request.type_ref { return Err(IdentityFailure::CrossWorld.into()); }
            (super::create(transaction, type_ref, &request.scope, &request.key.valid_time, admission, now, budget, cancellation).await?, evidence)
        }
        IdentityProposal::Ambiguous { .. } => unreachable!(),
    };
    super::bind_alias(transaction, receipt, &target, evidence, admission, now, budget, cancellation).await?;
    Ok(target)
}

/// A replacement proposes only; it never receives a transaction or assigns canonical IDs.
pub(crate) trait IdentityProposer: Send + Sync {
    fn propose(&self, request: &IdentityResolveRequest) -> Result<IdentityProposal, IdentityFailure>;
}

pub(crate) struct SourceIdentity;

impl IdentityProposer for SourceIdentity {
    fn propose(&self, request: &IdentityResolveRequest) -> Result<IdentityProposal, IdentityFailure> {
        // Candidate recall, even a unique exact name, is not a reliable source binding.
        if !request.candidates_complete { return Err(IdentityFailure::CandidateScopeIncomplete); }
        let candidates: BTreeSet<_> = request.candidates.iter().map(|candidate| subject(&candidate.identity.record)).collect();
        let evidence = request.candidates.iter().flat_map(|candidate| candidate.evidence.iter().cloned()).collect();
        if candidates.is_empty() {
            Ok(IdentityProposal::New { type_ref: request.type_ref.clone(), evidence })
        } else {
            Ok(IdentityProposal::Ambiguous { candidates: candidates.into_iter().collect(), evidence })
        }
    }
}

pub(crate) fn propose(
    proposer: &dyn IdentityProposer, request: &IdentityResolveRequest, receipt: &IdentityReceipt,
) -> Result<IdentityProposal, IdentityFailure> {
    if request.key != receipt.key || request.scope != receipt.scope || request.type_ref.world != request.key.world {
        return Err(IdentityFailure::CrossWorld);
    }
    if request.candidates.iter().any(|candidate| world(&candidate.identity.record) != &request.key.world
        || type_id(&candidate.identity.record) != &request.type_ref.id) {
        return Err(IdentityFailure::CandidateScopeIncomplete);
    }
    match &receipt.resolution {
        AliasResolution::Existing { identity, .. } => {
            if type_id(&identity.record) != &request.type_ref.id {
                return Err(IdentityFailure::AliasConflict { key: request.key.clone() });
            }
            return Ok(IdentityProposal::Same { target: subject(&identity.record), evidence: Vec::new() });
        }
        AliasResolution::Ambiguous { candidates, .. } => return Ok(IdentityProposal::Ambiguous { candidates: candidates.clone(), evidence: Vec::new() }),
        AliasResolution::NotFound => {}
    }
    if !request.candidates_complete { return Err(IdentityFailure::CandidateScopeIncomplete); }
    for dependency in &receipt.dependencies {
        if !request.dependencies.contains(dependency) { return Err(IdentityFailure::CandidateScopeIncomplete); }
    }
    for candidate in &request.candidates {
        let dependency = ReadDependency::Identity { subject: subject(&candidate.identity.record), revision: candidate.identity.revision };
        if !request.dependencies.contains(&dependency) { return Err(IdentityFailure::CandidateScopeIncomplete); }
    }
    let proposal = proposer.propose(request)?;
    match &proposal {
        IdentityProposal::Same { target, .. } if !request.candidates.iter().any(|candidate| subject(&candidate.identity.record) == *target) => {
            Err(IdentityFailure::CandidateScopeIncomplete)
        }
        IdentityProposal::New { type_ref, .. } if type_ref != &request.type_ref => Err(IdentityFailure::CrossWorld),
        IdentityProposal::Ambiguous { candidates, .. } if candidates.iter().any(|target| !request.candidates.iter().any(|candidate| subject(&candidate.identity.record) == *target)) => {
            Err(IdentityFailure::CandidateScopeIncomplete)
        }
        _ => Ok(proposal),
    }
}
