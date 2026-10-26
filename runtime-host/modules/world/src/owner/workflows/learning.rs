pub(crate) mod abstraction;

use crate::{
    authorization,
    definitions::canonical_digest,
    learning,
    owner::{Error, ExecutionContext, complete_operation},
    store::{StoreFuture, WorldTransaction},
};
use world_protocol::{
    api::{CommandResult, QueryResult, WorldCommand, WorldQuery},
    authorization::{AccessMode, AccessScope, ActualImpact},
    failure::FailureStage,
    ids::ResourceRef,
    learning::{TaskRef, TaskSummary},
    operation::OperationResult,
};

pub(crate) fn impact<'a>(
    tx: &'a WorldTransaction<'_>,
    command: &'a WorldCommand,
) -> StoreFuture<'a, ActualImpact, Error> {
    match command {
        WorldCommand::ResolveTask(request) => Box::pin(async move {
            learning::investigation::impact(tx, request).await
        }),
        WorldCommand::RecordTask(task) => Box::pin(async move {
            crate::evaluation::validate_task(task).map_err(crate::evaluation::Error::from)?;
            if task.world != *tx.world() {
                return Err(
                    world_protocol::authorization::AuthorizationFailure::InsufficientScope.into(),
                );
            }
            Ok(authorization::actual_impact(
                vec![AccessScope {
                    resources: vec![ResourceRef::Task {
                        id: task.id.clone(),
                    }],
                    fields: Vec::new(),
                    modes: vec![AccessMode::Manage],
                    scope: task.scope.clone(),
                    valid_time: None,
                }],
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )?)
        }),
        WorldCommand::ProposeChange(request) => Box::pin(async move {
            let candidate = learning::direct_candidate(tx, request, &tx.now().await?).await?;
            let branch = match crate::releases::read_candidate(tx, &candidate.id).await? {
                Some((branch, _)) => branch,
                None => {
                    learning::derive_branch(tx, &candidate, &request.task, &request.compile).await?
                }
            };
            let write =
                learning::candidate_impact(tx, &candidate, &branch, AccessMode::Write).await?;
            let read =
                learning::candidate_impact(tx, &candidate, &branch, AccessMode::Read).await?;
            combine(write, read)
        }),
        WorldCommand::ProposeAbstraction(request) => Box::pin(async move {
            let (branch, candidate, contract) = abstraction_proposal(tx, request, &tx.now().await?).await?;
            let proposal = abstraction_proposal_impact(tx, &branch, &candidate, &contract).await?;
            combine(proposal, abstraction::access(tx, &branch.compile.activation_lock.id, &contract.scope).await?)
        }),
        WorldCommand::ValidateChange(request) => Box::pin(async move {
            let (branch, candidate) = learning::read_for_change(tx, &request.id).await?;
            let impact = combine(
                learning::candidate_impact(tx, &candidate, &branch, AccessMode::Write).await?,
                learning::candidate_impact(tx, &candidate, &branch, AccessMode::Read).await?,
            )?;
            let impact = match crate::query::replay_impact(tx, &branch).await? {
                Some(replay) => combine(impact, replay)?,
                None => impact,
            };
            let bindings = learning::affected_source_bindings(tx, &branch).await?;
            if bindings.is_empty() {
                return Ok(impact);
            }
            combine(
                impact,
                crate::sources::sync::branch_capture_impact(tx, &branch, &bindings).await?,
            )
        }),
        WorldCommand::RebaseChange(request) => Box::pin(async move {
            let (branch, candidate) = learning::read_for_change(tx, &request.id).await?;
            let (next_branch, next_candidate) = learning::preview_rebase(
                tx,
                branch.clone(),
                candidate.clone(),
                &request.new_base,
                &request.compile,
            )
            .await?;
            let current = combine(
                learning::candidate_impact(tx, &candidate, &branch, AccessMode::Write).await?,
                learning::candidate_impact(tx, &candidate, &branch, AccessMode::Read).await?,
            )?;
            let next = combine(
                learning::candidate_impact(tx, &next_candidate, &next_branch, AccessMode::Write)
                    .await?,
                learning::candidate_impact(tx, &next_candidate, &next_branch, AccessMode::Read)
                    .await?,
            )?;
            combine(current, next)
        }),
        _ => Box::pin(async move { Err(Error::internal(FailureStage::Admission)) }),
    }
}

