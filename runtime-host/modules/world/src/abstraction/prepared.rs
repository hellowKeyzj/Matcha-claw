use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionRequest},
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    ids::Digest,
    package::PackageLimits,
    slots,
};
use crate::{
    extensions::{invocation::{InvocationContext, NativePrepareFailure, NativeProof}, package::ArtifactLease},
    owner::{AbstractionExecution, Error},
};

pub(crate) struct PreparedAbstraction {
    proof: NativeProof,
}

impl PreparedAbstraction {
    pub(crate) fn prepare(node: &BindingNode, config: PackageConfigView, artifact: ArtifactLease, host_build: &Digest) -> Result<Self, NativePrepareFailure> {
        let contract = slots::slot_contract(SlotKind::Abstraction).map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) { return Err(NativePrepareFailure::Entrypoint); }
        Ok(Self { proof: NativeProof::prepare(node, config, artifact, host_build, slots::ABSTRACTION_REGISTRATION, SlotKind::Abstraction)? })
    }

    pub fn implementation(&self) -> &ImplementationRef { self.proof.implementation() }
    pub fn config(&self) -> &PackageConfigView { self.proof.config() }
    pub fn limits(&self) -> &PackageLimits { self.proof.limits() }

    pub(crate) async fn abstract_plan(
        &self, context: &InvocationContext, request: &AbstractionRequest, execution: &AbstractionExecution,
        cancel: CancellationToken, deadline: Instant,
    ) -> Result<AbstractionContract, Error> {
        execution.execute(context, request, &cancel, deadline).await
    }
}
