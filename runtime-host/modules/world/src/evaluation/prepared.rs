use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{PackageConfigView, package_config_digest},
    bindings::{BindingNode, ImplementationRef, SlotKind},
    package::PackageLimits,
    slots::{self, OracleFailure, OracleRequest, OracleResult},
    value::Value,
};

use crate::extensions::{
    invocation::{InvocationContext, InvocationFailure, NativePrepareFailure, NativeProof},
    package::ArtifactLease,
};

pub(crate) struct PreparedEvaluation {
    proof: NativeProof,
    enabled: bool,
}

impl PreparedEvaluation {
    pub(crate) fn prepare(
        node: &BindingNode,
        config: PackageConfigView,
        artifact: ArtifactLease,
    ) -> Result<Self, NativePrepareFailure> {
        let expected = slots::slot_port(SlotKind::Evaluation)
            .map_err(|_| NativePrepareFailure::Entrypoint)?;
        if node.ports.iter().filter(|port| *port == &expected).count() != 1
            || !node.implementation.contracts.contains(&expected.contract)
        {
            return Err(NativePrepareFailure::Entrypoint);
        }
        if package_config_digest(&config.fields).map_err(|_| NativePrepareFailure::Configuration)? != config.digest {
            return Err(NativePrepareFailure::Configuration);
        }
        let [field] = config.fields.as_slice() else { return Err(NativePrepareFailure::Configuration); };
        let Value::Boolean { value: enabled } = &field.value else { return Err(NativePrepareFailure::Configuration); };
        if field.name != "enabled" { return Err(NativePrepareFailure::Configuration); }
        let enabled = *enabled;
        let proof = NativeProof::prepare(node, config, artifact,
            slots::EVALUATION_REGISTRATION, SlotKind::Evaluation)?;
        Ok(Self { proof, enabled })
    }

    pub fn implementation(&self) -> &ImplementationRef { self.proof.implementation() }
    pub fn config(&self) -> &PackageConfigView { self.proof.config() }
    pub fn limits(&self) -> &PackageLimits { self.proof.limits() }

    pub(crate) async fn evaluate(
        &self,
        context: &InvocationContext,
        request: &OracleRequest,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<Result<OracleResult, OracleFailure>, InvocationFailure> {
        let node = context.lease().graph().node(context.node()).map_err(InvocationFailure::Binding)?;
        if node.implementation != *self.implementation() || node.slot != SlotKind::Evaluation
            || context.admission().invocation().world != request.world
        {
            return Ok(Err(OracleFailure::SchemaMismatch));
        }
        if !self.enabled { return Ok(Err(OracleFailure::Unavailable)); }
        context.check_current().await.map_err(InvocationFailure::Current)?;
        let budget = context.budget().scoped(&request.budget, &super::accounting::now())
            .map_err(InvocationFailure::Budget)?;
        let deadline = deadline.min(budget.deadline());
        let scoped = OracleRequest { budget: budget.limit(), ..request.clone() };
        let current_failure = std::sync::Mutex::new(None);
        let result = world_protocol::evaluation::oracle::evaluate(&scoped, || async {
            tokio::task::yield_now().await;
            if cancel.is_cancelled() || context.pipeline().is_cancelled() {
                return Err(OracleFailure::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(OracleFailure::BudgetExceeded);
            }
            budget.check().map_err(|_| OracleFailure::BudgetExceeded)?;
            match context.check_current().await {
                Ok(()) => Ok(()),
                Err(error) => {
                    *current_failure.lock().expect("oracle current failure poisoned") = Some(error);
                    Err(OracleFailure::Unavailable)
                }
            }
        }, |dimension, amount| budget.charge(dimension, amount).map_err(|_| OracleFailure::BudgetExceeded)).await;
        if let Some(error) = current_failure.into_inner().expect("oracle current failure poisoned") {
            return Err(InvocationFailure::Current(error));
        }
        context.check_current().await.map_err(InvocationFailure::Current)?;
        Ok(result)
    }
}