pub(crate) fn run_basis<'a>(
    tx: &'a WorldTransaction<'_>,
    command: &'a WorldCommand,
) -> StoreFuture<
    'a,
    (
        Option<world_protocol::ids::ReleaseId>,
        Option<world_protocol::ids::ActivationLockId>,
        Option<world_protocol::ids::BranchId>,
        world_protocol::budget::Budget,
    ),
    Error,
> {
    match command {
        WorldCommand::ResolveTask(request) => Box::pin(async move {
            learning::investigation::run_basis(tx, request).await
        }),
        WorldCommand::RecordTask(task) => Box::pin(async move {
            Ok((None, None, None, task.budget.clone()))
        }),
        WorldCommand::ProposeChange(request) => Box::pin(async move {
            let candidate = learning::direct_candidate(tx, request, &tx.now().await?).await?;
            let stored = crate::releases::read_candidate(tx, &candidate.id).await?;
            let branch = match &stored {
                Some((branch, _)) => branch.clone(),
                None => {
                    learning::derive_branch(tx, &candidate, &request.task, &request.compile).await?
                }
            };
            let task =
                crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
            Ok((
                Some(branch.basis.release_id),
                Some(branch.compile.activation_lock.id),
                stored.map(|(branch, _)| branch.id),
                task.budget,
            ))
        }),
        WorldCommand::ProposeAbstraction(request) => Box::pin(async move {
            let (original, candidate, _) = abstraction_proposal(tx, request, &tx.now().await?).await?;
            let stored = crate::releases::read_candidate(tx, &candidate.id).await?;
            let branch = stored.as_ref().map_or(original, |(branch, _)| branch.clone());
            let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
            Ok((
                Some(branch.basis.release_id),
                Some(branch.compile.activation_lock.id),
                stored.map(|(branch, _)| branch.id),
                task.budget,
            ))
        }),
        WorldCommand::ValidateChange(request) => Box::pin(async move {
            let (branch, _) = learning::read_for_change(tx, &request.id).await?;
            let task =
                crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
            Ok((
                Some(branch.basis.release_id),
                Some(branch.compile.activation_lock.id),
                Some(branch.id),
                task.budget,
            ))
        }),
        WorldCommand::RebaseChange(request) => Box::pin(async move {
            let (branch, candidate) = learning::read_for_change(tx, &request.id).await?;
            let (branch, _) = learning::preview_rebase(
                tx,
                branch,
                candidate,
                &request.new_base,
                &request.compile,
            )
            .await?;
            let task =
                crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
            Ok((
                Some(branch.basis.release_id),
                Some(branch.compile.activation_lock.id),
                Some(branch.id),
                task.budget,
            ))
        }),
        _ => Box::pin(async move { Err(Error::internal(FailureStage::Admission)) }),
    }
}

pub(crate) fn run(
    ctx: ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'static, CommandResult, Error> {
    match command {
        WorldCommand::ResolveTask(request) => learning::investigation::run(ctx, request),
        WorldCommand::ProposeAbstraction(request) => abstraction::run(ctx, request),
        command => run_final(ctx, command),
    }
}

