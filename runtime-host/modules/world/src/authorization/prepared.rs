use world_protocol::{
    api::PackageConfigView,
    authorization::AuthorizationFailure,
    bindings::{BindingNode, ImplementationRef, SlotKind},
    ids::Digest,
    package::PackageLimits,
    slots::{self, PolicyEvaluationRequest, PolicyEvaluationResult},
};

use crate::extensions::{
    invocation::{CurrentFailure, InvocationContext, NativePrepareFailure, NativeProof},
    package::ArtifactLease,
};

pub(crate) struct PreparedPolicy {
    proof: NativeProof,
}

impl PreparedPolicy {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
        host_build: &Digest,
    ) -> Result<Self, NativePrepareFailure> {
        let port = slots::slot_port(SlotKind::Policy)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if !node.ports.contains(&port) {
            return Err(NativePrepareFailure::Entrypoint);
        }
        let proof = NativeProof::prepare(
            node,
            config,
            artifact,
            host_build,
            slots::POLICY_REGISTRATION,
            SlotKind::Policy,
        )?;
        Ok(Self { proof })
    }

    pub(crate) fn implementation(&self) -> &ImplementationRef {
        self.proof.implementation()
    }
    pub(crate) fn config(&self) -> &PackageConfigView {
        self.proof.config()
    }
    pub(crate) fn limits(&self) -> &PackageLimits {
        self.proof.limits()
    }

    pub(crate) async fn evaluate(
        &self,
        context: &InvocationContext,
        request: &PolicyEvaluationRequest,
    ) -> Result<PolicyEvaluationResult, CurrentFailure> {
        let node = context
            .lease()
            .graph()
            .node(context.node())
            .map_err(CurrentFailure::Binding)?;
        if &node.implementation != self.implementation()
            || node.slot != SlotKind::Policy
            || request != &context.admission().policy_request()?
        {
            return Err(super::AuthError::from(AuthorizationFailure::RequestDigestMismatch).into());
        }
        context.check_current().await?;
        let admission = context.admission().clone();
        let policies = request.policies.clone();
        // This is the same current hard admission, not a cached Allow or a second policy engine.
        let result = context
            .store()
            .snapshot(request.world.clone(), move |snapshot| {
                Box::pin(async move {
                    let at = snapshot.now().await?;
                    let decision = super::recheck_read(snapshot, &admission, &at).await?;
                    Ok::<_, super::AuthError>(PolicyEvaluationResult {
                        verdict: decision.verdict,
                        obligations: decision.obligations,
                        policies,
                    })
                })
            })
            .await?;
        context.check_current().await?;
        Ok(result)
    }
}
