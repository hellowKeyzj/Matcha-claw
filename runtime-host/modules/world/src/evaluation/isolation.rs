use std::collections::BTreeSet;

use world_protocol::{
    ids::{
        CandidateId, CaseId, Digest, EvaluationId, OriginFamilyId, Revision, TaskId, TestCaseId,
        WorldRef,
    },
    learning::{DatasetSplit, TestCase},
    materials::BlobRef,
};

use super::ConstraintFailure;

/// The candidate receives a fixture, never the frozen answer or oracle binding.
/// This deliberately is not TestCase and has no Serialize implementation.
pub(crate) struct CandidateInput<'a> {
    pub world: &'a WorldRef,
    pub evaluation_id: &'a EvaluationId,
    pub candidate_id: &'a CandidateId,
    pub branch: &'a world_protocol::releases::BranchRef,
    pub compile_digest: &'a Digest,
    pub model_digest: &'a Digest,
    pub test_id: &'a TestCaseId,
    pub test_revision: Revision,
    pub origin_family: &'a OriginFamilyId,
    pub parent_case_id: Option<&'a CaseId>,
    pub run_id: &'a world_protocol::ids::RunId,
    pub step_id: &'a world_protocol::ids::StepId,
    pub task_id: &'a TaskId,
    pub task_revision: Revision,
    pub fixture: &'a BlobRef,
    pub input: &'a world_protocol::value::Value,
    pub goal: &'a str,
    pub input_type: &'a world_protocol::value::ValueType,
    pub hard_constraints: &'a [world_protocol::expression::ExpressionIr],
    pub allowed_effects: &'a [world_protocol::expression::Effect],
    pub budget: &'a world_protocol::budget::Budget,
    pub stop_conditions: &'a [world_protocol::expression::ExpressionIr],
}

impl<'a> CandidateInput<'a> {
    pub(super) fn new(
        state: &'a super::EvaluationRun,
        step: &'a crate::owner::StepRecord,
        task: &'a world_protocol::learning::TaskContract,
        test: &'a TestCase,
        input: &'a world_protocol::value::Value,
    ) -> Self {
        Self {
            world: &test.world,
            evaluation_id: &state.request.id,
            candidate_id: &state.request.candidate_id,
            branch: &state.branch,
            compile_digest: &state.compile_digest,
            model_digest: &state.model_digest,
            test_id: &test.id,
            test_revision: test.revision,
            origin_family: &test.origin_family,
            parent_case_id: test.case_id.as_ref(),
            run_id: &state.run.id,
            step_id: &step.id,
            task_id: &test.task_id,
            task_revision: test.task_revision,
            fixture: &test.fixture,
            input,
            goal: &task.goal,
            input_type: &task.input_type,
            hard_constraints: &task.hard_constraints,
            allowed_effects: &task.allowed_effects,
            budget: &task.budget,
            stop_conditions: &task.stop_conditions,
        }
    }
}

/// Families, not just individual rows, are excluded from training. Returning a
/// borrowed allow-list prevents a caller from accidentally iterating holdout rows.
pub(crate) fn training_cases<'a>(
    tests: &'a [TestCase],
    held_out_families: &BTreeSet<OriginFamilyId>,
) -> Result<Vec<&'a TestCase>, ConstraintFailure> {
    let mut reserved: BTreeSet<_> = tests
        .iter()
        .filter(|test| test.split == DatasetSplit::Holdout)
        .map(|test| &test.origin_family)
        .collect();
    reserved.extend(held_out_families);
    let mut training = Vec::new();
    for test in tests
        .iter()
        .filter(|test| test.split == DatasetSplit::Train)
    {
        if reserved.contains(&test.origin_family) {
            return Err(ConstraintFailure::HoldoutLeak {
                test_case_id: test.id.clone(),
            });
        }
        training.push(test);
    }
    Ok(training)
}