fn run_final(
    ctx: ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let digest = canonical_digest(&command)?;
        let validation = match &command {
            WorldCommand::ValidateChange(request) => Some(capture_validation(&ctx, request).await?),
            _ => None,
        };
        let budget = ctx.budget.clone();
        let cancel = ctx.cancellation.clone();
        let domains = ["learning", "releases", "content", "query", "evaluation", "authorization"];
        let committed = ctx
            .transact(
                "learning.final",
                digest,
                &domains,
                move |tx, admission, operation, _| {
                    match command {
                        WorldCommand::RecordTask(task) => Box::pin(async move {
                            let now = tx.now().await?;
                            let task =
                                crate::evaluation::record_task(tx, &admission, &task, &now).await?;
                            complete_operation(
                                tx,
                                &operation.receipt.accepted,
                                OperationResult::Task(TaskSummary {
                                    reference: TaskRef {
                                        world: task.world,
                                        id: task.id,
                                        revision: task.revision,
                                    },
                                    goal: task.goal,
                                    scope: task.scope,
                                }),
                                &now,
                            )
                            .await?;
                            Ok(None)
                        }),
                        WorldCommand::ProposeChange(request) => Box::pin(async move {
                            let now = tx.now().await?;
                            let candidate = learning::direct_candidate(tx, &request, &now).await?;
                            let candidate = match crate::releases::read_candidate(tx, &candidate.id)
                                .await?
                            {
                                Some((branch, stored)) => {
                                    admission.require_access(
                                        &learning::candidate_impact(
                                            tx,
                                            &stored,
                                            &branch,
                                            AccessMode::Write,
                                        )
                                        .await?,
                                    )?;
                                    learning::recheck_model_calls(tx, &admission, &stored).await?;
                                    stored
                                }
                                None => {
                                    learning::propose_request(
                                        tx,
                                        &admission,
                                        &candidate,
                                        &request.task,
                                        &request.compile,
                                        None,
                                        &budget,
                                        &cancel,
                                        &now,
                                    )
                                    .await?
                                }
                            };
                            let output = learning::candidate_read_impact(tx, &candidate.id).await?;
                            authorization::check_admitted_output(tx, &admission, &output, 1, &now)
                                .await?;
                            complete_operation(
                                tx,
                                &operation.receipt.accepted,
                                OperationResult::Candidate(candidate.clone()),
                                &now,
                            )
                            .await?;
                            Ok(Some(candidate))
                        }),
                        WorldCommand::ValidateChange(request) => Box::pin(async move {
                            let now = tx.now().await?;
                            let (reference, captures, reads) =
                                validation.ok_or_else(|| Error::internal(FailureStage::Verify))?;
                            let (_, current) = learning::read_for_change(tx, &request.id).await?;
                            learning::lock_candidate(tx, &current.id).await?;
                            let frozen = crate::releases::freeze_branch_basis(
                                tx, &admission, &reference, &captures, reads, &budget, &cancel,
                                &now,
                            )
                            .await?;
                            let candidate = learning::validate_change(
                                tx,
                                &admission,
                                &current.id,
                                request.expected_revision,
                                &frozen,
                                &budget,
                                &cancel,
                                &now,
                            )
                            .await?;
                            let output = learning::candidate_read_impact(tx, &candidate.id).await?;
                            authorization::check_admitted_output(tx, &admission, &output, 1, &now)
                                .await?;
                            complete_operation(
                                tx,
                                &operation.receipt.accepted,
                                OperationResult::Candidate(candidate.clone()),
                                &now,
                            )
                            .await?;
                            Ok(Some(candidate))
                        }),
                        WorldCommand::RebaseChange(request) => Box::pin(async move {
                            let now = tx.now().await?;
                            let (_, current) = learning::read_for_change(tx, &request.id).await?;
                            let candidate = learning::rebase(
                                tx,
                                &admission,
                                &current.id,
                                request.expected_revision,
                                &request.new_base,
                                &request.compile,
                                &budget,
                                &cancel,
                                &now,
                            )
                            .await?;
                            let output = learning::candidate_read_impact(tx, &candidate.id).await?;
                            authorization::check_admitted_output(tx, &admission, &output, 1, &now)
                                .await?;
                            complete_operation(
                                tx,
                                &operation.receipt.accepted,
                                OperationResult::Candidate(candidate.clone()),
                                &now,
                            )
                            .await?;
                            Ok(Some(candidate))
                        }),
                        _ => Box::pin(async move { Err(Error::internal(FailureStage::Admission)) }),
                    }
                },
            )
            .await?;
        Ok(match committed.value {
            Some(candidate) => CommandResult::Candidate(candidate),
            None => CommandResult::Commit(committed.receipt),
        })
    })
}

async fn abstraction_proposal(
    tx: &WorldTransaction<'_>,
    request: &world_protocol::api::ProposeAbstraction,
    now: &world_protocol::time::Timestamp,
) -> Result<
    (
        world_protocol::releases::WorldBranch,
        world_protocol::learning::Candidate,
        world_protocol::abstraction::AbstractionContract,
    ),
    Error,
> {
    let (branch, candidate) = learning::abstraction_proposal(tx, request, now).await?;
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
    let contract = crate::abstraction::bind_draft(&request.abstraction, &task, &candidate, &branch)?;
    Ok((branch, candidate, contract))
}

