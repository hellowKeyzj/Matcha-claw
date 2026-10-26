use std::collections::BTreeSet;

use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    ids::Digest,
    package::PackageLimits,
    provenance::{ProvenanceFailure, ProvenanceLimit, SupportDeltaProposal, SupportSnapshot},
    slots,
};

use crate::extensions::{
    invocation::{NativePrepareFailure, NativeProof},
    package::ArtifactLease,
};

pub(crate) struct PreparedProvenance {
    proof: NativeProof,
}

impl PreparedProvenance {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
        host_build: &Digest,
    ) -> Result<Self, NativePrepareFailure> {
        let contract = slots::slot_contract(SlotKind::Provenance)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) {
            return Err(NativePrepareFailure::Entrypoint);
        }
        Ok(Self {
            proof: NativeProof::prepare(
                node, config, artifact, host_build,
                slots::PROVENANCE_REGISTRATION, SlotKind::Provenance,
            )?,
        })
    }

    pub fn implementation(&self) -> &ImplementationRef { self.proof.implementation() }
    pub fn config(&self) -> &PackageConfigView { self.proof.config() }
    pub fn limits(&self) -> &PackageLimits { self.proof.limits() }

    pub fn recompute(&self, snapshot: &SupportSnapshot) -> Result<SupportDeltaProposal, ProvenanceFailure> {
        proposal(snapshot)
    }
}

pub(crate) fn check_proposal(snapshot: &SupportSnapshot, proposed: &SupportDeltaProposal) -> Result<(), ProvenanceFailure> {
    if proposal(snapshot)? != *proposed { return Err(ProvenanceFailure::MissingPremise); }
    Ok(())
}

/// Plans the finite original AND edges. Only accept's rule proofs can settle their truth.
pub(super) fn proposal(snapshot: &SupportSnapshot) -> Result<SupportDeltaProposal, ProvenanceFailure> {
    if snapshot.supports.len() > super::BATCH_LIMIT {
        return Err(ProvenanceFailure::LimitExceeded {
            resource: ProvenanceLimit::ProposalItems, limit: super::BATCH_LIMIT as u64,
        });
    }
    let mut ids = BTreeSet::new();
    let mut observed_dependencies = Vec::new();
    for support in &snapshot.supports {
        if !ids.insert(&support.reference.id) || support.reference.revision.0 == 0
            || support.rule.revision.0 == 0 || support.conclusion.revision.0 == 0
            || support.premises.is_empty() {
            return Err(ProvenanceFailure::MissingPremise);
        }
        if support.reference.world != support.conclusion.world || support.rule.world != support.reference.world
            || !snapshot.assertions.contains(&support.conclusion) {
            return Err(ProvenanceFailure::CrossScope);
        }
        if support.valid_time.to.as_ref().is_some_and(|to| to <= &support.valid_time.from) {
            return Err(ProvenanceFailure::InvalidInterval);
        }
        if support.premises.len() > super::BATCH_LIMIT {
            return Err(ProvenanceFailure::LimitExceeded {
                resource: ProvenanceLimit::ProposalItems, limit: super::BATCH_LIMIT as u64,
            });
        }
        for dependency in super::dependencies(support) {
            if !observed_dependencies.contains(&dependency) { observed_dependencies.push(dependency); }
            if observed_dependencies.len() > super::BATCH_LIMIT {
                return Err(ProvenanceFailure::LimitExceeded {
                    resource: ProvenanceLimit::ProposalItems, limit: super::BATCH_LIMIT as u64,
                });
            }
        }
    }
    Ok(SupportDeltaProposal {
        upserts: snapshot.supports.clone(), invalidate: Vec::new(),
        affected_watches: snapshot.watches.iter().map(|watch| watch.id.clone()).collect(),
        observed_dependencies,
    })
}
