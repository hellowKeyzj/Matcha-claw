use super::{
    ConstraintFailure, Error, Measurements,
    records::{self, decode, digest, encode, revision},
};
use crate::{
    authorization::Admission,
    owner::{RunRecord, StepRecord},
    store::WorldTransaction,
};
use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::AccessMode,
    commit::CommittedRevision,
    evaluation::{
        CandidateVerdict, CaseEvaluation, EvaluationAssurance, EvaluationCoverage,
        EvaluationExecution, EvaluationReport, EvaluationRequest,
    },
    ids::{ActorId, EvaluationId, ResourceRef, Revision},
    learning::{Case, TaskContract, TestCase},
    operation::OperationPhase,
    time::Timestamp,
};

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct EvaluationRun {
    pub(super) request: EvaluationRequest,
    pub(super) submitted_branch: world_protocol::releases::BranchRef,
    pub(super) branch: world_protocol::releases::BranchRef,
    pub(super) compile_digest: world_protocol::ids::Digest,
    pub(super) model_digest: world_protocol::ids::Digest,
    pub(super) run: RunRecord,
    pub(super) proposer: ActorId,
    pub(super) revision: Revision,
    pub(super) started_at: Timestamp,
    pub(super) report: EvaluationReport,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct AcceptedResult {
    pub oracle_custody: Option<world_protocol::materials::BlobRef>,
    pub evaluation: CaseEvaluation,
    pub case: Option<Case>,
    pub witness: super::ExecutionWitness,
    pub hard_checks: Vec<world_protocol::evaluation::HardCheck>,
    pub measurements: Option<Measurements>,
}

pub(crate) async fn start(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    request: &EvaluationRequest,
    submitted_branch: &world_protocol::releases::BranchRef,
    run: &RunRecord,
    now: &Timestamp,
) -> Result<EvaluationRun, Error> {
    let frozen = records::suite(tx, &request.suite.id, request.suite.revision).await?;
    let task = records::task(tx, &frozen.task_id, frozen.task_revision).await?;
    let tests = records::tests(tx, &frozen.tests).await?;
    super::validate_request(request, &task, &frozen)?;
    // Revision evolution was checked at freeze. Re-read immutable members, not a request copy.
    let previous = if frozen.revision.0 > 1 {
        Some(records::suite(tx, &frozen.id, Revision(frozen.revision.0 - 1)).await?)
    } else {
        None
    };
    let previous_tests = match &previous {
        Some(previous) => records::tests(tx, &previous.tests).await?,
        None => Vec::new(),
    };
    super::validate_suite(
        &task,
        &frozen,
        &tests,
        previous
            .as_ref()
            .map(|old| (old, previous_tests.as_slice())),
    )?;
    require_owner_request(tx, admission.verified(), request, &run.operation.operation_id).await?;
    let current = crate::owner::require_run_invocation(tx, admission, &run.id).await?;
    require_run_basis(request, submitted_branch, &current, run)?;
    authorize_request(tx, admission, &task, request, now).await?;
    records::lock(tx, "evaluation", request.id.as_str()).await?;
    if let Some(existing) = load(tx, &request.id).await? {
        if existing.request != *request
            || existing.submitted_branch != *submitted_branch
            || existing.run.id != run.id
            || existing.run.operation.operation_id != run.operation.operation_id
        {
            return Err(ConstraintFailure::VersionMismatch.into());
        }
        return Ok(existing);
    }
    let world = tx.world().clone();
    let (branch, _) = crate::releases::read_candidate(tx, &request.candidate_id)
        .await
        .map_err(|error| Error::Release(Box::new(error)))?
        .ok_or(super::invalid("candidate.id"))?;
    if branch.id != request.branch_id
        || branch.task_id != task.id
        || branch.task_revision != task.revision
        || branch.basis != request.basis
        || branch.status != world_protocol::learning::ChangeStatus::Testing
    {
        return Err(ConstraintFailure::TaskMismatch.into());
    }
    let submitted = crate::releases::read_branch_revision(tx, submitted_branch).await?
        .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?;
    require_testing_transition(&submitted, &branch)?;
    let report = EvaluationReport {
        world: world.clone(),
        id: request.id.clone(),
        candidate_id: request.candidate_id.clone(),
        suite_id: frozen.id.clone(),
        suite_revision: frozen.revision,
        basis_digest: digest(&request.basis)?,
        execution: EvaluationExecution::Running,
        verdict: CandidateVerdict::Pending,
        cases: Vec::new(),
        hard_checks: Vec::new(),
        estimates: Vec::new(),
        arms: Vec::new(),
        counterexamples: Vec::new(),
        coverage: EvaluationCoverage {
            tested: 0,
            total: tests.len() as u64,
            missing_tests: frozen.tests.clone(),
            missing_sources: request.basis.missing_sources.clone(),
            assumptions_used: !request.basis.assumptions.is_empty(),
        },
        assurance: EvaluationAssurance::Untested,
        usage: run.usage.clone(),
        completed_at: None,
    };
    let proposer = crate::learning::proposer(tx, &request.candidate_id)
        .await
        .map_err(|error| Error::Owner(error.into()))?;
    let state = EvaluationRun {
        branch: world_protocol::releases::BranchRef {
            world: branch.world.clone(),
            id: branch.id.clone(),
            revision: branch.revision,
        },
        compile_digest: digest(&branch.compile)?,
        model_digest: crate::compiler::model_digest(&branch.compile).map_err(Error::Compile)?,
        request: request.clone(),
        submitted_branch: submitted_branch.clone(),
        run: run.clone(),
        proposer,
        revision: Revision(1),
        started_at: now.clone(),
        report,
    };
    tx.execute(
        "INSERT INTO world_evaluation_run(tenant_id,world_id,evaluation_id,operation_id,run_id,revision,suite_id,suite_revision,branch_id,phase,basis,body) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,'running',$9,$10)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &request.id.as_str(), &run.operation.operation_id.as_str(), &run.id.as_str(), &frozen.id.as_str(), &revision(frozen.revision)?, &request.branch_id.as_str(), &encode(&request.basis)?, &encode(&state)?],
    ).await?;
    append_report(tx, &state).await?;
    Ok(state)
}

pub(super) fn require_testing_transition(
    submitted: &world_protocol::releases::WorldBranch,
    testing: &world_protocol::releases::WorldBranch,
) -> Result<(), Error> {
    use world_protocol::learning::ChangeStatus;
    if testing.status != ChangeStatus::Testing { return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into()); }
    let mut expected = submitted.clone();
    match submitted.status {
        ChangeStatus::Testing if submitted == testing => return Ok(()),
        ChangeStatus::Validated if testing.revision > submitted.revision => {
            expected.revision = testing.revision;
            expected.status = ChangeStatus::Testing;
        }
        _ => return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into()),
    }
    if expected != *testing { return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into()); }
    Ok(())
}

