mod compilation;
mod recovery;

pub(crate) use compilation::step_retention_roots;
pub(crate) use recovery::ReleaseWorkflows;
use recovery::{
    Completion, Custody, Pending, RollbackPlan, checkpoint, cleanup_pins, finish_final, reserve,
    resume, validate_plan,
};
use std::sync::{Arc, Mutex};
use world_protocol::{
    api::{CommandResult, QueryResult, WorldCommand, WorldQuery},
    authorization::{AccessMode, AccessScope, ActualImpact},
    failure::FailureStage,
    ids::{Digest, ResourceRef},
    operation::{OperationPhase, OperationResult},
    releases::ReleaseHead,
    time::Timestamp,
};

use crate::{
    authorization,
    definitions::canonical_digest,
    owner::{Error, ExecutionContext, OperationUpdate, complete_operation, update_operation},
    releases::{self, PreparedArtifact, RollbackPins},
    store::{Committed, StoreFuture, TransactionError, WorldTransaction},
};

pub(crate) async fn run_basis(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<
    (
        world_protocol::ids::ReleaseId,
        world_protocol::ids::ActivationLockId,
        Option<world_protocol::ids::BranchId>,
        Option<world_protocol::budget::Budget>,
    ),
    Error,
> {
    match command {
        WorldCommand::Publish(request) => {
            let (branch, candidate) =
                crate::learning::read_for_change(tx, &request.change_set_id).await?;
            if candidate.change_set.revision != request.expected_revision
                || request.head.world != *tx.world()
            {
                return Err(invalid("revision"));
            }
            let task =
                crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
            Ok((
                branch.basis.release_id,
                branch.basis.activation_lock_id,
                Some(branch.id),
                Some(task.budget),
            ))
        }
        WorldCommand::Rollback(request) => {
            if request.release_id != request.head.next || request.head.world != *tx.world() {
                return Err(invalid("head"));
            }
            let release = releases::read_release(tx, &request.release_id)
                .await?
                .ok_or_else(|| invalid("release"))?;
            let budget = match &release.source_branch {
                Some(reference) => {
                    let branch = releases::read_branch_revision(tx, reference)
                        .await?
                        .ok_or_else(|| invalid("sourceBranch"))?;
                    let task =
                        crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision)
                            .await?;
                    Some(task.budget)
                }
                None => None,
            };
            Ok((
                release.id,
                release.artifact.activation_lock_id,
                None,
                budget,
            ))
        }
        _ => Err(Error::internal(FailureStage::Admission)),
    }
}

pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    command: &WorldCommand,
) -> Result<ActualImpact, Error> {
    match command {
        WorldCommand::Publish(request) => {
            let (branch, candidate) =
                crate::learning::read_for_change(tx, &request.change_set_id).await?;
            let task =
                crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
            let model = releases::model_impact(
                tx,
                &branch.compile.definitions,
                vec![AccessScope {
                    resources: vec![
                        ResourceRef::Head {
                            channel: request.head.channel.clone(),
                        },
                        ResourceRef::Branch {
                            id: branch.id.clone(),
                        },
                    ],
                    fields: Vec::new(),
                    modes: vec![AccessMode::Publish],
                    scope: task.scope.clone(),
                    valid_time: None,
                }],
                &[AccessMode::Read, AccessMode::Publish],
            )
            .await?;
            let base = releases::read_release(tx, &branch.basis.release_id)
                .await?
                .ok_or_else(|| invalid("baseRelease"))?;
            let provenance = crate::learning::candidate_read_impact(tx, &candidate.id).await?;
            let mut combined = combine(model, provenance)?;
            let mut previous = Vec::new();
            for definition in &branch.compile.definitions {
                if matches!(definition.body, world_protocol::definitions::DefinitionBody::Extension(_)) {
                    if let Some(reference) = &definition.previous_ref {
                        let model = releases::read_definition_exact(tx, reference).await?
                            .ok_or_else(|| Error::from(releases::Error::from(
                                world_protocol::definitions::DefinitionFailure::MissingReference {
                                    reference: reference.clone(),
                                },
                            )))?;
                        if !previous.contains(&model) {
                            previous.push(model);
                        }
                    }
                }
            }
            if !previous.is_empty() {
                combined = combine(combined, releases::model_impact(
                    tx, &previous, Vec::new(), &[AccessMode::Read],
                ).await?)?;
            }
            combined.access.extend(
                branch
                    .compile
                    .definitions
                    .iter()
                    .filter(|definition| !base.definitions.contains(definition))
                    .map(|definition| AccessScope {
                        resources: vec![ResourceRef::Definition {
                            id: definition.reference.id.clone(),
                        }],
                        fields: Vec::new(),
                        modes: vec![AccessMode::Write],
                        scope: definition.scope.clone(),
                        valid_time: Some(definition.valid_time.clone()),
                    }),
            );
            combined
                .access
                .extend(
                    crate::compiler::compilation_access(&branch.compile).map_err(|error| {
                        Error::from_host_failure(error.host_failure(), FailureStage::Prepare)
                            .caused(error)
                    })?,
                );
            let affected = releases::source_bindings(&branch.compile.definitions);
            let promotion =
                crate::sources::sync::candidate_promotion_impact(tx, &branch, &affected).await?;
            combined = combine(combined, promotion)?;
            let (anchor, _) =
                crate::evaluation::read_report_for_branch(tx, &request.evaluation_id, &branch)
                    .await?;
            let evaluations = releases::select_accepted_evaluations(
                tx,
                &branch,
                &task,
                anchor.suite.conditions.policy_epoch,
                anchor.suite.conditions.grant_epoch,
                Some(&request.evaluation_id),
            )
            .await?;
            for id in evaluations {
                combined = combine(
                    combined,
                    crate::evaluation::report_impact(tx, &id, false).await?,
                )?;
                let (evaluation, _) =
                    crate::evaluation::read_report_for_branch(tx, &id, &branch).await?;
                combined.access.push(AccessScope {
                    resources: vec![ResourceRef::Suite {
                        id: evaluation.suite.id,
                    }],
                    fields: Vec::new(),
                    modes: vec![AccessMode::Read],
                    scope: task.scope.clone(),
                    valid_time: None,
                });
            }
            Ok(authorization::actual_impact(
                combined.access,
                combined.effects,
                combined.labels,
                combined.state,
                combined.source_ids,
            )?)
        }
        WorldCommand::Rollback(request) => {
            if request.release_id != request.head.next || request.head.world != *tx.world() {
                return Err(invalid("head"));
            }
            let release = releases::read_release(tx, &request.release_id)
                .await?
                .ok_or_else(|| {
                    Error::from(releases::Error::from(
                        world_protocol::releases::ReleaseFailure::ReleaseMissing {
                            release_id: request.release_id.clone(),
                        },
                    ))
                })?;
            let scope = releases::release_scope(tx, &release).await?;
            Ok(releases::model_impact(
                tx,
                &release.definitions,
                vec![AccessScope {
                    resources: vec![ResourceRef::Head {
                        channel: request.head.channel.clone(),
                    }],
                    fields: Vec::new(),
                    modes: vec![AccessMode::Publish],
                    scope,
                    valid_time: None,
                }],
                &[AccessMode::Read, AccessMode::Publish],
            )
            .await?)
        }
        _ => Err(Error::internal(FailureStage::Admission)),
    }
}

pub(crate) fn run(
    ctx: ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let execution = ctx
            .resources
            .releases
            .execution(&ctx.operation.operation_id);
        let _execution = execution.lock().await;
        execute(&ctx, command).await
    })
}

pub(crate) async fn recover(ctx: ExecutionContext) -> Result<CommandResult, Error> {
    recovery::recover(ctx).await
}

fn execute(ctx: &ExecutionContext, command: WorldCommand) -> StoreFuture<'_, CommandResult, Error> {
    Box::pin(async move {
        let input = canonical_digest(&command)?;
        if let Some(pending) = ctx
            .resources
            .releases
            .find(&ctx.operation.operation_id, &input)
        {
            if !matches!(&pending.custody, Custody::Compilation(_)) {
                return resume(ctx, pending).await;
            }
        }
        match command {
            WorldCommand::Publish(request) => publish(ctx, request, input).await,
            WorldCommand::Rollback(request) => rollback(ctx, request, input).await,
            _ => Err(Error::internal(FailureStage::Admission)),
        }
    })
}

