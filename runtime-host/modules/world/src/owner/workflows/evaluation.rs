use std::sync::Arc;

use world_protocol::{
    api::{CommandResult, QueryResult, WorldCommand, WorldQuery},
    authorization::{Actor, ActualImpact},
    evaluation::{EvaluationExecution, SuiteRef, TestRevision},
    failure::FailureStage,
    ids::{ActivationLockId, BranchId, OperationId, ReleaseId},
    operation::OperationResult,
    time::Timestamp,
};

use crate::{
    authorization::{EvaluationAuthority, VerifiedInvocation},
    definitions::canonical_digest,
    evaluation::{self, Evaluation, FiniteBranchExecution},
    learning,
    owner::{Error, ExecutionContext, complete_operation},
    store::{StoreFuture, WorldTransaction},
};

pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
    operation: &OperationId,
) -> Result<ActualImpact, Error> {
    match command {
        WorldCommand::TestBranch(input) => {
            let request = evaluation::resolve_test(tx, input, operation).await?;
            evaluation::execution_impact(tx, &request).await
        }
        WorldCommand::RecordTestCase(input) => Ok(evaluation::test_impact(tx, &input.test).await?),
        WorldCommand::FreezeSuite(input) => Ok(evaluation::freeze_impact(tx, input).await?),
        _ => Err(Error::internal(FailureStage::Admission)),
    }
}

pub(crate) async fn run_basis(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<
    (
        Option<ReleaseId>,
        Option<ActivationLockId>,
        Option<BranchId>,
        world_protocol::budget::Budget,
    ),
    Error,
> {
    let task = match command {
        WorldCommand::TestBranch(input) => {
            let branch = evaluation::branch_for_test(tx, input).await?;
            return Ok((
                Some(branch.basis.release_id),
                Some(branch.compile.activation_lock.id),
                Some(branch.id),
                input.budget.clone(),
            ));
        }
        WorldCommand::RecordTestCase(input) => {
            evaluation::read_task(tx, &input.test.task_id, input.test.task_revision).await?
        }
        WorldCommand::FreezeSuite(input) => {
            let (branch, task) = evaluation::branch_for_freeze(tx, input).await?;
            // Suite management cannot use a branch-confined execution identity.
            return Ok((
                Some(branch.basis.release_id),
                Some(branch.compile.activation_lock.id),
                None,
                task.budget,
            ));
        }
        _ => return Err(Error::internal(FailureStage::Admission)),
    };
    Ok((None, None, None, task.budget))
}

pub(crate) fn run(
    ctx: ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'static, CommandResult, Error> {
    match command {
        WorldCommand::TestBranch(input) => test(ctx, input),
        command @ WorldCommand::RecordTestCase(_) => manage(ctx, command),
        WorldCommand::FreezeSuite(input) => freeze_suite(ctx, input),
        _ => Box::pin(async { Err(Error::internal(FailureStage::Admission)) }),
    }
}

fn manage(ctx: ExecutionContext, command: WorldCommand) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let authority = ctx.evaluation_authority()?.clone();
        let content = ctx.resources.content.clone();
        let committed = ctx
            .transact(
                "evaluation.manage",
                canonical_digest(&command)?,
                &["evaluation", "content", "authorization"],
                move |tx, admission, operation, _| {
                    Box::pin(async move {
                        let now = tx.now().await?;
                        let result = match command {
                            WorldCommand::RecordTestCase(input) => {
                                let actual = evaluation::test_impact(tx, &input.test).await?;
                                admission.require_access(&actual)?;
                                authority.require_manager(tx, &admission, &now).await?;
                                let actor = match &admission.invocation().actor {
                                    Actor::Human { id } | Actor::Service { id } => id,
                                };
                                content
                                    .consume_test_case_uploads(
                                        tx,
                                        actor,
                                        &input.test,
                                        &input.fixture,
                                        &input.expected,
                                    )
                                    .await?;
                                let test = evaluation::record_test(
                                    tx,
                                    &admission,
                                    &authority,
                                    &input.test,
                                    &now,
                                )
                                .await?;
                                OperationResult::TestCase {
                                    test: TestRevision {
                                        id: test.id,
                                        revision: test.revision,
                                    },
                                }
                            }
                            _ => return Err(Error::internal(FailureStage::Admission)),
                        };
                        complete_operation(tx, &operation.receipt.accepted, result, &now).await?;
                        Ok(())
                    })
                },
            )
            .await?;
        Ok(CommandResult::Commit(committed.receipt))
    })
}