async fn abstraction_proposal_impact(
    tx: &WorldTransaction<'_>,
    branch: &world_protocol::releases::WorldBranch,
    candidate: &world_protocol::learning::Candidate,
    contract: &world_protocol::abstraction::AbstractionContract,
) -> Result<ActualImpact, Error> {
    let mut impact = combine(
        learning::candidate_impact(tx, candidate, branch, AccessMode::Write).await?,
        learning::candidate_impact(tx, candidate, branch, AccessMode::Read).await?,
    )?;
    if let Some((current, stored)) = crate::releases::read_candidate(tx, &candidate.id).await? {
        impact = combine(impact, combine(
            learning::candidate_impact(tx, &stored, &current, AccessMode::Write).await?,
            learning::candidate_impact(tx, &stored, &current, AccessMode::Read).await?,
        )?)?;
    }
    combine(impact, crate::abstraction::record_impact(tx, candidate, branch, contract).await?)
}

fn capture_validation<'a>(
    ctx: &'a ExecutionContext,
    request: &'a world_protocol::api::ChangeCommand,
) -> StoreFuture<
    'a,
    (
        world_protocol::releases::BranchRef,
        Vec<crate::sources::sync::BranchCapture>,
        Vec<crate::query::TargetRead>,
    ),
    Error,
> {
    Box::pin(async move {
        let request = request.clone();
        let (branch, bindings) = ctx
            .transact(
                "learning.validation.prepare",
                canonical_digest(&request)?,
                &["learning", "releases", "content", "authorization"],
                move |tx, admission, _, _| {
                    Box::pin(async move {
                        let (_, candidate) = learning::read_for_change(tx, &request.id).await?;
                        let (branch, bindings) = learning::prepare_validation(
                            tx,
                            &admission,
                            &candidate.id,
                            request.expected_revision,
                            &tx.now().await?,
                        )
                        .await?;
                        if let Some(impact) = crate::query::replay_impact(tx, &branch).await? {
                            admission.require_access(&impact)?;
                        }
                        if !bindings.is_empty() {
                            admission.require_access(
                                &crate::sources::sync::branch_capture_impact(tx, &branch, &bindings)
                                    .await?,
                            )?;
                        }
                        Ok((branch, bindings))
                    })
                },
            )
            .await?
            .value;
        let reference = world_protocol::releases::BranchRef {
            world: branch.world.clone(),
            id: branch.id.clone(),
            revision: branch.revision,
        };
        let mut captures = Vec::with_capacity(bindings.len());
        for binding in bindings {
            let (broker, lease) = super::sources::branch_broker(ctx, &reference, &binding).await?;
            let result =
                crate::sources::sync::capture_branch(ctx, &reference, &binding, broker.clone()).await;
            let drained = broker.sync_drained();
            if drained {
                lease.finish();
            }
            match (result, drained) {
                (Ok(capture), true) => captures.push(capture),
                (Err(error), true) => return Err(error.into()),
                (result, false) => {
                    let retained = Error::from(crate::sources::sync::SyncError::Source(
                        crate::sources::connectors::SourceError::new(
                            world_protocol::sources::SourceFailure::ReaderNotStopped,
                            FailureStage::Stop,
                        ),
                    ));
                    return Err(match result {
                        Ok(_) => retained,
                        Err(error) => Error::from(error).with_related(retained),
                    });
                }
            }
        }
        let reads = crate::query::replay_branch_reads(
            &ctx.store,
            &ctx.resources.content,
            &ctx.admission,
            &branch,
            &captures,
            &ctx.budget,
            &ctx.cancellation,
        )
        .await?;
        Ok((reference, captures, reads))
    })
}