fn publish(
    ctx: &ExecutionContext,
    request: world_protocol::api::PublishRequest,
    input: Digest,
) -> StoreFuture<'_, CommandResult, Error> {
    Box::pin(async move {
        let inspection = request.clone();
        let inspected = ctx
            .transact(
                "release.inspect",
                input.clone(),
                &["releases", "authorization"],
                move |tx, admission, _, _| {
                    Box::pin(async move {
                        let command = WorldCommand::Publish(inspection.clone());
                        admission.require_access(&impact(tx, &command).await?)?;
                        let (branch, candidate) =
                            crate::learning::read_for_change(tx, &inspection.change_set_id).await?;
                        if candidate.change_set.revision != inspection.expected_revision {
                            return Err(invalid("revision"));
                        }
                        if branch.status != world_protocol::learning::ChangeStatus::Ready
                            || candidate.change_set.status
                                != world_protocol::learning::ChangeStatus::Ready
                        {
                            return Err(invalid("status"));
                        }
                        let task =
                            crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision)
                                .await?;
                        let evaluations = releases::select_accepted_evaluations(
                            tx,
                            &branch,
                            &task,
                            admission.decision().policy_epoch,
                            admission.decision().grant_epoch,
                            Some(&inspection.evaluation_id),
                        )
                        .await?;
                        authorization::check_admitted_output(
                            tx,
                            &admission,
                            admission.impact(),
                            1,
                            &tx.now().await?,
                        )
                        .await?;
                        Ok((branch, evaluations))
                    })
                },
            )
            .await?;
        let (branch, evaluations) = inspected.value;
        let prepared = Arc::new(compilation::prepare(ctx, &request, &branch, &input).await?);
        let sources = async {
            let branch = branch.clone();
            let admission = ctx.admission.clone();
            let budget = ctx.budget.clone();
            let cancellation = ctx.cancellation.clone();
            let sources = ctx
                .store
                .snapshot(ctx.operation.world.clone(), move |snapshot| {
                    Box::pin(async move {
                        if releases::read_branch_snapshot(snapshot, &branch.id)
                            .await?
                            .as_ref()
                            != Some(&branch)
                        {
                            return Err(invalid("revision"));
                        }
                        let affected = releases::source_bindings(&branch.compile.definitions);
                        Ok::<_, Error>(
                            crate::sources::sync::require_candidate_ready_snapshot(
                                snapshot,
                                &admission,
                                &world_protocol::releases::BranchRef {
                                    world: branch.world.clone(),
                                    id: branch.id.clone(),
                                    revision: branch.revision,
                                },
                                &affected,
                                &budget,
                                &cancellation,
                            )
                            .await?,
                        )
                    })
                })
                .await?;
            Ok::<_, Error>(
                crate::sources::sync::verify_candidate_sources(
                    &ctx.store,
                    &ctx.resources.content,
                    &ctx.admission,
                    &sources,
                    &ctx.budget,
                    &ctx.cancellation,
                )
                .await?,
            )
        }
        .await;
        let sources = match sources {
            Ok(sources) => sources,
            Err(error) => return Err(with_discard(ctx, &prepared, error)),
        };
        let commit = match ctx
            .commit_request(
                "release.publish",
                canonical_digest(&(&request, &branch, &evaluations, prepared.manifest()))?,
                &[
                    "releases",
                    "definitions",
                    "learning",
                    "sources",
                    "identity",
                    "facts",
                    "content",
                    "packages",
                    "authorization",
                ],
            )
            .await
        {
            Ok(request) => request,
            Err(error) => return Err(with_discard(ctx, &prepared, error)),
        };
        let staged = match prepared.stage_commit(&ctx.resources.content, commit) {
            Ok(staged) => staged,
            Err(error) => return Err(with_discard(ctx, &prepared, error.into())),
        };
        let checkpoint = match checkpoint(ctx, staged).await {
            Ok(checkpoint) => Arc::new(checkpoint),
            Err(error) => return Err(with_discard(ctx, &prepared, error)),
        };
        let commit = checkpoint.value.request().clone();
        let publication = match reserve(ctx, &commit) {
            Ok(value) => value,
            Err(error) => return Err(with_discard(ctx, &prepared, error)),
        };
        let pending = ctx.resources.releases.retain(Pending {
            request: commit.clone(),
            operation: ctx.operation.operation_id.clone(),
            input,
            publication: Mutex::new(Some(publication)),
            custody: Custody::Publish(checkpoint),
        });
        let content = ctx.resources.content.clone();
        let budget = ctx.budget.clone();
        let cancellation = ctx.cancellation.clone();
        let outcome = ctx
            .transact_outcome(commit, move |tx, admission, operation, _| {
                Box::pin(async move {
                    admission
                        .require_access(&impact(tx, &WorldCommand::Publish(request.clone())).await?)?;
                    let task =
                        crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision).await?;
                    let selected = releases::select_accepted_evaluations(
                        tx,
                        &branch,
                        &task,
                        admission.decision().policy_epoch,
                        admission.decision().grant_epoch,
                        Some(&request.evaluation_id),
                    )
                    .await?;
                    if selected != evaluations {
                        return Err(invalid("evaluations"));
                    }
                    releases::publish(
                        tx,
                        &admission,
                        &content,
                        &prepared,
                        &sources,
                        &branch.candidate_id,
                        branch.revision,
                        request.expected_revision,
                        &request.head,
                        &evaluations,
                        &budget,
                        &cancellation,
                    )
                    .await?;
                    let head = releases::read_head(tx, &request.head.channel)
                        .await?
                        .ok_or_else(|| invalid("head"))?;
                    authorization::check_admitted_output(
                        tx,
                        &admission,
                        admission.impact(),
                        1,
                        &tx.now().await?,
                    )
                    .await?;
                    let now = tx.now().await?;
                    complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::Release { head: head.clone() },
                        &now,
                    )
                    .await?;
                    Ok(head)
                })
            })
            .await;
        finish_final(ctx, pending, outcome).await
    })
}

