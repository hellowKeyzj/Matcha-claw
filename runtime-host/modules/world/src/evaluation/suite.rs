use std::collections::{BTreeMap, BTreeSet};

use world_protocol::{
    evaluation::{EvaluationArm, EvaluationRequest, FrozenSuite},
    learning::{DatasetSplit, TaskContract, TestCase, TestPurpose},
};

use super::{ConstraintFailure, constraints::validate_budget, invalid, validate_test};

pub(crate) fn validate_suite(
    task: &TaskContract,
    suite: &FrozenSuite,
    tests: &[TestCase],
    previous: Option<(&FrozenSuite, &[TestCase])>,
) -> Result<(), ConstraintFailure> {
    if suite.world != task.world {
        return Err(ConstraintFailure::CrossWorld);
    }
    if suite.task_id != task.id {
        return Err(ConstraintFailure::TaskMismatch);
    }
    if suite.task_revision != task.revision || suite.revision.0 == 0 {
        return Err(ConstraintFailure::VersionMismatch);
    }
    if !task.required_suites.contains(&suite.id) {
        return Err(invalid("suite.id"));
    }
    validate_conditions(suite)?;
    if suite.tests.is_empty()
        || suite.acceptance.is_empty()
        || suite.training_before > suite.holdout_from
    {
        return Err(invalid("suite.tests"));
    }
    let mut exact_tests = BTreeMap::new();
    let mut holdout_families = BTreeSet::new();
    let mut has_training = false;
    for test in tests {
        validate_test(task, test)?;
        if test.task_revision != task.revision || test.scope != task.scope {
            return Err(ConstraintFailure::VersionMismatch);
        }
        if test.oracle != task.success_oracle {
            return Err(ConstraintFailure::OracleNotIndependent);
        }
        if exact_tests.insert(&test.id, test).is_some() {
            return Err(ConstraintFailure::Duplicate);
        }
        match test.split {
            DatasetSplit::Train => {
                has_training = true;
                if test.occurred_at >= suite.training_before {
                    return Err(invalid("suite.trainingBefore"));
                }
            }
            DatasetSplit::Holdout => {
                if !test.protected || test.occurred_at < suite.holdout_from {
                    return Err(invalid("suite.holdoutFrom"));
                }
                holdout_families.insert(&test.origin_family);
            }
            DatasetSplit::Dev => {}
        }
    }
    if !has_training || holdout_families.is_empty() {
        return Err(invalid("suite.split"));
    }
    for test in tests {
        if test.split != DatasetSplit::Holdout && holdout_families.contains(&test.origin_family) {
            return Err(ConstraintFailure::HoldoutLeak {
                test_case_id: test.id.clone(),
            });
        }
    }
    if suite.tests.len() != exact_tests.len() {
        return Err(invalid("suite.tests"));
    }
    let mut members = BTreeSet::new();
    for reference in &suite.tests {
        if !members.insert(&reference.id) {
            return Err(ConstraintFailure::Duplicate);
        }
        if !exact_tests
            .get(&reference.id)
            .is_some_and(|test| test.revision == reference.revision)
        {
            return Err(ConstraintFailure::VersionMismatch);
        }
    }
    let mut protected = BTreeSet::new();
    for reference in &suite.protected_counterexamples {
        if !protected.insert(&reference.id) {
            return Err(ConstraintFailure::Duplicate);
        }
        if !exact_tests.get(&reference.id).is_some_and(|test| {
            test.revision == reference.revision
                && test.protected
                && test.purpose == TestPurpose::Counterexample
        }) {
            return Err(ConstraintFailure::ProtectedCounterexample {
                test_case_id: reference.id.clone(),
            });
        }
    }
    for test in tests
        .iter()
        .filter(|test| test.purpose == TestPurpose::Counterexample)
    {
        if !protected.contains(&test.id) {
            return Err(ConstraintFailure::ProtectedCounterexample {
                test_case_id: test.id.clone(),
            });
        }
    }
    validate_arms(&suite.arms)?;
    if suite.plans.len() != suite.arms.len() {
        return Err(invalid("suite.plans"));
    }
    for arm in &suite.arms {
        let mut matching = suite.plans.iter().filter(|selection| &selection.arm == arm);
        let selection = matching.next().ok_or_else(|| invalid("suite.plans.arm"))?;
        if matching.next().is_some() {
            return Err(ConstraintFailure::Duplicate);
        }
        let revision = match &selection.plan {
            world_protocol::evaluation::PlanReference::Strategy(reference) => reference.revision,
            world_protocol::evaluation::PlanReference::Abstraction { revision, .. } => *revision,
            world_protocol::evaluation::PlanReference::Frozen(plan) => {
                if super::frozen_plan::validate_shape(&suite.world, arm, plan).is_err() {
                    return Err(invalid("suite.plans.frozen"));
                }
                plan.strategy.revision
            }
        };
        if revision.0 == 0 {
            return Err(ConstraintFailure::VersionMismatch);
        }
        if !matches!(arm, EvaluationArm::Candidate | EvaluationArm::Ablation { .. })
            && !matches!(selection.plan, world_protocol::evaluation::PlanReference::Frozen(_))
        {
            return Err(invalid("suite.plans.baseline"));
        }
    }
    if let Some((old_suite, old_tests)) = previous {
        if old_suite.world != suite.world
            || old_suite.id != suite.id
            || old_suite.task_id != suite.task_id
        {
            return Err(ConstraintFailure::TaskMismatch);
        }
        if old_suite.revision.0.checked_add(1) != Some(suite.revision.0) {
            return Err(ConstraintFailure::VersionMismatch);
        }
        for old_test in old_tests
            .iter()
            .filter(|test| test.protected || test.purpose == TestPurpose::Counterexample)
        {
            if exact_tests.get(&old_test.id).copied() != Some(old_test) {
                return Err(ConstraintFailure::ProtectedCounterexample {
                    test_case_id: old_test.id.clone(),
                });
            }
        }
    } else if suite.revision.0 != 1 {
        return Err(ConstraintFailure::VersionMismatch);
    }
    Ok(())
}

