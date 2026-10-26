use super::{Error, accounting, records, run};
use crate::{authorization::EvaluationBinding, owner, store::{WorldSnapshot, WorldTransaction}};
use world_protocol::{
    budget::{Budget, Usage},
    evaluation::{EvaluationArm, EvaluationExecution, EvaluationFailure, TestRevision},
    ids::{CaseId, EvaluationId, WorldRef},
    operation::{CancellationState, OperationPhase},
    releases::BranchRef,
    time::Timestamp,
};

pub(crate) struct ExecutionBounds {
    pub deadline: Timestamp,
    pub budget: Budget,
    pub usage: Usage,
    pub branch: BranchRef,
}

pub(crate) fn execution_case_id(
    world: &WorldRef,
    evaluation: &EvaluationId,
    test: &TestRevision,
    arm: &EvaluationArm,
) -> Result<CaseId, Error> {
    let digest = records::digest(&("world.evaluation.case.v1", world, evaluation, test, arm))?;
    CaseId::try_new(format!("case-{}", &digest.as_str()[7..]))
        .map_err(|_| EvaluationFailure::InternalFault.into())
}

/// The execution principal receives only the durable claimed work, never oracle answers.
pub(crate) async fn require_execution_binding(
    tx: &WorldTransaction<'_>,
    binding: &EvaluationBinding,
    now: &Timestamp,
) -> Result<ExecutionBounds, Error> {
    require_binding(Reader::Transaction(tx), binding, now).await
}
pub(crate) async fn require_execution_binding_snapshot(
    snapshot: &WorldSnapshot<'_>, binding: &EvaluationBinding, now: &Timestamp,
) -> Result<ExecutionBounds, Error> {
    require_binding(Reader::Snapshot(snapshot), binding, now).await
}
#[derive(Clone, Copy)]
enum Reader<'a, 'b> { Transaction(&'a WorldTransaction<'b>), Snapshot(&'a WorldSnapshot<'b>) }
impl<'a, 'b> Reader<'a, 'b> {
    fn world(self) -> &'a WorldRef { match self { Self::Transaction(tx) => tx.world(), Self::Snapshot(snapshot) => snapshot.world() } }
}
async fn require_binding(reader: Reader<'_, '_>, binding: &EvaluationBinding, now: &Timestamp) -> Result<ExecutionBounds, Error> {
    let state = match reader {
        Reader::Transaction(tx) => run::load(tx, &binding.evaluation_id).await?.ok_or(EvaluationFailure::BasisChanged)?,
        Reader::Snapshot(snapshot) => run::read_snapshot(snapshot, &binding.evaluation_id).await?,
    };
    let request = &state.request;
    if request.world != *reader.world()
        || binding.task.world != *reader.world()
        || binding.candidate_id != request.candidate_id
        || binding.branch != state.branch
        || binding.task.id != request.suite.task_id
        || binding.task.revision != request.suite.task_revision
        || binding.run_id != state.run.id
        || !matches!(state.report.execution, EvaluationExecution::Running)
        || binding.case_id
            != execution_case_id(reader.world(), &request.id, &binding.test, &binding.arm)?
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    let frozen = match reader {
        Reader::Transaction(tx) => records::suite(tx, &request.suite.id, request.suite.revision).await?,
        Reader::Snapshot(snapshot) => records::suite_snapshot(snapshot, &request.suite.id, request.suite.revision).await?,
    };
    let task = match reader {
        Reader::Transaction(tx) => records::task(tx, &binding.task.id, binding.task.revision).await?,
        Reader::Snapshot(snapshot) => records::task_snapshot(snapshot, &binding.task.id, binding.task.revision).await?,
    };
    super::validate_request(request, &task, &frozen)?;
    let tests = match reader {
        Reader::Transaction(tx) => records::tests(tx, &frozen.tests).await?,
        Reader::Snapshot(snapshot) => records::tests_snapshot(snapshot, &frozen.tests).await?,
    };
    let test_index = tests
        .iter()
        .position(|test| test.id == binding.test.id && test.revision == binding.test.revision)
        .ok_or(EvaluationFailure::BasisChanged)?;
    let arm_index = frozen
        .arms
        .iter()
        .position(|arm| arm == &binding.arm)
        .ok_or(EvaluationFailure::BasisChanged)?;
    let ordinal = test_index
        .checked_mul(frozen.arms.len())
        .and_then(|index| index.checked_add(arm_index))
        .and_then(|ordinal| u32::try_from(ordinal).ok())
        .ok_or(EvaluationFailure::InternalFault)?;
    let input_digest = records::digest(&(
        &request.id,
        ordinal,
        &tests[test_index],
        &binding.arm,
        &state.report.basis_digest,
    ))?;
    let expected_step =
        world_protocol::ids::StepId::try_new(format!("eval-{}", &input_digest.as_str()[7..]))
            .map_err(|_| EvaluationFailure::InternalFault)?;
    let step = match reader {
        Reader::Transaction(tx) => owner::read_step(tx, &binding.run_id, &binding.step_id).await?,
        Reader::Snapshot(snapshot) => owner::read_step_snapshot(snapshot, &binding.run_id, &binding.step_id).await?,
    }.ok_or(EvaluationFailure::BasisChanged)?;
    let current = match reader {
        Reader::Transaction(tx) => owner::read_run(tx, &binding.run_id).await?,
        Reader::Snapshot(snapshot) => owner::read_run_snapshot(snapshot, &binding.run_id).await?,
    };
    let operation = match reader {
        Reader::Transaction(tx) => owner::read_operation(tx, &current.operation.operation_id).await?,
        Reader::Snapshot(snapshot) => owner::read_operation_snapshot(snapshot, &current.operation.operation_id).await?,
    };
    if binding.step_id != expected_step
        || step.input_digest != input_digest
        || step.ordinal != ordinal
        || step.kind != "world.evaluation.case"
        || step.phase != OperationPhase::Running
        || step.result.is_some()
        || step.failure.is_some()
        || current.operation.operation_id != state.run.operation.operation_id
        || current.branch_id.as_ref() != Some(&state.submitted_branch.id)
        || current.branch_revision != Some(state.submitted_branch.revision)
        || state.run.branch_id != current.branch_id || state.run.branch_revision != current.branch_revision
        || current.release_id.as_ref() != Some(&request.basis.release_id)
        || current.activation_lock_id.as_ref() != Some(&request.basis.activation_lock_id)
        || current.budget != request.budget
        || operation.progress.run_id.as_ref() != Some(&binding.run_id)
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    if operation.cancellation != CancellationState::NotRequested {
        return Err(EvaluationFailure::Cancelled.into());
    }
    if !matches!(
        operation.phase,
        OperationPhase::Admitted | OperationPhase::Running
    ) {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    let captured = match reader {
        Reader::Transaction(tx) => crate::releases::read_branch_revision(tx, &state.branch).await?,
        Reader::Snapshot(snapshot) => crate::releases::read_branch_revision_snapshot(snapshot, &state.branch).await?,
    }.ok_or(EvaluationFailure::BasisChanged)?;
    let submitted = match reader {
        Reader::Transaction(tx) => crate::releases::read_branch_revision(tx, &state.submitted_branch).await?,
        Reader::Snapshot(snapshot) => crate::releases::read_branch_revision_snapshot(snapshot, &state.submitted_branch).await?,
    }.ok_or(EvaluationFailure::BasisChanged)?;
    run::require_testing_transition(&submitted, &captured)?;
    if captured.status != world_protocol::learning::ChangeStatus::Testing
        || captured.candidate_id != binding.candidate_id
        || captured.task_id != binding.task.id
        || captured.task_revision != binding.task.revision
        || captured.basis != request.basis
        || records::digest(&captured.compile)? != state.compile_digest
        || crate::compiler::model_digest(&captured.compile).map_err(Error::Compile)?
            != state.model_digest
    {
        return Err(EvaluationFailure::BasisChanged.into());
    }
    let elapsed = now
        .unix_millis()
        .checked_sub(state.started_at.unix_millis())
        .and_then(|elapsed| u64::try_from(elapsed).ok())
        .ok_or(EvaluationFailure::InternalFault)?;
    let mut usage = state.report.usage.clone();
    usage.elapsed.0 = usage.elapsed.0.max(elapsed);
    accounting::check(&usage, &request.budget, now)?;
    let wall = i64::try_from(request.budget.max_wall_time.0)
        .ok()
        .and_then(|duration| state.started_at.unix_millis().checked_add(duration))
        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
        .ok_or(EvaluationFailure::InternalFault)?;
    let mut deadline =
        Timestamp::try_new(wall.to_rfc3339()).map_err(|_| EvaluationFailure::InternalFault)?;
    if let Some(limit) = &request.budget.deadline {
        deadline = deadline.min(limit.clone());
    }
    if &deadline <= now {
        return Err(EvaluationFailure::BudgetExhausted {
            dimension: world_protocol::budget::BudgetDimension::Deadline,
        }
        .into());
    }
    Ok(ExecutionBounds {
        deadline,
        budget: request.budget.clone(),
        usage,
        branch: state.branch,
    })
}