fn freeze_suite(
    ctx: ExecutionContext,
    input: world_protocol::evaluation::FreezeSuite,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let authority = ctx.evaluation_authority()?.clone();
        let input_digest = canonical_digest(&WorldCommand::FreezeSuite(input.clone()))?;
        let managed = ctx.commit_request("evaluation.manage", input_digest.clone(), &["evaluation", "content", "authorization"]).await?;
        if let Some(saved) = ctx.store.read_commit_optional::<()>(&ctx.operation.world, &managed.commit_id, &input_digest).await? {
            ctx.recheck_replay(&saved).await?;
            return Ok(CommandResult::Commit(saved.receipt));
        }
        let for_pin = input.clone();
        let pin_authority = authority.clone();
        let pin_request = ctx.commit_request("evaluation.memory.pin", input_digest.clone(), &["evaluation", "content", "authorization"]).await?;
        let pinned = ctx.transact_outcome(
            pin_request,
            move |tx, admission, _, run| Box::pin(async move {
                let now = tx.now().await?;
                pin_authority.require_manager(tx, &admission, &now).await?;
                admission.require_access(&evaluation::freeze_impact(tx, &for_pin).await?)?;
                let mut references = Vec::new();
                for selection in &for_pin.plans {
                    if let world_protocol::evaluation::PlanReference::Frozen(plan) = &selection.plan {
                        if let world_protocol::evaluation::FrozenKnowledge::ToolMemory { snapshot, .. } = &plan.knowledge {
                            if !references.contains(snapshot) { references.push(snapshot.clone()); }
                        }
                    }
                }
                let mut pins = Vec::new();
                for reference in references {
                    let version = crate::content::read_source_version_in_transaction(tx, &reference).await?;
                    let identity = canonical_digest(&(&run.id, &reference))?;
                    let id = world_protocol::ids::ContentId::try_new(format!("suite-memory-{}", &identity.as_str()[7..]))
                        .expect("bounded digest identifier");
                    let owner = crate::content::ContentReference::new(
                        crate::content::ContentOwner::SourceVersion { reference: reference.clone() }, version.blob,
                    )?;
                    let pin = crate::content::pin(tx, &owner, id, crate::content::PinKind::Read).await?;
                    pins.push((reference, pin));
                }
                Ok(pins)
            }),
        ).await.map_err(Error::from)?;
        let result = async {
            ctx.recheck_replay(&pinned).await?;
            let mut memories = Vec::new();
            for (reference, pin) in &pinned.value {
                if ctx.cancellation.is_cancelled() {
                    return Err(evaluation::Error::from(world_protocol::evaluation::EvaluationFailure::Cancelled).into());
                }
                ctx.budget.charge(world_protocol::budget::BudgetDimension::Bytes, pin.reference().byte_size)
                    .map_err(|failure| evaluation::Error::from(world_protocol::evaluation::EvaluationFailure::BudgetExhausted { dimension: failure.dimension }))?;
                let confirmed = crate::store::Committed { value: pin.clone(), receipt: pinned.receipt.clone(), replayed: pinned.replayed };
                memories.push(evaluation::load_suite_memory(&ctx.resources.content, &ctx.store, reference.clone(), &confirmed).await?);
            }
            ctx.transact(
                "evaluation.manage", input_digest.clone(), &["evaluation", "content", "authorization"],
                move |tx, admission, operation, _| Box::pin(async move {
                    let now = tx.now().await?;
                    admission.require_access(&evaluation::freeze_impact(tx, &input).await?)?;
                    let actor = match &admission.invocation().actor { Actor::Human { id } | Actor::Service { id } => id.clone() };
                    let frozen = evaluation::freeze(tx, input, actor, now.clone()).await?;
                    let frozen = evaluation::freeze_suite(tx, &admission, &authority, &frozen, &memories, &now).await?;
                    for memory in &memories { crate::content::release_pin(tx, memory.pin()).await?; }
                    let result = OperationResult::Suite { suite: SuiteRef { world: frozen.world, id: frozen.id, revision: frozen.revision } };
                    complete_operation(tx, &operation.receipt.accepted, result, &now).await?;
                    Ok(())
                }),
            ).await.map(|committed| CommandResult::Commit(committed.receipt))
        }.await;
        // Releasing already-owned pins does not mint authority or resume a terminal operation.
        let cleanup = async {
            let request = ctx.commit_request("evaluation.memory.release", input_digest, &["content"]).await?;
            let pins = pinned.value;
            ctx.store.transact(request.prepare()?, move |tx| Box::pin(async move {
                for (_, pin) in pins { crate::content::release_pin(tx, &pin).await?; }
                Ok::<_, Error>(())
            })).await.map_err(Error::from)?;
            Ok::<_, Error>(())
        }.await;
        match (result, cleanup) {
            (Ok(result), Ok(())) => Ok(result),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(error), Err(cleanup)) => Err(error.with_related(cleanup)),
        }
    })
}

