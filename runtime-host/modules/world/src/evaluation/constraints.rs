use std::collections::BTreeSet;

use world_protocol::{
    actions::EffectDisposition,
    bindings::Entrypoint,
    budget::Budget,
    ids::WorldRef,
    learning::{Case, CaseOrigin, OracleSpec, TaskContract, TestCase, TestPurpose},
    materials::BlobRef,
};

use super::{ConstraintFailure, invalid};

pub(crate) fn validate_task(task: &TaskContract) -> Result<(), ConstraintFailure> {
    if task.revision.0 == 0 || task.goal.trim().is_empty() {
        return Err(invalid("task.goal"));
    }
    crate::definitions::validate_value_type(&task.input_type)
        .map_err(|failure| ConstraintFailure::Definition { failure })?;
    for expression in task.hard_constraints.iter().chain(&task.stop_conditions) {
        crate::definitions::validate_expression(expression)
            .map_err(|failure| ConstraintFailure::Definition { failure })?;
    }
    validate_budget(&task.budget)?;
    validate_oracle(&task.success_oracle)?;
    if task.required_suites.is_empty() {
        return Err(invalid("task.requiredSuites"));
    }
    if task.required_suites.iter().collect::<BTreeSet<_>>().len() != task.required_suites.len()
        || task.allowed_effects.iter().collect::<BTreeSet<_>>().len() != task.allowed_effects.len()
    {
        return Err(ConstraintFailure::Duplicate);
    }
    Ok(())
}

pub(crate) fn validate_case(task: &TaskContract, case: &Case) -> Result<(), ConstraintFailure> {
    validate_task(task)?;
    if case.world != task.world {
        return Err(ConstraintFailure::CrossWorld);
    }
    if case.task_id != task.id {
        return Err(ConstraintFailure::TaskMismatch);
    }
    if case.task_revision != task.revision {
        return Err(ConstraintFailure::VersionMismatch);
    }
    crate::definitions::validate_value(&task.input_type, false, &case.input)
        .map_err(|failure| ConstraintFailure::Definition { failure })?;
    if case.observable_trace.byte_size == 0 {
        return Err(ConstraintFailure::MissingTrace);
    }
    if case.access.revision.0 == 0 || case.retention.revision.0 == 0 {
        return Err(invalid("case.access"));
    }
    let mut receipts = BTreeSet::new();
    for receipt in &case.read_receipts {
        if receipt.world != case.world {
            return Err(ConstraintFailure::CrossWorld);
        }
        if receipt.release_id != case.release_id
            || receipt.activation_lock_id != case.activation_lock_id
        {
            return Err(ConstraintFailure::VersionMismatch);
        }
        if !receipts.insert(&receipt.id) {
            return Err(ConstraintFailure::Duplicate);
        }
        if receipt.observed_at > case.occurred_at {
            return Err(ConstraintFailure::InvalidReceipt);
        }
        if receipt
            .basis
            .iter()
            .any(|basis| basis.binding.world != case.world)
        {
            return Err(ConstraintFailure::CrossWorld);
        }
    }
    let mut source_receipts = BTreeSet::new();
    for receipt in &case.source_receipts {
        if !source_receipts.insert(&receipt.id) {
            return Err(ConstraintFailure::Duplicate);
        }
        if receipt.observed_at > case.occurred_at {
            return Err(ConstraintFailure::InvalidReceipt);
        }
        validate_evidence_world(&case.world, &receipt.evidence)?;
    }
    validate_evidence_world(&case.world, &case.evidence)?;
    if case
        .used_definitions
        .iter()
        .any(|reference| reference.world != case.world || reference.revision.0 == 0)
    {
        return Err(ConstraintFailure::CrossWorld);
    }
    if case.used_definitions.iter().collect::<BTreeSet<_>>().len() != case.used_definitions.len() {
        return Err(ConstraintFailure::Duplicate);
    }
    match &case.origin {
        CaseOrigin::Replay {
            parent_case_id,
            basis,
        } => {
            if parent_case_id == &case.id {
                return Err(invalid("case.origin.parentCaseId"));
            }
            if basis.release_id != case.release_id
                || basis.activation_lock_id != case.activation_lock_id
            {
                return Err(ConstraintFailure::VersionMismatch);
            }
        }
        CaseOrigin::Synthetic { assumptions, .. } => {
            for expression in assumptions {
                crate::definitions::validate_expression(expression)
                    .map_err(|failure| ConstraintFailure::Definition { failure })?;
            }
        }
        CaseOrigin::Recorded | CaseOrigin::Fixture => {}
    }
    Ok(())
}