pub(super) async fn authorize(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    task: &TaskContract,
    state: &EvaluationRun,
    now: &Timestamp,
) -> Result<(), Error> {
    let durable = require_owner_report(tx, admission.verified(), &state.request.id).await?;
    if durable.request != state.request || durable.submitted_branch != state.submitted_branch
        || durable.branch != state.branch || durable.compile_digest != state.compile_digest
        || durable.model_digest != state.model_digest || durable.run.id != state.run.id
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    let current = crate::owner::require_run_invocation(tx, admission, &state.run.id).await?;
    require_run_basis(&state.request, &state.submitted_branch, &current, &state.run)?;
    authorize_request(tx, admission, task, &state.request, now).await
}

async fn authorize_request(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    task: &TaskContract,
    request: &EvaluationRequest,
    now: &Timestamp,
) -> Result<(), Error> {
    records::authorize(
        tx,
        admission,
        &task.scope,
        vec![ResourceRef::Branch {
            id: request.branch_id.clone(),
        }],
        AccessMode::Execute,
        Vec::new(),
        now,
    )
    .await?;
    if admission.decision().policy_epoch != request.suite.conditions.policy_epoch
        || admission.decision().grant_epoch != request.suite.conditions.grant_epoch
    {
        return Err(world_protocol::evaluation::EvaluationFailure::EpochChanged.into());
    }
    Ok(())
}