fn test(
    ctx: ExecutionContext,
    input: world_protocol::evaluation::TestBranch,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let authority = ctx.evaluation_authority()?.clone();
        let input_digest = canonical_digest(&input)?;
        let commits = ctx
            .commit_request(
                "evaluation.execute",
                input_digest.clone(),
                &[
                    "evaluation",
                    "content",
                    "query",
                    "operation",
                    "authorization",
                ],
            )
            .await?;
        let budget = ctx.budget.clone();
        let cancel = ctx.cancellation.clone();
        let operation = ctx.operation.operation_id.clone();
        let (request, prepared, state) = ctx
            .transact(
                "evaluation.prepare",
                input_digest.clone(),
                &[
                    "learning",
                    "releases",
                    "evaluation",
                    "content",
                    "authorization",
                ],
                move |tx, admission, _, run| {
                    Box::pin(async move {
                        let now = tx.now().await?;
                        let request = evaluation::resolve_test(tx, &input, &operation).await?;
                        learning::begin_testing(tx, &admission, &request, &budget, &cancel, &now)
                            .await?;
                        let state =
                            evaluation::start(tx, &admission, &request, &input.branch, &run, &now)
                                .await?;
                        let prepared = FiniteBranchExecution::prepare(tx, &state).await?;
                        Ok((request, prepared, state))
                    })
                },
            )
            .await?
            .value;
        let execution = FiniteBranchExecution::new(
            prepared,
            Arc::new(ctx.store.clone()),
            ctx.resources.content.clone(),
            authority.clone(),
            commits.clone(),
            ctx.resources.live.clone(),
            ctx.invocation_service_seed(),
            ctx.resources.generation.clone(),
            ctx.budget.clone(),
        )
        .map_err(Error::from)?;
        let report = Evaluation::new(
            &ctx.store,
            &ctx.resources.content,
            Some(&execution),
            &authority,
            &ctx.budget,
            &ctx.authority,
        )
        .evaluate(&state, &ctx.admission, &commits, &ctx.pipeline)
        .await?;
        match &report.execution {
            EvaluationExecution::Running => return Err(Error::internal(FailureStage::Verify)),
            EvaluationExecution::Failed { failure } => {
                return Err(Error::from_failure(world_protocol::failure::Failure {
                    code: failure.code.clone(),
                    stage: failure.stage,
                    message: failure.message.clone(),
                    diagnostic_id: failure.diagnostic_id.clone(),
                    operation_id: failure.operation_id.clone(),
                    run_id: failure.run_id.clone(),
                    step_id: failure.step_id.clone(),
                    details: world_protocol::api::ApiFailure::Operation(failure.details.clone()),
                    recovery: failure.recovery.clone(),
                }));
            }
            EvaluationExecution::Cancelled => {
                return Err(evaluation::Error::from(
                    world_protocol::evaluation::EvaluationFailure::Cancelled,
                )
                .into());
            }
            EvaluationExecution::Completed => {}
        }
        let budget = ctx.budget.clone();
        let cancel = ctx.cancellation.clone();
        ctx.transact(
            "evaluation.final",
            canonical_digest(&report)?,
            &[
                "learning",
                "releases",
                "evaluation",
                "content",
                "authorization",
            ],
            move |tx, admission, operation, _| {
                Box::pin(async move {
                    learning::conclude_available_evaluations(
                        tx,
                        &admission,
                        &request.candidate_id,
                        &request.id,
                        &budget,
                        &cancel,
                        &tx.now().await?,
                    )
                    .await?;
                    let now = tx.now().await?;
                    let impact = evaluation::owner_report_impact(tx, admission.verified(), &request.id).await?;
                    let output = crate::authorization::admit(tx, admission.verified(), &impact, &[], None, &now).await?;
                    let summary = evaluation::summary(tx, &output, &request.id, &now).await?;
                    complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::EvaluationSummary(summary),
                        &tx.now().await?,
                    )
                    .await?;
                    Ok(())
                })
            },
        )
        .await?;
        Ok(CommandResult::Accepted(ctx.operation.clone()))
    })
}