pub(crate) fn validate_test(task: &TaskContract, test: &TestCase) -> Result<(), ConstraintFailure> {
    validate_task(task)?;
    if test.world != task.world {
        return Err(ConstraintFailure::CrossWorld);
    }
    if test.task_id != task.id {
        return Err(ConstraintFailure::TaskMismatch);
    }
    if test.task_revision != task.revision || test.scope != task.scope {
        return Err(ConstraintFailure::VersionMismatch);
    }
    if test.revision.0 == 0 {
        return Err(invalid("test.revision"));
    }
    validate_blob(&test.fixture)?;
    validate_blob(&test.expected)?;
    validate_oracle(&test.oracle)?;
    if test.purpose == TestPurpose::Counterexample && !test.protected {
        return Err(ConstraintFailure::ProtectedCounterexample {
            test_case_id: test.id.clone(),
        });
    }
    validate_evidence_world(&test.world, &test.evidence)
}

pub(super) fn validate_budget(budget: &Budget) -> Result<(), ConstraintFailure> {
    if budget.max_wall_time.0 == 0 {
        return Err(invalid("budget.maxWallTime"));
    }
    if budget.max_steps == 0 {
        return Err(invalid("budget.maxSteps"));
    }
    if budget
        .max_cost
        .as_ref()
        .is_some_and(|cost| cost.amount.as_str().starts_with('-'))
    {
        return Err(invalid("budget.maxCost"));
    }
    Ok(())
}

pub(super) fn validate_oracle(oracle: &OracleSpec) -> Result<(), ConstraintFailure> {
    match oracle {
        OracleSpec::Program { implementation, .. } => {
            let valid_entry = match &implementation.entrypoint {
                Entrypoint::Builtin { registration, revision } => {
                    !registration.trim().is_empty() && revision.0 > 0
                }
                Entrypoint::Native {
                    registration,
                    host_build,
                } => !registration.trim().is_empty() && host_build.as_str().starts_with("sha256:"),
                Entrypoint::Wasm { world, interface } => {
                    !world.trim().is_empty() && !interface.trim().is_empty()
                }
                Entrypoint::Process { executable, .. } => !executable.trim().is_empty(),
            };
            if !valid_entry || implementation.contracts.is_empty() {
                return Err(invalid("oracle.implementation"));
            }
        }
        // Accepted is only submission acknowledgement, never independent completion proof.
        OracleSpec::SourceReceipt {
            required_disposition,
            ..
        } => {
            if !matches!(
                required_disposition,
                EffectDisposition::Applied | EffectDisposition::NotApplied
            ) {
                return Err(invalid("oracle.requiredDisposition"));
            }
        }
        OracleSpec::Human { .. } => {}
    }
    Ok(())
}

pub(super) fn validate_blob(blob: &BlobRef) -> Result<(), ConstraintFailure> {
    if blob.byte_size == 0 {
        return Err(invalid("blob.byteSize"));
    }
    Ok(())
}

fn validate_evidence_world(
    world: &WorldRef,
    evidence: &[world_protocol::ids::EvidenceRef],
) -> Result<(), ConstraintFailure> {
    if evidence.iter().any(|reference| reference.world != *world) {
        return Err(ConstraintFailure::CrossWorld);
    }
    Ok(())
}