pub(super) async fn require_owner_request(
    tx: &WorldTransaction<'_>,
    verified: &crate::authorization::VerifiedInvocation,
    request: &EvaluationRequest,
    operation: &world_protocol::ids::OperationId,
) -> Result<(), Error> {
    let record = crate::owner::read_operation_record(tx, operation).await?;
    let world_protocol::api::WorldCommand::TestBranch(input) = record.input.command()? else {
        return Err(ConstraintFailure::VersionMismatch.into());
    };
    let confined = verified.bind_branch(tx, &input.branch.id).await?;
    record.identity.require_resume(&confined)?;
    let branch = crate::releases::read_branch_revision(tx, &input.branch).await?
        .ok_or(ConstraintFailure::VersionMismatch)?;
    let suite = records::suite(tx, &input.suite.id, input.suite.revision).await?;
    let task = records::task(tx, &branch.task_id, branch.task_revision).await?;
    let identity = digest(&("world.evaluation.operation.v1", tx.world(), operation))?;
    let expected = EvaluationRequest {
        world: tx.world().clone(),
        id: EvaluationId::try_new(format!("evaluation-{}", &identity.as_str()[7..]))
            .map_err(|_| super::invalid("evaluation.id"))?,
        candidate_id: branch.candidate_id,
        branch_id: branch.id,
        basis: branch.basis,
        suite,
        oracle: task.success_oracle.clone(),
        budget: input.budget.clone(),
    };
    super::validate_request(&expected, &task, &expected.suite)?;
    if input.branch.world != *tx.world() || input.suite.world != *tx.world()
        || record.receipt.accepted.world != request.world || expected != *request
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    Ok(())
}

/// Operation custody survives terminal reports; it is not a running-step execution proof.
pub(super) async fn require_owner_report(
    tx: &WorldTransaction<'_>,
    verified: &crate::authorization::VerifiedInvocation,
    id: &EvaluationId,
) -> Result<EvaluationRun, Error> {
    let state = load(tx, id).await?.ok_or(super::invalid("evaluation.id"))?;
    require_owner_request(tx, verified, &state.request, &state.run.operation.operation_id).await?;
    let current = crate::owner::read_run(tx, &state.run.id).await?;
    require_run_basis(&state.request, &state.submitted_branch, &current, &state.run)?;
    let captured = crate::releases::read_branch_revision(tx, &state.branch).await?
        .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?;
    let submitted = crate::releases::read_branch_revision(tx, &state.submitted_branch).await?
        .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?;
    require_testing_transition(&submitted, &captured)?;
    read_report_for_branch(tx, id, &captured).await?;
    Ok(state)
}

fn require_run_basis(
    request: &EvaluationRequest,
    submitted: &world_protocol::releases::BranchRef,
    current: &RunRecord,
    captured: &RunRecord,
) -> Result<(), Error> {
    if current.id != captured.id
        || current.operation.world != request.world
        || current.operation.operation_id != captured.operation.operation_id
        || current.operation.incarnation != captured.operation.incarnation
        || current.branch_id.as_ref() != Some(&submitted.id)
        || current.branch_revision != Some(submitted.revision)
        || current.release_id.as_ref() != Some(&request.basis.release_id)
        || current.activation_lock_id.as_ref() != Some(&request.basis.activation_lock_id)
        || current.budget != request.budget
        || captured.branch_id != current.branch_id
        || captured.branch_revision != current.branch_revision
        || captured.release_id != current.release_id
        || captured.activation_lock_id != current.activation_lock_id
        || captured.budget != current.budget
        || submitted.world != request.world
        || submitted.id != request.branch_id
    {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    Ok(())
}

pub(super) async fn load(
    tx: &WorldTransaction<'_>,
    id: &EvaluationId,
) -> Result<Option<EvaluationRun>, Error> {
    let world = tx.world();
    tx.query_opt(
        "SELECT body FROM world_evaluation_run WHERE tenant_id=$1 AND world_id=$2 AND evaluation_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.map(|row| decode(row.get("body"))).transpose()
}

pub(super) async fn read_snapshot(
    snapshot: &crate::store::WorldSnapshot<'_>,
    id: &EvaluationId,
) -> Result<EvaluationRun, Error> {
    let world = snapshot.world();
    let row = snapshot.query_opt(
        "SELECT body FROM world_evaluation_run WHERE tenant_id=$1 AND world_id=$2 AND evaluation_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or(super::invalid("evaluation.id"))?;
    decode(row.get("body"))
}

/// A retained, still-running evaluation cannot be terminalized by generic failure cleanup.
pub(crate) async fn has_unsettled_execution(
    tx: &WorldTransaction<'_>,
    run: &world_protocol::ids::RunId,
) -> Result<bool, Error> {
    if tx.query_opt(
        "SELECT 1 FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND kind='world.evaluation.online_oracle' AND phase NOT IN ('completed','failed','cancelled_before_commit','cancelled_after_commit') LIMIT 1",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.as_str()],
    ).await?.is_some() {
        return Ok(true);
    }
    let mut after = String::new();
    loop {
        let rows = tx.query(
            "SELECT evaluation_id,operation_id,phase,body FROM world_evaluation_run WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3 AND evaluation_id>$4 ORDER BY evaluation_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &run.as_str(), &after],
        ).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("evaluation_id");
            let state: EvaluationRun = decode(row.get("body"))?;
            let running = matches!(state.report.execution, EvaluationExecution::Running);
            if state.run.id != *run
                || state.run.operation.world != *tx.world()
                || state.run.operation.operation_id.as_str() != row.get::<_, String>("operation_id")
                || state.request.id.as_str() != after
                || row.get::<_, String>("phase") != if running { "running" } else { "terminal" }
            {
                return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into());
            }
            read_report(tx, &state.request.id).await?;
            if running {
                return Ok(true);
            }
        }
        if done {
            return Ok(false);
        }
    }
}

