mod contract;
mod intent;
mod prepared;
pub(crate) use prepared::{PreparedAction, check_plan, plan_request};
mod proposal;
mod receipt;
mod retention;
pub(crate) use retention::{
    operation_retention_roots, retain_source as source_receipt_retention_roots,
    step_retention_roots, world_deletion_roots, merge as merge_retention_roots,
};

pub(crate) use contract::Context;
pub(crate) use contract::{
    action, approval, compensation_impact, current_impact, impact, policies, run_basis, run_branch,
    targets, verifier_request,
};
pub(crate) use intent::read_operation_intent;
pub(crate) use intent::{
    Execution, PreparedIntent, existing_intent, lookup_intent_recovery, prepare, read_intent, require_effect_ready, retain_source,
};
pub(crate) use proposal::{
    approve, effective_approval, propose, propose_compensation, read_proposal, require_proposal_read, proposal_read_impact,
};
pub(crate) use receipt::{
    check_status_output, has_unsettled_world, mark_dispatching, operation_failure, record_source,
    reject_unconsumed, settle_verification, status, status_impact,
};

use crate::owner::Error;
use serde::{Serialize, de::DeserializeOwned};
use world_protocol::{
    actions::ActionFailure,
    api::ApiFailure,
    authorization::Actor,
    failure::{FailureStage, Recovery},
    ids::ActorId,
    operation::OperationFailure,
};

fn rejected(failure: ActionFailure, stage: FailureStage) -> Error {
    Error::new(
        "world.action_rejected",
        stage,
        "动作未满足当前执行条件。",
        ApiFailure::Operation(OperationFailure::Action(failure)),
        Recovery::Refresh,
    )
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value)
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))
}
fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, Error> {
    serde_json::from_value(value)
        .map_err(|cause| Error::internal(FailureStage::Decode).caused(cause))
}
fn actor(actor: &Actor) -> &ActorId {
    match actor {
        Actor::Human { id } | Actor::Service { id } => id,
    }
}
pub(crate) fn source_error(error: crate::sources::connectors::SourceError) -> Error {
    let mut failure = rejected(
        ActionFailure::Source {
            failure: error.failure.clone(),
        },
        error.stage,
    );
    for related in error.related_errors() {
        failure = failure.with_related(source_error(related.clone()));
    }
    failure.caused(error)
}