fn rollback(
    ctx: &ExecutionContext,
    request: world_protocol::api::RollbackRequest,
    input: Digest,
) -> StoreFuture<'_, CommandResult, Error> {
    Box::pin(async move {
        let commit = ctx
            .commit_request(
                "release.rollback.pin",
                canonical_digest(&(&request, "pin"))?,
                &["releases", "content", "packages", "authorization"],
            )
            .await?;
        let publish = ctx
            .commit_request(
                "release.rollback",
                canonical_digest(&(&commit.commit_id, &request.head))?,
                &["releases", "content", "packages", "authorization"],
            )
            .await?;
        let cleanup = ctx
            .commit_request(
                "release.rollback.cleanup",
                canonical_digest(&(&commit.commit_id, "cleanup"))?,
                &["releases", "content"],
            )
            .await?;
        let plan = RollbackPlan {
            pin: commit,
            publish,
            cleanup,
        };
        let digest = canonical_digest(&plan)?;
        let plan = ctx
            .transact(
                "release.rollback.prepare",
                digest,
                &[],
                move |_, _, _, _| Box::pin(async move { Ok(plan) }),
            )
            .await?
            .value;
        validate_plan(ctx, &plan)?;
        let commit = plan.pin.clone();
        let pending = ctx.resources.releases.retain(Pending {
            request: commit.clone(),
            operation: ctx.operation.operation_id.clone(),
            input,
            publication: Mutex::new(None),
            custody: Custody::Pin(plan),
        });
        let head = request.head.clone();
        let cancellation = ctx.cancellation.clone();
        let outcome = ctx
            .transact_outcome(commit, move |tx, admission, _, _| {
                Box::pin(async move {
                    admission.require_access(&impact(tx, &WorldCommand::Rollback(request)).await?)?;
                    Ok(releases::pin_rollback(tx, &admission, &head, &cancellation).await?)
                })
            })
            .await;
        match outcome {
            Ok(pinned) => continue_rollback(ctx, pending, pinned).await,
            Err(error @ TransactionError::NotCommitted { .. }) => {
                ctx.resources.releases.remove(&pending);
                Err(error.into())
            }
            Err(error) => Err(error.into()),
        }
    })
}