/// Transfer must observe durable evaluations, not infer quiescence from an empty live set.
pub(crate) async fn has_unsettled_world(
    store: &crate::store::WorldStore,
    world: &world_protocol::ids::WorldRef,
) -> Result<bool, crate::owner::Error> {
    store.snapshot(world.clone(), |snapshot| Box::pin(async move {
        let world = snapshot.world();
        if snapshot.query_opt(
            "SELECT 1 FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND kind='world.evaluation.online_oracle' AND phase NOT IN ('completed','failed','cancelled_before_commit','cancelled_after_commit') LIMIT 1",
            &[&world.tenant_id.as_str(), &world.world_id.as_str()],
        ).await?.is_some() { return Ok(true); }
        let mut after = String::new();
        loop {
            let rows = snapshot.query(
                "SELECT e.evaluation_id,e.operation_id,e.run_id,e.revision,e.phase,e.body,r.revision AS report_revision,r.content_digest AS report_digest,r.body AS report_body FROM world_evaluation_run e LEFT JOIN LATERAL (SELECT revision,content_digest,body FROM world_evaluation_report WHERE tenant_id=e.tenant_id AND world_id=e.world_id AND evaluation_id=e.evaluation_id ORDER BY revision DESC LIMIT 1) r ON true WHERE e.tenant_id=$1 AND e.world_id=$2 AND e.evaluation_id>$3 ORDER BY e.evaluation_id LIMIT 256",
                &[&world.tenant_id.as_str(), &world.world_id.as_str(), &after],
            ).await?;
            let done = rows.len() < 256;
            for row in rows {
                after = row.get("evaluation_id");
                let state: EvaluationRun = decode(row.get("body"))?;
                let report: EvaluationReport = decode(row.get::<_, Option<serde_json::Value>>("report_body")
                    .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?)?;
                let running = matches!(report.execution, EvaluationExecution::Running);
                if state.request.world != *world || state.request.id.as_str() != after
                    || state.run.operation.world != *world
                    || state.run.operation.operation_id.as_str() != row.get::<_, String>("operation_id")
                    || state.run.id.as_str() != row.get::<_, String>("run_id")
                    || revision(state.revision)? != row.get::<_, i64>("revision")
                    || row.get::<_, Option<i64>>("report_revision") != Some(revision(state.revision)?)
                    || row.get::<_, String>("phase") != if running { "running" } else { "terminal" }
                    || report != state.report || report.world != *world || report.id != state.request.id
                    || report.candidate_id != state.request.candidate_id
                    || report.suite_id != state.request.suite.id
                    || report.suite_revision != state.request.suite.revision
                    || report.basis_digest != digest(&state.request.basis)?
                    || row.get::<_, Option<String>>("report_digest").as_deref() != Some(digest(&report)?.as_str()) {
                    return Err(Error::from(world_protocol::evaluation::EvaluationFailure::BasisChanged));
                }
                if running { return Ok(true); }
            }
            if done { return Ok(false); }
        }
    })).await.map_err(Into::into)
}

