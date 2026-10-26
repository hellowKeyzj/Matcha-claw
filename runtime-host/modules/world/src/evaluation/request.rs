use super::{ConstraintFailure, Error, records};
use crate::{definitions::canonical_digest, store::WorldTransaction};
use world_protocol::{
    evaluation::{EvaluationRequest, TestBranch},
    ids::{EvaluationId, OperationId},
    releases::WorldBranch,
};

pub(crate) async fn branch_for_test(
    tx: &WorldTransaction<'_>,
    request: &TestBranch,
) -> Result<WorldBranch, Error> {
    if request.branch.world != *tx.world() || request.suite.world != *tx.world() {
        return Err(ConstraintFailure::CrossWorld.into());
    }
    let branch = crate::releases::read_branch_revision(tx, &request.branch)
        .await?
        .ok_or(ConstraintFailure::VersionMismatch)?;
    if crate::releases::read_branch(tx, &branch.id).await?.as_ref() != Some(&branch) {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    Ok(branch)
}

pub(crate) async fn resolve_test(
    tx: &WorldTransaction<'_>,
    input: &TestBranch,
    operation: &OperationId,
) -> Result<EvaluationRequest, Error> {
    if input.branch.world != *tx.world() || input.suite.world != *tx.world() {
        return Err(ConstraintFailure::CrossWorld.into());
    }
    let digest = canonical_digest(&("world.evaluation.operation.v1", tx.world(), operation))
        .map_err(|failure| ConstraintFailure::Definition { failure })?;
    let id = EvaluationId::try_new(format!("evaluation-{}", &digest.as_str()[7..]))
        .map_err(|_| super::invalid("evaluation.id"))?;
    if let Some(state) = super::run::load(tx, &id).await? {
        if state.run.operation.operation_id != *operation
            || state.submitted_branch != input.branch
            || state.request.suite.world != input.suite.world
            || state.request.suite.id != input.suite.id
            || state.request.suite.revision != input.suite.revision
            || state.request.budget != input.budget
        {
            return Err(ConstraintFailure::VersionMismatch.into());
        }
        return Ok(state.request);
    }
    let branch = branch_for_test(tx, input).await?;
    if !matches!(
        branch.status,
        world_protocol::learning::ChangeStatus::Validated
            | world_protocol::learning::ChangeStatus::Testing
    ) || branch.basis.activation_lock_id != branch.compile.activation_lock.id
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    let suite = records::suite(tx, &input.suite.id, input.suite.revision).await?;
    let task = records::task(tx, &branch.task_id, branch.task_revision).await?;
    let request = EvaluationRequest {
        world: tx.world().clone(),
        id,
        candidate_id: branch.candidate_id,
        branch_id: branch.id,
        basis: branch.basis,
        suite,
        oracle: task.success_oracle.clone(),
        budget: input.budget.clone(),
    };
    super::validate_request(&request, &task, &request.suite)?;
    Ok(request)
}
