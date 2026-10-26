use super::{
    BranchExecution, CandidateInput, ConstraintFailure, Error, accounting, io, judge, records,
    run::{self, AcceptedResult, EvaluationRun},
    scoring,
};
use crate::{
    authorization::Admission,
    content::{Content, ContentOwner},
    store::{CommitRequest, StoreFuture, WorldStore},
};
use foundation::pipeline::{PipelineContext, ProgressEvent};
use world_protocol::{
    evaluation::{
        CandidateVerdict, CaseEvaluation, CaseExecution, EvaluationArm, EvaluationExecution,
        EvaluationFailure, EvaluationReport, Replayability, TestRevision,
    },
    ids::{EvaluationId, StepId},
    learning::{CaseOrigin, CaseOutcome, TaskContract, TestCase},
    value::Value,
};

/// Default product evaluator. The owner supplies its existing Pipeline/OwnedTask custody;
/// this object owns no runner, production permit or competing task lifecycle.
pub(crate) struct Evaluation<'a> {
    store: &'a WorldStore,
    content: &'a Content,
    execution: Option<&'a dyn BranchExecution>,
    authority: &'a crate::authorization::EvaluationAuthority,
    budget: &'a crate::extensions::invocation::CallBudget,
    root: &'a std::sync::Arc<crate::authorization::AuthorityRoot>,
}

impl<'a> Evaluation<'a> {
    pub(crate) fn new(
        store: &'a WorldStore,
        content: &'a Content,
        execution: Option<&'a dyn BranchExecution>,
        authority: &'a crate::authorization::EvaluationAuthority,
        budget: &'a crate::extensions::invocation::CallBudget,
        root: &'a std::sync::Arc<crate::authorization::AuthorityRoot>,
    ) -> Self {
        Self {
            store,
            content,
            execution,
            authority,
            budget,
            root,
        }
    }

    pub(crate) async fn evaluate(
        &self,
        prepared: &EvaluationRun,
        admission: &Admission,
        commits: &CommitRequest,
        pipeline: &PipelineContext,
    ) -> Result<EvaluationReport, Error> {
        // Resume has a fresh verified invocation; content pins and current admission
        // are never reused from an earlier invocation's completed receipts.
        let mut commits = commits.clone();
        let identity = records::digest(&(&commits.commit_id, &admission.invocation().id))?;
        commits.commit_id =
            world_protocol::ids::CommitId::try_new(format!("eval-{}", &identity.as_str()[7..]))
                .expect("bounded digest identifier");
        let mut custody = super::settlement::Custody::prepared(prepared, admission, pipeline)?;
        match self
            .execute(
                &prepared.request.id,
                admission,
                &commits,
                pipeline,
                &mut custody,
            )
            .await
        {
            Ok(report) => Ok(report),
            Err(error) => {
                let error = crate::owner::Error::from(error);
                match custody
                    .fail(
                        self.store,
                        self.root,
                        &commits,
                        &error,
                        self.budget.checkpoint_usage(),
                        self.execution,
                    )
                    .await
                {
                    Ok(()) => Err(Error::Owner(error)),
                    Err(settlement) => Err(Error::Owner(error.with_related(settlement.into()))),
                }
            }
        }
    }