/// Trusted owner consumption. Public callers must use the current-authorized projection.
pub(crate) async fn read_report(
    tx: &WorldTransaction<'_>,
    id: &EvaluationId,
) -> Result<(EvaluationRequest, EvaluationReport), Error> {
    let state = load(tx, id).await?.ok_or(super::invalid("evaluation.id"))?;
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT revision,content_digest,body FROM world_evaluation_report WHERE tenant_id=$1 AND world_id=$2 AND evaluation_id=$3 ORDER BY revision DESC LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?.ok_or(super::invalid("evaluation.report"))?;
    let report: EvaluationReport = decode(row.get("body"))?;
    if state.request.world != *world
        || state.request.id != *id
        || report != state.report
        || report.world != *world
        || report.id != *id
        || report.candidate_id != state.request.candidate_id
        || report.suite_id != state.request.suite.id
        || report.suite_revision != state.request.suite.revision
        || report.basis_digest != digest(&state.request.basis)?
        || row.get::<_, i64>("revision") != revision(state.revision)?
        || row.get::<_, String>("content_digest") != digest(&report)?.as_str()
    {
        return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into());
    }
    Ok((state.request, report))
}

/// Trusted acceptance read binds the report to the actual compiled branch captured at start.
pub(crate) async fn read_report_for_branch(
    tx: &WorldTransaction<'_>,
    id: &EvaluationId,
    branch: &world_protocol::releases::WorldBranch,
) -> Result<(EvaluationRequest, EvaluationReport), Error> {
    let pair = read_report(tx, id).await?;
    let state = load(tx, id).await?.ok_or(super::invalid("evaluation.id"))?;
    let captured = crate::releases::read_branch_revision(tx, &state.branch)
        .await
        .map_err(|error| Error::Release(Box::new(error)))?
        .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?;
    if captured.status != world_protocol::learning::ChangeStatus::Testing
        || state.branch.world != branch.world
        || state.branch.id != branch.id
        || state.branch.revision > branch.revision
        || captured.candidate_id != branch.candidate_id
        || captured.task_id != branch.task_id
        || captured.task_revision != branch.task_revision
        || captured.change_set_id != branch.change_set_id
        || captured.compile != branch.compile
        || captured.basis != branch.basis
        || state.request.basis != captured.basis
        || state.compile_digest != digest(&captured.compile)?
        || state.model_digest
            != crate::compiler::model_digest(&captured.compile).map_err(Error::Compile)?
    {
        return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into());
    }
    Ok(pair)
}

pub(crate) async fn reports_for_branch(
    tx: &WorldTransaction<'_>,
    branch: &world_protocol::releases::WorldBranch,
) -> Result<Vec<(EvaluationRequest, EvaluationReport)>, Error> {
    let rows = tx.query(
        "SELECT evaluation_id FROM world_evaluation_run WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 ORDER BY evaluation_id LIMIT 4097",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &branch.id.as_str()],
    ).await?;
    if rows.len() > 4096 {
        return Err(crate::query::QueryError::from(
            world_protocol::query::QueryFailure::BudgetExceeded {
                limit: world_protocol::query::TruncationReason::Rows,
            },
        )
        .into());
    }
    let mut reports = Vec::new();
    for row in rows {
        let id = EvaluationId::try_new(row.get::<_, String>("evaluation_id"))
            .map_err(|_| world_protocol::evaluation::EvaluationFailure::InternalFault)?;
        let state = load(tx, &id)
            .await?
            .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?;
        if state.request.candidate_id != branch.candidate_id
            || state.request.basis != branch.basis
            || state.compile_digest != digest(&branch.compile)?
            || state.model_digest
                != crate::compiler::model_digest(&branch.compile).map_err(Error::Compile)?
        {
            continue;
        }
        reports.push(read_report_for_branch(tx, &id, branch).await?);
    }
    Ok(reports)
}