async fn continue_rollback(
    ctx: &ExecutionContext,
    pin_pending: Arc<Pending>,
    pinned: Committed<RollbackPins>,
) -> Result<CommandResult, Error> {
    // A disclosure denial is not a rollback proof: the committed pin remains in custody.
    ctx.recheck_replay(&pinned).await?;
    let prepared = match releases::validate_rollback(
        &ctx.resources.content,
        &ctx.store,
        &pinned,
        &ctx.cancellation,
    )
    .await
    {
        Ok(prepared) => Arc::new(prepared),
        Err(error) => {
            return cleanup_pins(
                ctx,
                &pin_pending,
                Arc::new(pinned),
                Completion::Failed(error.into()),
            )
            .await;
        }
    };
    let Custody::Pin(plan) = &pin_pending.custody else {
        return Err(Error::internal(FailureStage::Recover));
    };
    let plan = plan.clone();
    let commit = plan.publish.clone();
    if commit.input_digest != canonical_digest(&(&pinned.receipt.commit_id, prepared.head()))? {
        return Err(Error::internal(FailureStage::Recover));
    }
    let publication = reserve(ctx, &commit)?;
    let pending = ctx.resources.releases.retain(Pending {
        request: commit.clone(),
        operation: ctx.operation.operation_id.clone(),
        input: pin_pending.input.clone(),
        publication: Mutex::new(Some(publication)),
        custody: Custody::Rollback(prepared.clone(), plan),
    });
    ctx.resources.releases.remove(&pin_pending);
    let cancellation = ctx.cancellation.clone();
    let outcome = ctx
        .transact_outcome(commit, move |tx, admission, operation, _| {
            Box::pin(async move {
                let head = releases::rollback(tx, &admission, &prepared, &cancellation).await?;
                authorization::check_admitted_output(
                    tx,
                    &admission,
                    admission.impact(),
                    1,
                    &tx.now().await?,
                )
                .await?;
                let now = tx.now().await?;
                complete_operation(
                    tx,
                    &operation.receipt.accepted,
                    OperationResult::Release { head: head.clone() },
                    &now,
                )
                .await?;
                Ok(head)
            })
        })
        .await;
    finish_final(ctx, pending, outcome).await
}

async fn wait_for_backfill(ctx: &ExecutionContext, input: &Digest) -> Result<CommandResult, Error> {
    ctx.transact(
        "release.waiting",
        input.clone(),
        &[],
        move |tx, _, operation, _| {
            Box::pin(async move {
                let mut progress = operation.receipt.progress.clone();
                progress.stage = FailureStage::Prepare;
                let now = tx.now().await?;
                update_operation(
                    tx,
                    &operation.receipt.accepted,
                    OperationUpdate {
                        phase: OperationPhase::WaitingDependency,
                        progress,
                        failure: None,
                        effects: Vec::new(),
                    },
                    &now,
                )
                .await?;
                Ok(())
            })
        },
    )
    .await?;
    Ok(CommandResult::Accepted(ctx.operation.clone()))
}

fn with_discard(ctx: &ExecutionContext, prepared: &PreparedArtifact, failure: Error) -> Error {
    match releases::discard_artifact(&ctx.resources.content, prepared) {
        Ok(()) => failure,
        Err(cleanup) => failure.with_related(cleanup.into()),
    }
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

pub(crate) async fn query_impact(
    tx: &WorldTransaction<'_>,
    _query: &WorldQuery,
) -> Result<ActualImpact, Error> {
    releases::directory_impact(tx).await
}

pub(crate) async fn query(
    tx: &WorldTransaction<'_>,
    verified: &authorization::VerifiedInvocation,
    query: &WorldQuery,
    now: &Timestamp,
) -> Result<QueryResult, Error> {
    match query {
        WorldQuery::Definitions(query) => Ok(QueryResult::Definitions(
            releases::list_definitions(tx, verified, query, now).await?,
        )),
        WorldQuery::Definition(query) => Ok(QueryResult::Definition(
            releases::definition(tx, verified, query, now).await?,
        )),
        WorldQuery::Branches(query) => Ok(QueryResult::Branches(
            releases::list_branches(tx, verified, query, now).await?,
        )),
        WorldQuery::Releases(query) => Ok(QueryResult::Releases(
            releases::list_releases(tx, verified, query, now).await?,
        )),
        _ => Err(Error::internal(FailureStage::Read)),
    }
}

fn invalid(field: &str) -> Error {
    releases::Error::from(world_protocol::releases::ReleaseFailure::InvalidBranch {
        field: world_protocol::failure::FieldPath(vec![field.into()]),
    })
    .into()
}