    async fn execute(
        &self,
        id: &EvaluationId,
        admission: &Admission,
        commits: &CommitRequest,
        pipeline: &PipelineContext,
        custody: &mut super::settlement::Custody,
    ) -> Result<EvaluationReport, Error> {
        let auth = admission.clone();
        let evaluation_id = id.clone();
        let loaded = io::transact(self.store, commits, "load", id, move |tx| {
            Box::pin(async move {
                let state = run::load(tx, &evaluation_id)
                    .await?
                    .ok_or(super::invalid("evaluation.id"))?;
                let task = records::task(
                    tx,
                    &state.request.suite.task_id,
                    state.request.suite.task_revision,
                )
                .await?;
                run::authorize(tx, &auth, &task, &state, &accounting::now()).await?;
                let tests = records::tests(tx, &state.request.suite.tests).await?;
                Ok((state, task, tests))
            })
        })
        .await?
        .value;
        let (mut state, task, tests) = loaded;
        if pipeline.run_id() != state.run.id.as_str() {
            return Err(ConstraintFailure::VersionMismatch.into());
        }
        if !matches!(state.report.execution, EvaluationExecution::Running) {
            return Ok(state.report);
        }
        let mut available = Vec::new();
        for (index, snapshot) in state.request.basis.snapshots.iter().enumerate() {
            match io::read_blob(
                self.store,
                self.content,
                commits,
                admission,
                &state,
                snapshot,
                ContentOwner::Branch {
                    id: state.request.branch_id.clone(),
                },
                &format!("basis.{index}"),
            )
            .await
            {
                Ok(bytes) => {
                    self.budget
                        .charge(world_protocol::budget::BudgetDimension::Bytes, bytes.len() as u64)
                        .map_err(|error| EvaluationFailure::BudgetExhausted {
                            dimension: error.dimension,
                        })?;
                    available.push(snapshot.clone());
                }
                Err(Error::Content(error))
                    if matches!(
                        error.reason(),
                        Some(
                            world_protocol::materials::MaterialFailure::ContentNotFound
                                | world_protocol::materials::MaterialFailure::Deleted
                        )
                    ) => {}
                Err(error) => return Err(error),
            }
        }
        let (replayability, missing) = super::assess_basis(
            &state.request.world,
            &state.request.basis,
            &state.request.suite.conditions,
            &available,
        )?;
        let data_digest = super::data_digest(&state.request.basis)?;
        if data_digest != state.request.suite.conditions.data_digest {
            return Err(EvaluationFailure::BasisChanged.into());
        }
        state.report.coverage.missing_sources = missing;
        if replayability != Replayability::Complete {
            return self
                .finish(state, task, tests, admission, commits, replayability)
                .await;
        }
        let execution = self
            .execution
            .ok_or_else(super::execution::dependency_missing)?;
        for (test_index, test) in tests.iter().enumerate() {
            for (arm_index, arm) in state.request.suite.arms.clone().iter().enumerate() {
                let ordinal = test_index
                    .checked_mul(state.request.suite.arms.len())
                    .and_then(|value| value.checked_add(arm_index))
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or(EvaluationFailure::InternalFault)?;
                let stage = format!("case.{ordinal}");
                let current = state.clone();
                let auth = admission.clone();
                let task_for_claim = task.clone();
                let test_for_claim = test.clone();
                let arm_for_claim = arm.clone();
                let claim = io::transact(
                    self.store,
                    commits,
                    &format!("{stage}.claim"),
                    &(id, ordinal),
                    move |tx| {
                        Box::pin(async move {
                            let current = run::load(tx, &current.request.id)
                                .await?
                                .ok_or(super::invalid("evaluation.id"))?;
                            run::authorize(
                                tx,
                                &auth,
                                &task_for_claim,
                                &current,
                                &accounting::now(),
                            )
                            .await?;
                            if !matches!(current.report.execution, EvaluationExecution::Running) {
                                return Err(EvaluationFailure::BasisChanged.into());
                            }
                            let results = run::results(tx, &current.request.id).await?;
                            if results.iter().any(|result| {
                                result.evaluation.test.id == test_for_claim.id
                                    && result.evaluation.test.revision == test_for_claim.revision
                                    && result.evaluation.arm == arm_for_claim
                            }) {
                                return Ok((current, None));
                            }
                            let digest = records::digest(&(
                                &current.request.id,
                                ordinal,
                                &test_for_claim,
                                &arm_for_claim,
                                &current.report.basis_digest,
                            ))?;
                            let step_id =
                                StepId::try_new(format!("eval-{}", &digest.as_str()[7..]))
                                    .expect("bounded digest identifier");
                            if crate::owner::read_step(tx, &current.run.id, &step_id)
                                .await?
                                .is_some()
                            {
                                // The previous execution may have reached an external boundary. Never rerun it.
                                return Err(EvaluationFailure::ExecutionFailed.into());
                            }
                            let step = crate::owner::claim_step(
                                tx,
                                &auth,
                                &current.run,
                                step_id,
                                ordinal,
                                "world.evaluation.case",
                                digest,
                                &accounting::now(),
                            )
                            .await?;
                            Ok((current, Some(step)))
                        })
                    },
                )
                .await?;
                if claim.replayed {
                    // A committed claim is not permission to execute the same work twice.
                    let evaluation_id = state.request.id.clone();
                    state = self
                        .store
                        .snapshot(state.request.world.clone(), move |snapshot| {
                            Box::pin(
                                async move { run::read_snapshot(snapshot, &evaluation_id).await },
                            )
                        })
                        .await?;
                    if state.report.cases.iter().any(|result| {
                        result.test.id == test.id
                            && result.test.revision == test.revision
                            && result.arm == *arm
                    }) {
                        continue;
                    }
                    return Err(EvaluationFailure::ExecutionFailed.into());
                }
                state = claim.value.0;
                let Some(step) = claim.value.1 else {
                    continue;
                };
                custody.await_step(&step)?;
                if pipeline.is_cancelled() {
                    return Err(EvaluationFailure::Cancelled.into());
                }
                self.check_budget(&state)?;
                pipeline.emit_progress(ProgressEvent::started(pipeline.run_id(), &stage));
                let result = self
                    .run_case(
                        execution, &state, &step, &task, test, arm, admission, commits, pipeline,
                        &stage,
                    )
                    .await?;
                let result_usage = result.accepted.evaluation.usage.clone();
                let auth = admission.clone();
                let task_for_accept = task.clone();
                let test_for_accept = test.clone();
                let human = result.human;
                let recording = result.recording;
                let authority = self.authority.clone();
                let observed_receipts = result.receipts;
                let accepted = result.accepted;
                let usage = self.budget.checkpoint_usage();
                let mut current = state.clone();
                let acceptance_identity =
                    records::digest(&(&state.request.id, &step.id, &accepted))?;
                state = io::transact(
                    self.store,
                    commits,
                    &format!("{stage}.accept"),
                    &acceptance_identity,
                    move |tx| {
                        Box::pin(async move {
                            run::authorize(
                                tx,
                                &auth,
                                &task_for_accept,
                                &current,
                                &accounting::now(),
                            )
                            .await?;
                            if let Some(human) = &human {
                                judge::confirm_human(tx, human, &accounting::now()).await?;
                            }
                            if let Some((source, verification)) = &observed_receipts {
                                judge::confirm_source(tx, source, verification).await?;
                            }
                            let frozen = super::frozen_arm_plan(tx, &current.request.id, &current.branch, &accepted.evaluation.arm).await?;
                            accepted.witness.require_frozen_plan(&frozen)?;
                            run::accept(
                                tx,
                                &mut current,
                                &task_for_accept,
                                &test_for_accept,
                                &step,
                                &accepted,
                                usage,
                                &recording,
                                &authority,
                            )
                            .await?;
                            Ok(current)
                        })
                    },
                )
                .await?
                .value;
                accounting::check(&result_usage, &task.budget, &accounting::now())?;
                self.check_budget(&state)?;
                pipeline.emit_progress(ProgressEvent::completed(pipeline.run_id(), &stage));
                // A committed result remains accepted even if cancellation arrived just after COMMIT.
                if pipeline.is_cancelled() {
                    return Err(EvaluationFailure::Cancelled.into());
                }
            }
        }
        self.finish(state, task, tests, admission, commits, replayability)
            .await
    }

