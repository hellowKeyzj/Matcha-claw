mod archive;
mod authority;
pub(crate) use authority::{investigation_request_digest, require_investigation_checkpoint, require_investigation_recovery_checkpoint};
mod checkpoint;
mod context;
mod execution;
mod observation;
mod ports;
mod retention;

pub(crate) use archive::cleanup_terminal;
pub(crate) use checkpoint::{binding, has_unsettled_execution, impact, require_online_oracle_binding, require_settled_execution, run_basis};
pub(crate) use context::ContextExecution;
pub(crate) use execution::run;
pub(crate) use observation::ObservedResolution;
pub use ports::*;
pub(crate) use retention::{operation_retention_roots, step_retention_roots};

use crate::{
    authorization::OnlineOracleBinding,
    owner::{Error, StepRecord},
    store::WorldTransaction,
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    abstraction::AbstractionContract, authorization::ActualImpact, expression::TruthValue, ids::*,
    learning::TaskContract, query::QueryPage, time::Timestamp,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    binding: OnlineOracleBinding,
    task: TaskContract,
    deadline: Timestamp,
    context: Option<ResolutionContext>,
    execution: Option<InvestigationRequestState>,
    receipt: Option<InvestigationReceipt>,
    native_usage_accounted: bool,
    #[serde(default)]
    native_not_sent_accounted: bool,
    #[serde(default)]
    native_settlement_at: Option<Timestamp>,
    #[serde(default)]
    native_settled: bool,
    observed: Option<QueryPage>,
    observed_digest: Option<Digest>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolutionContext {
    contract: Option<AbstractionContract>,
    page: Option<QueryPage>,
    view: Option<world_protocol::abstraction::WorldView>,
    reason: Option<TruthValue>,
    investigate: bool,
    strategy: Option<crate::abstraction::strategy::StrategyExecution>,
    invocation: Option<context::ContextInvocation>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InvestigationRequestState {
    identity: InvestigationIdentity,
    execution_prompt: String,
    allowed_effects: Vec<world_protocol::expression::Effect>,
    finite_impact: ActualImpact,
    query_closure: InvestigationQueryClosure,
    allowance_id: CommitId,
    allowance: world_protocol::budget::Usage,
    budget: world_protocol::budget::Budget,
    created_at: Timestamp,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InvestigationQueryClosure {
    activation_lock_id: ActivationLockId,
    root: NodeId,
    bindings: Vec<BindingId>,
}

impl InvestigationRequestState {
    fn request(&self, binding: std::sync::Arc<crate::authorization::InvestigationBinding>) -> InvestigationRequest {
        InvestigationRequest {
            authority: binding,
            identity: self.identity.clone(),
            execution_prompt: self.execution_prompt.clone(),
            allowed_effects: self.allowed_effects.clone(),
            budget: self.budget.clone(),
            created_at: self.created_at.clone(),
        }
    }
}

fn changed() -> Error {
    super::Error::from(world_protocol::learning::LearningFailure::BasisChanged).into()
}

fn encode<T: Serialize>(value: &T) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(|cause| {
        Error::internal(world_protocol::failure::FailureStage::Commit).caused(cause)
    })
}

fn decode(step: &StepRecord) -> Result<Checkpoint, Error> {
    serde_json::from_value(step.checkpoint.clone()).map_err(|cause| changed().caused(cause))
}

async fn save(
    tx: &mut WorldTransaction<'_>,
    step: &StepRecord,
    state: &Checkpoint,
) -> Result<StepRecord, Error> {
    let mut next = step.clone();
    next.checkpoint = encode(state)?;
    crate::owner::checkpoint_step(tx, step, next).await
}

fn combined(left: ActualImpact, right: ActualImpact) -> Result<ActualImpact, Error> {
    Ok(crate::authorization::actual_impact(
        left.access.into_iter().chain(right.access).collect(),
        left.effects.into_iter().chain(right.effects).collect(),
        left.labels.into_iter().chain(right.labels).collect(),
        left.state.into_iter().chain(right.state).collect(),
        left.source_ids
            .into_iter()
            .chain(right.source_ids)
            .collect(),
    )?)
}