pub(crate) async fn query_impact(
    tx: &WorldTransaction<'_>,
    query: &WorldQuery,
) -> Result<ActualImpact, Error> {
    match query {
        WorldQuery::Change(request) => {
            let (_, candidate) = learning::read_for_change(tx, &request.id).await?;
            Ok(learning::candidate_read_impact(tx, &candidate.id).await?)
        }
        WorldQuery::Task(reference) => {
            let task = crate::evaluation::read_task(tx, &reference.id, reference.revision).await?;
            Ok(authorization::actual_impact(
                vec![AccessScope {
                    resources: vec![ResourceRef::Task {
                        id: reference.id.clone(),
                    }],
                    fields: Vec::new(),
                    modes: vec![AccessMode::Read],
                    scope: task.scope,
                    valid_time: None,
                }],
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )?)
        }
        WorldQuery::Tasks(request) => Ok(authorization::actual_impact(
            vec![AccessScope {
                resources: Vec::new(),
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: request.scope.clone(),
                valid_time: None,
            }],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )?),
        WorldQuery::Changes(_) | WorldQuery::Branches(_) => Ok(authorization::actual_impact(
            vec![AccessScope {
                resources: Vec::new(),
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: crate::owner::management_scope(tx).await?,
                valid_time: None,
            }],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )?),
        _ => Err(Error::internal(FailureStage::Read)),
    }
}

pub(crate) async fn query(
    tx: &WorldTransaction<'_>,
    verified: &authorization::VerifiedInvocation,
    query: &WorldQuery,
    now: &world_protocol::time::Timestamp,
) -> Result<QueryResult, Error> {
    match query {
        WorldQuery::Tasks(request) => Ok(QueryResult::Tasks(
            learning::list_tasks(tx, verified, request, now).await?,
        )),
        WorldQuery::Task(reference) => Ok(QueryResult::Task(
            learning::task_summary(tx, verified, reference, now).await?,
        )),
        WorldQuery::Changes(request) => Ok(QueryResult::Changes(
            learning::changes(tx, verified, &request.page).await?,
        )),
        WorldQuery::Change(request) => Ok(QueryResult::Change(
            learning::change(tx, verified, &request.id).await?,
        )),
        WorldQuery::Branches(request) => Ok(QueryResult::Branches(
            crate::releases::list_branches(tx, verified, request, now).await?,
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
        WorldCommand::ResolveTask(request) if request.task.world == *tx.world() => {
            learning::investigation::operation_retention_roots(tx, request, roots).await?;
        }
        WorldCommand::RecordTask(task) if task.world == *tx.world() => {
            crate::evaluation::retain_task(roots, task)
        }
        WorldCommand::ProposeChange(request) => {
            learning::proposal_retention_roots(tx, request, roots).await?
        }
        WorldCommand::ProposeAbstraction(request) => {
            learning::abstraction_proposal_retention_roots(tx, request, roots).await?
        }
        WorldCommand::ValidateChange(request) => roots.resources.push(ResourceRef::ChangeSet {
            id: request.id.clone(),
        }),
        WorldCommand::RebaseChange(request) => {
            roots.resources.push(ResourceRef::ChangeSet {
                id: request.id.clone(),
            });
            roots.releases.push(request.new_base.clone());
            learning::compile_retention_roots(tx, &request.compile, roots).await?;
        }
        _ => {}
    }
    match result {
        Some(OperationResult::Resolution(resolution)) => {
            roots.resources.push(ResourceRef::Case {
                id: resolution.case_id.clone(),
            });
        }
        Some(OperationResult::Candidate(candidate)) if candidate.world == *tx.world() => {
            learning::candidate_retention_roots(tx, candidate, roots).await?
        }
        Some(OperationResult::Change(change)) if change.world == *tx.world() => {
            roots.resources.push(ResourceRef::ChangeSet {
                id: change.id.clone(),
            });
            roots.releases.push(change.base_release.clone());
            roots.evidence.extend(change.evidence.iter().cloned());
            roots.resources.extend(
                change
                    .cases
                    .iter()
                    .cloned()
                    .map(|id| ResourceRef::Case { id }),
            );
            learning::retain_operations(roots, &change.operations);
        }
        Some(OperationResult::Task(task)) if task.reference.world == *tx.world() => {
            roots.scopes.push(task.scope.clone());
            roots.resources.push(ResourceRef::Task {
                id: task.reference.id.clone(),
            });
        }
        _ => {}
    }
    Ok(())
}

fn combine(left: ActualImpact, right: ActualImpact) -> Result<ActualImpact, Error> {
    Ok(authorization::actual_impact(
        left.access.into_iter().chain(right.access).collect(),
        left.effects.into_iter().chain(right.effects).collect(),
        left.labels.into_iter().chain(right.labels).collect(),
        left.state.into_iter().chain(right.state).collect(),
        left.source_ids
            .into_iter()
            .chain(right.source_ids)
            .collect(),
    )?)
}
