use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::PackageConfigView,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    package::PackageLimits,
    slots::{self, AgentBridgeRequest, AgentBridgeResult},
};

use crate::{
    extensions::{
        invocation::{InvocationContext, NativePrepareFailure, NativeProof},
        package::ArtifactLease,
    },
    owner::{AgentBridgeExecution, Error},
};

pub(crate) struct PreparedAgentBridge {
    proof: NativeProof,
}

impl PreparedAgentBridge {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
    ) -> Result<Self, NativePrepareFailure> {
        let contract = slots::slot_contract(SlotKind::AgentBridge)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.implementation.contracts.contains(&contract) {
            return Err(NativePrepareFailure::Entrypoint);
        }
        let proof = NativeProof::prepare(
            node,
            config,
            artifact,
            slots::AGENT_BRIDGE_REGISTRATION,
            SlotKind::AgentBridge,
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
    pub(crate) async fn dispatch(
        &self,
        context: &InvocationContext,
        request: &AgentBridgeRequest,
        execution: &AgentBridgeExecution,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<AgentBridgeResult, Error> {
        execution.execute(context, request, &cancel, deadline).await
    }
}
