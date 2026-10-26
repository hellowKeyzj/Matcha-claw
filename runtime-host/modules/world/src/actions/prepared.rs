use std::collections::BTreeSet;

use world_protocol::{
    actions::ActionFailure,
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    ids::Digest,
    package::PackageLimits,
    slots::{self, ActionPlanRequest, ActionPlanResult},
};

use crate::extensions::{
    invocation::{NativePrepareFailure, NativeProof},
    package::ArtifactLease,
};

pub(crate) struct PreparedAction {
    proof: NativeProof,
}

impl PreparedAction {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
        host_build: &Digest,
    ) -> Result<Self, NativePrepareFailure> {
        let contract = slots::slot_contract(SlotKind::Action)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) {
            return Err(NativePrepareFailure::Entrypoint);
        }
        Ok(Self {
            proof: NativeProof::prepare(
                node, config, artifact, host_build, slots::ACTION_REGISTRATION, SlotKind::Action,
            )?,
        })
    }

    pub fn implementation(&self) -> &ImplementationRef { self.proof.implementation() }
    pub fn config(&self) -> &PackageConfigView { self.proof.config() }
    pub fn limits(&self) -> &PackageLimits { self.proof.limits() }

    pub fn plan(&self, request: &ActionPlanRequest) -> Result<ActionPlanResult, ActionFailure> {
        plan(request)
    }
}

pub(super) fn plan(request: &ActionPlanRequest) -> Result<ActionPlanResult, ActionFailure> {
    let proposal = &request.proposal;
    let contract = &request.contract;
    if proposal.request.action != contract.reference || proposal.request.world != contract.reference.world
        || proposal.request.arguments.len() > contract.body.parameters.len()
        || proposal.preconditions.len() != contract.body.preconditions.len() {
        return Err(ActionFailure::ProposalDigestMismatch);
    }
    let mut parameters = BTreeSet::new();
    for argument in &proposal.request.arguments {
        let parameter = contract.body.parameters.iter().find(|parameter| parameter.id == argument.parameter_id)
            .ok_or(ActionFailure::ProposalDigestMismatch)?;
        if !parameters.insert(&argument.parameter_id) {
            return Err(ActionFailure::ProposalDigestMismatch);
        }
        world_protocol::value::validate_value(&parameter.value_type, parameter.nullable, &argument.value)
            .map_err(|failure| ActionFailure::Definition { failure })?;
    }
    if contract.body.parameters.iter().any(|parameter| !parameter.optional && !parameters.contains(&parameter.id)) {
        return Err(ActionFailure::ProposalDigestMismatch);
    }
    let mut receipts = BTreeSet::new();
    for receipt in &request.basis {
        if !receipts.insert(&receipt.id) || !proposal.request.basis.contains(&receipt.id)
            || receipt.world != proposal.request.world || receipt.branch_id != proposal.request.branch_id
            || receipt.activation_lock_id != proposal.activation_lock_id || !receipt.coverage.complete
            || !receipt.coverage.missing_sources.is_empty() || !receipt.coverage.missing_fields.is_empty()
            || !receipt.coverage.gap_sources.is_empty() || !receipt.dirty.is_empty() || receipt.truncation.is_some()
            || receipt.actual_dependencies.iter().any(|dependency| !proposal.read_dependencies.contains(dependency)) {
            return Err(ActionFailure::ProposalDigestMismatch);
        }
    }
    if receipts.len() != proposal.request.basis.len() { return Err(ActionFailure::ProposalDigestMismatch); }
    Ok(ActionPlanResult {
        source_operation: contract.body.source_operation.clone(),
        arguments: proposal.request.arguments.clone(),
        dependencies: proposal.read_dependencies.clone(),
        expected_effect: contract.body.expected_effect.clone(),
    })
}

pub(crate) async fn plan_request(
    tx: &crate::store::WorldTransaction<'_>,
    admission: &crate::authorization::Admission,
    request: &world_protocol::actions::ActionSubmitRequest,
) -> Result<ActionPlanRequest, super::Error> {
    let (proposal, _) = super::read_proposal(tx, &request.proposal_id).await?;
    if request.world != *tx.world() || proposal.digest != request.proposal_digest {
        return Err(super::rejected(ActionFailure::ProposalDigestMismatch, world_protocol::failure::FailureStage::Admission));
    }
    let contract = super::action(tx, &proposal.request.action).await?;
    let now = tx.now().await?;
    let mut basis = Vec::with_capacity(proposal.request.basis.len());
    for id in &proposal.request.basis {
        basis.push(crate::query::require_action_basis(tx, admission, id, &now).await?);
    }
    Ok(ActionPlanRequest { proposal, contract, basis })
}

/// A slot proposes execution data, not a new contract, approval or permission to send.
pub(crate) fn check_plan(request: &ActionPlanRequest, result: &ActionPlanResult) -> Result<(), ActionFailure> {
    if &plan(request)? != result { return Err(ActionFailure::ProposalDigestMismatch); }
    Ok(())
}
