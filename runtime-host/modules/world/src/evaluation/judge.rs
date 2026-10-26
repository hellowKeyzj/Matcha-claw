use super::{
    BranchExecution, ConstraintFailure, Error, ExecutedCase, OracleResult, accounting,
    qualify_oracle,
};
use crate::store::WorldTransaction;
use foundation::pipeline::PipelineContext;
use world_protocol::{
    authorization::PolicyVerdict,
    bindings::ActivationLock,
    evaluation::{AcceptanceCriterion, EvaluationFailure, EvaluationRequest},
    learning::{CaseOutcome, OracleSpec, TaskContract, TestCase},
    time::Timestamp,
};

pub(super) struct Judgement {
    pub result: OracleResult,
    pub human: Option<super::HumanVerification>,
}

pub(super) async fn judge(
    execution: &dyn BranchExecution,
    request: &EvaluationRequest,
    task: &TaskContract,
    test: &TestCase,
    observed: &ExecutedCase,
    expected: &[u8],
    lock: &ActivationLock,
    proposer: &world_protocol::ids::ActorId,
    pipeline: &PipelineContext,
) -> Result<Judgement, Error> {
    let now = accounting::now();
    let mut human_verification = None;
    let mut result = match &test.oracle {
        OracleSpec::Program { .. } => {
            qualify_oracle(
                &test.oracle,
                lock,
                &observed.implementations,
                proposer,
                None,
                &now,
            )?;
            let result = execution
                .check_program(&test.oracle, expected, observed, task, pipeline)
                .await?;
            if let Some(measurement) = &result.measurements {
                if result.custody.is_none() {
                    return Err(ConstraintFailure::OracleUnverified.into());
                }
                let (required, present) = super::oracle::expected_counts(
                    expected,
                    &task.world,
                    task.budget.max_bytes.min(usize::MAX as u64) as usize,
                )
                .map_err(|failure| {
                    Error::Composition(crate::extensions::invocation::CompositionFailure::Slot(
                        world_protocol::slots::SlotFailure::Evaluation(failure),
                    ))
                })?;
                if measurement
                    .evidence_required
                    .is_some_and(|value| value != required)
                    || measurement
                        .conflicts_present
                        .is_some_and(|value| value != present)
                {
                    return Err(super::invalid("oracle.measurements.denominator").into());
                }
            }
            result
        }
        OracleSpec::Human { .. } => {
            let human = execution
                .check_human(&test.oracle, observed, pipeline)
                .await?;
            qualify_oracle(
                &test.oracle,
                lock,
                &observed.implementations,
                proposer,
                Some((&human.actor, &human.decision)),
                &now,
            )?;
            if human.observed_digest != observed.observed.digest
                || human.decision.policy_epoch != request.suite.conditions.policy_epoch
                || human.decision.grant_epoch != request.suite.conditions.grant_epoch
            {
                return Err(ConstraintFailure::OracleUnverified.into());
            }
            let passed = human.passed;
            human_verification = Some(human);
            OracleResult {
                custody: None,
                passed,
                usage: accounting::zero(),
                hard_checks: Vec::new(),
                measurements: None,
            }
        }
        OracleSpec::SourceReceipt { .. } => {
            let (receipt, verification) = observed
                .source_verification
                .as_ref()
                .ok_or(ConstraintFailure::OracleUnverified)?;
            if verification.read_receipt.world != request.world
                || verification.read_receipt.branch_id.as_ref() != Some(&request.branch_id)
                || verification.read_receipt.release_id != request.basis.release_id
                || verification.read_receipt.activation_lock_id != request.basis.activation_lock_id
                || verification.read_receipt.policy_epoch != request.suite.conditions.policy_epoch
                || verification.read_receipt.grant_epoch != request.suite.conditions.grant_epoch
                || verification
                    .read_receipt
                    .expires_at
                    .as_ref()
                    .is_some_and(|expiry| expiry <= &now)
                || !observed.case.source_receipts.contains(receipt)
            {
                return Err(ConstraintFailure::OracleUnverified.into());
            }
            OracleResult {
                custody: None,
                passed: super::verify_source_receipt(&test.oracle, receipt, verification)?,
                usage: accounting::zero(),
                hard_checks: Vec::new(),
                measurements: None,
            }
        }
    };
    // An indeterminate effect, missing evidence or cancellation cannot become success
    // merely because a checker compared one output value successfully.
    if matches!(
        observed.case.outcome,
        CaseOutcome::Inconclusive { .. } | CaseOutcome::Cancelled { .. }
    ) {
        return Err(ConstraintFailure::OracleUnverified.into());
    }
    if result.hard_checks.iter().enumerate().any(|(index, check)| {
        result.hard_checks[..index].iter().any(|previous| previous.name == check.name)
            || !check.evidence.iter().all(|reference| reference.world == request.world)
            || !(0..task.hard_constraints.len()).any(|index| check.name == format!("hard_constraint_{index}"))
                && !request.suite.acceptance.iter().any(|criterion| matches!(criterion, AcceptanceCriterion::HardCheck { name } if name == &check.name))
    }) { return Err(EvaluationFailure::ExecutionFailed.into()); }
    if let Some(measurement) = &result.measurements {
        let invalid_count =
            |numerator: Option<u64>, denominator: Option<u64>| match (numerator, denominator) {
                (Some(numerator), Some(denominator)) => numerator > denominator,
                (None, None) => false,
                _ => true,
            };
        if invalid_count(measurement.error_merges, measurement.identity_decisions)
            || invalid_count(
                measurement.evidence_satisfied,
                measurement.evidence_required,
            )
            || invalid_count(
                measurement.conflicts_detected,
                measurement.conflicts_present,
            )
            || measurement
                .migration_cost
                .as_ref()
                .is_some_and(|cost| cost.as_str().starts_with('-'))
        {
            return Err(EvaluationFailure::ExecutionFailed.into());
        }
    }
    result.passed &= observed.business_failure.is_none()
        && !matches!(observed.case.outcome, CaseOutcome::Failed { .. });
    Ok(Judgement {
        result,
        human: human_verification,
    })
}

