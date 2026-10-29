use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    package::PackageLimits,
    slots::{self, ContextRequest, ContextResult},
};

use crate::{
    extensions::{
        invocation::{InvocationContext, NativePrepareFailure, NativeProof},
        package::ArtifactLease,
    },
    learning::investigation::ContextExecution,
    owner::Error,
};

pub(crate) struct PreparedContext {
    proof: NativeProof,
}

impl PreparedContext {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
    ) -> Result<Self, NativePrepareFailure> {
        let contract = slots::slot_contract(SlotKind::Context)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) {
            return Err(NativePrepareFailure::Entrypoint);
        }
        let proof = NativeProof::prepare(
            node,
            config,
            artifact,
            slots::CONTEXT_REGISTRATION,
            SlotKind::Context,
        )?;
        Ok(Self { proof })
    }

    pub fn implementation(&self) -> &ImplementationRef {
        self.proof.implementation()
    }
    pub fn config(&self) -> &PackageConfigView {
        self.proof.config()
    }
    pub fn limits(&self) -> &PackageLimits {
        self.proof.limits()
    }
    pub(crate) async fn build(
        &self,
        context: &InvocationContext,
        request: &ContextRequest,
        execution: &ContextExecution,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<ContextResult, Error> {
        execution.execute(context, request, &cancel, deadline).await
    }
}