pub(crate) fn validate_request(
    request: &EvaluationRequest,
    task: &TaskContract,
    frozen: &FrozenSuite,
) -> Result<(), ConstraintFailure> {
    if request.world != task.world || frozen.world != task.world {
        return Err(ConstraintFailure::CrossWorld);
    }
    if &request.suite != frozen {
        return Err(invalid("request.suite"));
    }
    validate_conditions(frozen)?;
    if request.oracle != task.success_oracle {
        return Err(ConstraintFailure::OracleNotIndependent);
    }
    if request.basis.activation_lock_id != frozen.conditions.tool_lock {
        return Err(ConstraintFailure::VersionMismatch);
    }
    validate_budget(&request.budget)?;
    if !super::accounting::within(&request.budget, &frozen.conditions.total_budget) {
        return Err(invalid("request.budget"));
    }
    Ok(())
}

fn validate_conditions(suite: &FrozenSuite) -> Result<(), ConstraintFailure> {
    validate_budget(&suite.conditions.total_budget)?;
    if suite.conditions.known_at > suite.frozen_at {
        return Err(invalid("suite.conditions.knownAt"));
    }
    Ok(())
}

fn validate_arms(arms: &[EvaluationArm]) -> Result<(), ConstraintFailure> {
    for required in [
        EvaluationArm::Candidate,
        EvaluationArm::ToolMemory,
        EvaluationArm::StaticOntology,
        EvaluationArm::AppendOnly,
    ] {
        if arms.iter().filter(|arm| **arm == required).count() != 1 {
            return Err(invalid("suite.arms"));
        }
    }
    for (index, arm) in arms.iter().enumerate() {
        if arms[..index].contains(arm) {
            return Err(ConstraintFailure::Duplicate);
        }
        if let EvaluationArm::Ablation {
            disabled_definitions,
        } = arm
        {
            if disabled_definitions.is_empty()
                || disabled_definitions.iter().collect::<BTreeSet<_>>().len()
                    != disabled_definitions.len()
            {
                return Err(invalid("suite.arms.disabledDefinitions"));
            }
        }
    }
    Ok(())
}