/// Receipt-shaped JSON is not proof. Match the independently committed source facts.
pub(super) async fn confirm_source(
    tx: &WorldTransaction<'_>,
    receipt: &world_protocol::actions::SourceReceipt,
    verification: &world_protocol::actions::VerificationReceipt,
) -> Result<(), Error> {
    let world = tx.world();
    let source = tx.query_opt(
            "SELECT body FROM world_source_receipt WHERE tenant_id=$1 AND world_id=$2 AND receipt_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &receipt.id.as_str()],
        ).await?.ok_or(ConstraintFailure::OracleUnverified)?;
    let verified = tx.query_opt(
            "SELECT body FROM world_verification_receipt WHERE tenant_id=$1 AND world_id=$2 AND verification_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &verification.id.as_str()],
        ).await?.ok_or(ConstraintFailure::OracleUnverified)?;
    if super::records::decode::<world_protocol::actions::SourceReceipt>(source.get("body"))?
        != *receipt
        || super::records::decode::<world_protocol::actions::VerificationReceipt>(
            verified.get("body"),
        )? != *verification
    {
        return Err(ConstraintFailure::OracleUnverified.into());
    }
    Ok(())
}

pub(super) async fn confirm_human(
    tx: &WorldTransaction<'_>,
    human: &super::HumanVerification,
    now: &Timestamp,
) -> Result<(), Error> {
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT actor_id,decision FROM world_auth_decision WHERE tenant_id=$1 AND world_id=$2 AND decision_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &human.decision.id.as_str()],
    ).await?.ok_or(ConstraintFailure::OracleUnverified)?;
    if row.get::<_, String>("actor_id") != human.actor.as_str()
        || super::records::decode::<world_protocol::authorization::Decision>(row.get("decision"))?
            != human.decision
        || human.decision.verdict != PolicyVerdict::Allow
        || human
            .decision
            .expires_at
            .as_ref()
            .is_some_and(|expiry| expiry <= now)
    {
        return Err(ConstraintFailure::OracleUnverified.into());
    }
    Ok(())
}