    fn check_budget(&self, state: &EvaluationRun) -> Result<(), Error> {
        let mut usage = state.report.usage.clone();
        let elapsed = accounting::now()
            .unix_millis()
            .checked_sub(state.started_at.unix_millis())
            .and_then(|value| u64::try_from(value).ok())
            .ok_or(EvaluationFailure::InternalFault)?;
        usage.elapsed.0 = usage.elapsed.0.max(elapsed);
        accounting::check(&usage, &state.request.budget, &accounting::now())
    }

    fn run_case<'f>(
        &'f self,
        execution: &'f dyn BranchExecution,
        state: &'f EvaluationRun,
        step: &'f crate::owner::StepRecord,
        task: &'f TaskContract,
        test: &'f TestCase,
        arm: &'f EvaluationArm,
        admission: &'f Admission,
        commits: &'f CommitRequest,
        pipeline: &'f PipelineContext,
        stage: &'f str,
    ) -> StoreFuture<'f, CaseResult, Error> {
        Box::pin(async move {
            let started = std::time::Instant::now();
            let owner = ContentOwner::Suite {
                id: state.request.suite.id.clone(),
                revision: state.request.suite.revision,
            };
            let fixture = io::read_blob(
                self.store,
                self.content,
                commits,
                admission,
                state,
                &test.fixture,
                owner.clone(),
                &format!("{stage}.fixture"),
            )
            .await?;
            let input: Value = world_protocol::wire::decode(
                &fixture,
                task.budget.max_bytes.min(usize::MAX as u64) as usize,
            )
            .map_err(|_| EvaluationFailure::BadCase {
                test_case_id: test.id.clone(),
            })?;
            crate::definitions::validate_value(&task.input_type, false, &input).map_err(|_| {
                EvaluationFailure::BadCase {
                    test_case_id: test.id.clone(),
                }
            })?;
            self.budget
                .charge(
                    world_protocol::budget::BudgetDimension::Bytes,
                    fixture.len() as u64,
                )
                .map_err(|error| EvaluationFailure::BudgetExhausted {
                    dimension: error.dimension,
                })?;
            self.budget
                .charge(world_protocol::budget::BudgetDimension::Steps, 1)
                .map_err(|error| EvaluationFailure::BudgetExhausted {
                    dimension: error.dimension,
                })?;
            let observed = execution
                .run_arm(
                    CandidateInput::new(state, step, task, test, &input),
                    &state.request.basis,
                    arm,
                    &state.request.suite.conditions,
                    pipeline,
                )
                .await?;
            observed.witness.validate(
                &CandidateInput::new(state, step, task, test, &input),
                &state.request.basis,
                arm,
                &observed.observed,
                &observed.case,
            )?;
            super::validate_case(task, &observed.case)?;
            if observed.case.input != input
                || observed.case.release_id != state.request.basis.release_id
                || observed.case.activation_lock_id != state.request.basis.activation_lock_id
                || observed.case.model_binding != state.request.suite.conditions.model_binding
                || observed.case.origin_family != test.origin_family
            {
                return Err(EvaluationFailure::BadCase {
                    test_case_id: test.id.clone(),
                }
                .into());
            }
            if let CaseOrigin::Replay {
                basis,
                parent_case_id,
            } = &observed.case.origin
            {
                if basis != &state.request.basis || test.case_id.as_ref() != Some(parent_case_id) {
                    return Err(EvaluationFailure::BasisChanged.into());
                }
            }
            let mut usage = observed.usage.clone();
            usage.bytes = usage
                .bytes
                .checked_add(fixture.len() as u64)
                .ok_or(EvaluationFailure::InternalFault)?;
            usage.steps = usage
                .steps
                .checked_add(1)
                .ok_or(EvaluationFailure::InternalFault)?;
            let expected = io::read_blob(
                self.store,
                self.content,
                commits,
                admission,
                state,
                &test.expected,
                owner,
                &format!("{stage}.expected"),
            )
            .await?;
            usage.bytes = usage
                .bytes
                .checked_add(expected.len() as u64)
                .ok_or(EvaluationFailure::InternalFault)?;
            observed
                .budget
                .charge(
                    world_protocol::budget::BudgetDimension::Bytes,
                    expected.len() as u64,
                )
                .map_err(|error| EvaluationFailure::BudgetExhausted {
                    dimension: error.dimension,
                })?;
            let lock_id = state.request.basis.activation_lock_id.clone();
            let lock = self
                .store
                .snapshot(state.request.world.clone(), move |snapshot| {
                    Box::pin(async move {
                        Ok::<_, Error>(
                            crate::extensions::bindings::read_graph(snapshot, &lock_id)
                                .await?
                                .lock()
                                .clone(),
                        )
                    })
                })
                .await?;
            let judgement = judge::judge(
                execution,
                &state.request,
                task,
                test,
                &observed,
                &expected,
                &lock,
                &state.proposer,
                pipeline,
            )
            .await;
            let mut checks = observed.hard_checks.clone();
            if checks
                .iter()
                .map(|check| &check.name)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != checks.len()
            {
                return Err(super::invalid("execution.hardChecks.name").into());
            }
            let (mut passed, measurements, human, oracle_custody, mut case_execution) = match judgement
            {
                Ok(judgement) => {
                    accounting::add(&mut usage, &judgement.result.usage)?;
                    for check in judgement.result.hard_checks {
                        if check.name.starts_with("hard_constraint_") {
                            return Err(super::invalid("oracle.hardChecks.name").into());
                        }
                        if let Some(previous) =
                            checks.iter().find(|previous| previous.name == check.name)
                        {
                            if previous != &check {
                                return Err(super::invalid("oracle.hardChecks.conflict").into());
                            }
                        } else {
                            checks.push(check);
                        }
                    }
                    (
                        Some(judgement.result.passed),
                        judgement.result.measurements,
                        judgement.human,
                        judgement.result.custody,
                        CaseExecution::Completed,
                    )
                }
                Err(Error::Constraint(ConstraintFailure::OracleUnverified)) => {
                    (None, None, None, None, CaseExecution::OracleUnavailable)
                }
                Err(error) => return Err(error),
            };
            match &observed.case.outcome {
                CaseOutcome::Succeeded { .. } => {}
                CaseOutcome::Failed { .. } => passed = Some(false),
                CaseOutcome::Cancelled { .. } => {
                    passed = None;
                    case_execution = CaseExecution::Cancelled;
                }
                CaseOutcome::Inconclusive { .. } => passed = None,
            }
            if let Some(failure) = &observed.business_failure {
                passed = Some(false);
                case_execution = CaseExecution::BusinessFailed {
                    failure: failure.clone(),
                };
            }
            if checks.iter().any(|check| !check.passed) {
                passed = Some(false);
            }
            usage.elapsed.0 = usage.elapsed.0.max(
                u64::try_from(started.elapsed().as_millis())
                    .map_err(|_| EvaluationFailure::InternalFault)?,
            );
            let evaluation = CaseEvaluation {
                case_id: Some(observed.case.id.clone()),
                test: TestRevision {
                    id: test.id.clone(),
                    revision: test.revision,
                },
                arm: arm.clone(),
                execution: case_execution,
                oracle_passed: passed,
                observed: Some(observed.observed),
                usage,
            };
            Ok(CaseResult {
                accepted: AcceptedResult {
                    oracle_custody,
                    evaluation,
                    case: Some(observed.case),
                    witness: observed.witness,
                    hard_checks: checks,
                    measurements,
                },
                human,
                recording: observed.recording,
                receipts: observed.source_verification,
            })
        })
    }

    fn finish<'f>(
        &'f self,
        mut state: EvaluationRun,
        task: TaskContract,
        tests: Vec<TestCase>,
        admission: &'f Admission,
        commits: &'f CommitRequest,
        replayability: Replayability,
    ) -> StoreFuture<'f, EvaluationReport, Error> {
        Box::pin(async move {
            let auth = admission.clone();
            let id = state.request.id.clone();
            let usage = self.budget.checkpoint_usage();
            io::transact(self.store, commits, "finish", &id, move |tx| {
                Box::pin(async move {
                    run::authorize(tx, &auth, &task, &state, &accounting::now()).await?;
                    let results = run::results(tx, &state.request.id).await?;
                    let mut origins = std::collections::BTreeMap::new();
                    for result in &results {
                        if let Some(case) = &result.case {
                            origins.insert(case.id.clone(), records::case_origin(tx, case).await?);
                        }
                    }
                    scoring::summarize(
                        &mut state.report,
                        &state.request.suite,
                        &tests,
                        &results,
                        &origins,
                        replayability,
                    )?;
                    if state.report.verdict != CandidateVerdict::Rejected
                        && results
                            .iter()
                            .filter(|result| result.evaluation.arm == EvaluationArm::Candidate)
                            .any(|result| {
                                (0..task.hard_constraints.len()).any(|index| {
                                    !result
                                        .hard_checks
                                        .iter()
                                        .any(|check| check.name == format!("hard_constraint_{index}"))
                                })
                            })
                    {
                        state.report.verdict = CandidateVerdict::Inconclusive;
                    }
                    let current_run = crate::owner::read_run(tx, &state.run.id).await?;
                    state.report.execution = EvaluationExecution::Completed;
                    state.report.usage = crate::owner::confirmed_usage(
                        &state.report.usage,
                        crate::owner::confirmed_usage(&current_run.usage, usage)?,
                    )?;
                    state.report.completed_at = Some(accounting::now());
                    let elapsed = state
                        .report
                        .completed_at
                        .as_ref()
                        .expect("completion timestamp")
                        .unix_millis()
                        - state.started_at.unix_millis();
                    state.report.usage.elapsed.0 = state
                        .report
                        .usage
                        .elapsed
                        .0
                        .max(u64::try_from(elapsed).map_err(|_| EvaluationFailure::InternalFault)?);
                    state.run = crate::owner::checkpoint_usage(
                        tx, &current_run, state.report.usage.clone(),
                    ).await?;
                    run::save(tx, &mut state).await?;
                    Ok(state.report)
                })
            })
            .await
            .map(|committed| committed.value)
        })
    }
}

struct CaseResult {
    accepted: AcceptedResult,
    human: Option<super::HumanVerification>,
    recording: Admission,
    receipts: Option<(
        world_protocol::actions::SourceReceipt,
        world_protocol::actions::VerificationReceipt,
    )>,
}