pub(crate) async fn query(
    resources: &crate::owner::resources::Resources,
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    query: &WorldQuery,
    _now: &Timestamp,
) -> Result<QueryResult, Error> {
    match query {
        WorldQuery::Evaluations(request) => Ok(QueryResult::Evaluations(
            evaluation::reports(tx, verified, &request.page).await?,
        )),
        WorldQuery::Evaluation(request) => Ok(QueryResult::Evaluation(
            evaluation::report(tx, verified, &request.id).await?,
        )),
        WorldQuery::Suites(request) => Ok(QueryResult::Suites(
            evaluation::suites(tx, verified, &request.page).await?,
        )),
        WorldQuery::Suite(reference) => Ok(QueryResult::Suite(
            evaluation::suite_summary(tx, verified, reference).await?,
        )),
        WorldQuery::SuiteCreationContext(reference) => Ok(QueryResult::SuiteCreationContext(
            evaluation::suite_creation_context(tx, verified, authority(resources)?, reference)
                .await?,
        )),
        WorldQuery::TestCases(request) => Ok(QueryResult::TestCases(
            evaluation::test_cases(tx, verified, authority(resources)?, request).await?,
        )),
        WorldQuery::ExactTestCase(reference) => Ok(QueryResult::ExactTestCase(
            evaluation::exact_test(tx, verified, authority(resources)?, reference).await?,
        )),
        WorldQuery::FrozenSuite(reference) => Ok(QueryResult::FrozenSuite(
            evaluation::frozen_suite(tx, verified, authority(resources)?, reference).await?,
        )),
        _ => Err(Error::internal(FailureStage::Read)),
    }
}

pub(crate) async fn operation_retention_roots(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
    result: Option<&OperationResult>,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    match command {
        WorldCommand::TestBranch(input) => {
            if input.branch.world == *tx.world() {
                roots.branches.push(input.branch.clone());
            }
            if input.suite.world == *tx.world() {
                roots
                    .resources
                    .push(world_protocol::ids::ResourceRef::Suite {
                        id: input.suite.id.clone(),
                    });
            }
        }
        WorldCommand::RecordTestCase(input) if input.test.world == *tx.world() => {
            evaluation::retain_test(roots, &input.test)
        }
        WorldCommand::FreezeSuite(input) if input.world == *tx.world() => {
            evaluation::retain_freeze(roots, input)
        }
        _ => {}
    }
    match result {
        Some(OperationResult::Evaluation(report)) if report.world == *tx.world() => {
            evaluation::retain_report(roots, report)?
        }
        Some(OperationResult::EvaluationSummary(summary)) if summary.world == *tx.world() => {
            roots
                .resources
                .push(world_protocol::ids::ResourceRef::Evaluation {
                    id: summary.id.clone(),
                });
            roots
                .resources
                .push(world_protocol::ids::ResourceRef::Suite {
                    id: summary.suite_id.clone(),
                });
        }
        Some(OperationResult::Suite { suite }) if suite.world == *tx.world() => roots
            .resources
            .push(world_protocol::ids::ResourceRef::Suite {
                id: suite.id.clone(),
            }),
        Some(OperationResult::TestCase { test }) => {
            roots
                .resources
                .push(world_protocol::ids::ResourceRef::TestCase {
                    id: test.id.clone(),
                })
        }
        _ => {}
    }
    Ok(())
}

pub(crate) async fn step_retention_roots(
    tx: &WorldTransaction<'_>,
    step: &crate::owner::StepRecord,
    roots: &mut crate::store::RetentionRoots,
) -> Result<(), Error> {
    match step.kind.as_str() {
        "world.evaluation.case" => {
            evaluation::case_step_retention_roots(tx, step, roots).await?;
        }
        "world.evaluation.oracle_custody" => {
            evaluation::oracle_step_retention_roots(tx, step, roots).await?;
        }
        _ => return Err(Error::internal(FailureStage::Read)),
    }
    Ok(())
}

fn authority(
    resources: &crate::owner::resources::Resources,
) -> Result<&EvaluationAuthority, Error> {
    resources
        .authorities
        .evaluation
        .get()
        .ok_or_else(|| {
            Error::new(
                "world.evaluation_not_configured",
                FailureStage::Admission,
                "独立评测身份尚未配置。",
                world_protocol::api::ApiFailure::NotConfigured,
                world_protocol::failure::Recovery::None,
            )
        })
}