/// A completed report proves only the exact finite plan actually executed for every candidate test.
pub(crate) async fn read_report_plan(
    tx: &WorldTransaction<'_>,
    id: &EvaluationId,
    branch: &world_protocol::releases::WorldBranch,
    plan: &world_protocol::ids::Digest,
) -> Result<(EvaluationRequest, EvaluationReport), Error> {
    let pair = read_report_for_branch(tx, id, branch).await?;
    let state = load(tx, id).await?.ok_or(super::invalid("evaluation.id"))?;
    let task = records::task(
        tx,
        &state.request.suite.task_id,
        state.request.suite.task_revision,
    )
    .await?;
    let tests = records::tests(tx, &state.request.suite.tests).await?;
    let results = results(tx, id).await?;
    let candidate: Vec<_> = results
        .iter()
        .filter(|result| {
            result.evaluation.arm == world_protocol::evaluation::EvaluationArm::Candidate
        })
        .collect();
    if !matches!(pair.1.execution, EvaluationExecution::Completed) || candidate.len() != tests.len()
    {
        return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into());
    }
    for (index, test) in tests.iter().enumerate() {
        let result = candidate
            .iter()
            .find(|result| {
                result.evaluation.test.id == test.id
                    && result.evaluation.test.revision == test.revision
            })
            .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?;
        let ordinal = index
            .checked_mul(state.request.suite.arms.len())
            .and_then(|index| {
                state
                    .request
                    .suite
                    .arms
                    .iter()
                    .position(|arm| *arm == world_protocol::evaluation::EvaluationArm::Candidate)
                    .and_then(|arm| index.checked_add(arm))
            })
            .and_then(|ordinal| u32::try_from(ordinal).ok())
            .ok_or(world_protocol::evaluation::EvaluationFailure::InternalFault)?;
        let input_digest = digest(&(
            &state.request.id,
            ordinal,
            test,
            &result.evaluation.arm,
            &state.report.basis_digest,
        ))?;
        let step_id =
            world_protocol::ids::StepId::try_new(format!("eval-{}", &input_digest.as_str()[7..]))
                .map_err(|_| super::invalid("step.id"))?;
        let step = crate::owner::read_step(tx, &state.run.id, &step_id)
            .await?
            .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?;
        if step.input_digest != input_digest
            || step.phase != OperationPhase::Completed
            || step.result.as_ref() != Some(&encode(*result)?)
            || !result.witness.matches_plan(plan)
        {
            return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into());
        }
        let case = result
            .case
            .as_ref()
            .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?;
        let observed = result
            .evaluation
            .observed
            .as_ref()
            .ok_or(world_protocol::evaluation::EvaluationFailure::BasisChanged)?;
        let frozen = super::frozen_arm_plan(tx, &state.request.id, &state.branch, &result.evaluation.arm).await?;
        result.witness.require_frozen_plan(&frozen)?;
        result.witness.validate(
            &super::CandidateInput::new(&state, &step, &task, test, &case.input),
            &state.request.basis,
            &result.evaluation.arm,
            observed,
            case,
        )?;
    }
    Ok(pair)
}

pub(super) async fn results(
    tx: &WorldTransaction<'_>,
    id: &EvaluationId,
) -> Result<Vec<AcceptedResult>, Error> {
    let world = tx.world();
    let rows = tx.query(
        "SELECT test_case_id,test_case_revision,arm,result_digest,body FROM world_evaluation_result WHERE tenant_id=$1 AND world_id=$2 AND evaluation_id=$3 ORDER BY test_case_id,test_case_revision,arm",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()],
    ).await?;
    rows.into_iter()
        .map(|row| {
            let result: AcceptedResult = decode(row.get("body"))?;
            if result.evaluation.test.id.as_str() != row.get::<_, String>("test_case_id")
                || revision(result.evaluation.test.revision)?
                    != row.get::<_, i64>("test_case_revision")
                || serde_json::to_string(&result.evaluation.arm)
                    .map_err(|_| world_protocol::evaluation::EvaluationFailure::InternalFault)?
                    != row.get::<_, String>("arm")
                || digest(&result)?.as_str() != row.get::<_, String>("result_digest")
            {
                return Err(world_protocol::evaluation::EvaluationFailure::BasisChanged.into());
            }
            Ok(result)
        })
        .collect()
}

pub(super) async fn accept(
    tx: &mut WorldTransaction<'_>,
    state: &mut EvaluationRun,
    task: &TaskContract,
    test: &TestCase,
    step: &StepRecord,
    result: &AcceptedResult,
    usage: world_protocol::budget::Usage,
    recording: &Admission,
    authority: &crate::authorization::EvaluationAuthority,
) -> Result<(), Error> {
    if let Some(case) = &result.case {
        let binding = crate::authorization::EvaluationBinding {
            evaluation_id: state.request.id.clone(),
            candidate_id: state.request.candidate_id.clone(),
            branch: state.branch.clone(),
            task: world_protocol::learning::TaskRef {
                world: task.world.clone(),
                id: task.id.clone(),
                revision: task.revision,
            },
            arm: result.evaluation.arm.clone(),
            test: result.evaluation.test.clone(),
            case_id: case.id.clone(),
            run_id: state.run.id.clone(),
            step_id: step.id.clone(),
        };
        authority
            .require_evaluation_recording(tx, recording, &binding, &tx.now().await?)
            .await?;
        records::record_case(tx, recording, case, false, false, &tx.now().await?).await?;
        if let Some(observed) = &result.evaluation.observed {
            crate::content::retain(
                tx,
                &crate::content::ContentReference::new(
                    crate::content::ContentOwner::Evaluation {
                        id: state.request.id.clone(),
                    },
                    observed.clone(),
                )?,
            )
            .await?;
        }
    }
    if let Some(custody) = &result.oracle_custody {
        crate::content::retain(
            tx,
            &crate::content::ContentReference::new(
                crate::content::ContentOwner::Evaluation {
                    id: state.request.id.clone(),
                },
                custody.clone(),
            )?,
        )
        .await?;
    }
    let world = tx.world().clone();
    let arm = serde_json::to_string(&result.evaluation.arm)
        .map_err(|_| world_protocol::evaluation::EvaluationFailure::InternalFault)?;
    let changed = tx.execute(
        "INSERT INTO world_evaluation_result(tenant_id,world_id,evaluation_id,test_case_id,test_case_revision,arm,status,result_digest,body) VALUES($1,$2,$3,$4,$5,$6,'accepted',$7,$8) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &state.request.id.as_str(), &test.id.as_str(), &revision(test.revision)?, &arm, &digest(result)?.as_str(), &encode(result)?],
    ).await?;
    if changed != 1 {
        return Err(ConstraintFailure::VersionMismatch.into());
    }
    let mut completed = step.clone();
    completed.phase = OperationPhase::Completed;
    completed.result = Some(encode(result)?);
    completed.checkpoint = encode(&result.evaluation)?;
    crate::owner::checkpoint_step(tx, step, completed).await?;
    let current_run = crate::owner::read_run(tx, &state.run.id).await?;
    state.report.usage = crate::owner::confirmed_usage(
        &state.report.usage,
        crate::owner::confirmed_usage(&current_run.usage, usage)?,
    )?;
    state.run =
        crate::owner::checkpoint_usage(tx, &current_run, state.report.usage.clone()).await?;
    state.report.cases.push(result.evaluation.clone());
    state.report.hard_checks.extend(result.hard_checks.clone());
    save(tx, state).await
}

pub(super) async fn save(
    tx: &mut WorldTransaction<'_>,
    state: &mut EvaluationRun,
) -> Result<(), Error> {
    let old = state.revision;
    state.revision = Revision(
        old.0
            .checked_add(1)
            .ok_or(world_protocol::evaluation::EvaluationFailure::InternalFault)?,
    );
    let terminal = !matches!(state.report.execution, EvaluationExecution::Running);
    let world = tx.world().clone();
    let changed = tx.execute(
        "UPDATE world_evaluation_run SET revision=$4,phase=$5,body=$6,terminal_at=CASE WHEN $7 THEN clock_timestamp() ELSE NULL END WHERE tenant_id=$1 AND world_id=$2 AND evaluation_id=$3 AND revision=$8",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &state.request.id.as_str(), &revision(state.revision)?, &if terminal { "terminal" } else { "running" }, &encode(state)?, &terminal, &revision(old)?],
    ).await?;
    tx.require_changed(
        changed,
        ResourceRef::Evaluation {
            id: state.request.id.clone(),
        },
    )?;
    append_report(tx, state).await
}

async fn append_report(tx: &mut WorldTransaction<'_>, state: &EvaluationRun) -> Result<(), Error> {
    let world = tx.world().clone();
    let verdict = serde_json::to_value(state.report.verdict)
        .map_err(|_| world_protocol::evaluation::EvaluationFailure::InternalFault)?;
    tx.execute(
        "INSERT INTO world_evaluation_report(tenant_id,world_id,evaluation_id,revision,content_digest,verdict,body) VALUES($1,$2,$3,$4,$5,$6,$7)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &state.request.id.as_str(), &revision(state.revision)?, &digest(&state.report)?.as_str(), &verdict.as_str().ok_or(world_protocol::evaluation::EvaluationFailure::InternalFault)?, &encode(&state.report)?],
    ).await?;
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Evaluation {
            id: state.request.id.clone(),
        },
        revision: state.revision,
    })?;
    Ok(())
}
