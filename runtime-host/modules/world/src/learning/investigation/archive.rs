use super::{changed, decode, encode, execution};
use crate::{
    authorization::AuthorityRoot,
    content::{Content, ContentOwner, StagedCommit},
    definitions::canonical_digest,
    owner::{self, Error, ExecutionContext},
    store::{CommitRequest, Committed, StoreError, StoreFuture, TransactionError, WorldStore},
};
use std::{io::Cursor, sync::Arc};
use world_protocol::{
    api::{CommandResult, ResolveTaskRequest},
    ids::*,
    learning::{Case, CaseOrigin, CaseOutcome},
    operation::{OperationPhase, OperationResult, ResolutionResult},
    provenance::ReadDependency,
};

pub(super) fn recover<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
) -> StoreFuture<'a, Option<CommandResult>, Error> {
    Box::pin(async move {
        let committed = ctx
            .store
            .read_commit_optional::<()>(
                &ctx.operation.world,
                &ctx.commit_id("resolution.final")?,
                &canonical_digest(request)?,
            )
            .await?;
        let checkpoint = ctx
            .store
            .read_commit_optional::<StagedCommit>(
                &ctx.operation.world,
                &ctx.commit_id("resolution.trace.prepare")?,
                &canonical_digest(request)?,
            )
            .await?;
        if let Some(checkpoint) = &checkpoint {
            require_trace_request(
                checkpoint.value.request(),
                &ctx.operation.world,
                &ctx.operation.operation_id,
                &ctx.run.id,
                request,
            )?;
        }
        if let Some(committed) = committed {
            ctx.recheck_replay(&committed).await?;
            if let Some(checkpoint) = &checkpoint {
                ctx.resources
                    .content
                    .discard_committed_stages(&ctx.store, &ctx.authority, checkpoint)
                    .await?;
            }
            return Ok(Some(CommandResult::Commit(committed.receipt)));
        }
        let Some(checkpoint) = checkpoint else {
            return Ok(None);
        };
        // A cleanup witness cannot recreate publication. Arbitrate the original final ID only.
        let outcome = ctx
            .store
            .transact(checkpoint.value.request().clone().prepare()?, |_| {
                Box::pin(async {
                    Err(Error::from(StoreError::new(
                        world_protocol::commit::CommitFailure::RolledBack,
                        world_protocol::failure::FailureStage::Recover,
                    )))
                })
            })
            .await;
        finish_staged(ctx, &checkpoint, outcome).await.map(Some)
    })
}

fn require_trace_request(
    original: &CommitRequest,
    world: &WorldRef,
    operation: &OperationId,
    run: &RunId,
    request: &ResolveTaskRequest,
) -> Result<(), Error> {
    if original.world != *world
        || original.commit_id
            != owner::execution_commit_id(world, operation, run, "resolution.final")?
        || original.input_digest != canonical_digest(request)?
    {
        return Err(changed());
    }
    original.clone().prepare()?;
    Ok(())
}

async fn finish_staged(
    ctx: &ExecutionContext,
    checkpoint: &Committed<StagedCommit>,
    outcome: Result<Committed<()>, TransactionError<Error>>,
) -> Result<CommandResult, Error> {
    match outcome {
        Ok(committed) => {
            ctx.resources
                .content
                .discard_committed_stages(&ctx.store, &ctx.authority, checkpoint)
                .await?;
            ctx.recheck_replay(&committed).await?;
            Ok(CommandResult::Commit(committed.receipt))
        }
        Err(error @ TransactionError::NotCommitted { cleanup: None, .. }) => {
            let error = Error::from(error);
            match ctx
                .resources
                .content
                .discard_committed_stages(&ctx.store, &ctx.authority, checkpoint)
                .await
            {
                Ok(_) => Err(error),
                Err(cleanup) => Err(error.with_related(cleanup.into())),
            }
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn cleanup_terminal(
    store: &WorldStore,
    content: &Content,
    root: &AuthorityRoot,
    operation: &world_protocol::operation::OperationAccepted,
    run: &RunId,
    request: &ResolveTaskRequest,
) -> Result<(), Error> {
    let id = operation.operation_id.clone();
    let record = store
        .snapshot(operation.world.clone(), move |snapshot| {
            Box::pin(async move { owner::read_record_snapshot(snapshot, &id).await })
        })
        .await?;
    if !owner::terminal_phase(record.receipt.phase) {
        return Ok(());
    }
    if content.world() != &operation.world
        || record.receipt.accepted.world != operation.world
        || record.receipt.accepted.incarnation != operation.incarnation
        || record.receipt.progress.run_id.as_ref() != Some(run)
        || !matches!(record.input.command()?, world_protocol::api::WorldCommand::ResolveTask(saved) if saved == request)
    {
        return Err(changed());
    }
    let input = canonical_digest(request)?;
    let checkpoint = store
        .read_commit_optional::<StagedCommit>(
            &operation.world,
            &owner::execution_commit_id(
                &operation.world,
                &operation.operation_id,
                run,
                "resolution.trace.prepare",
            )?,
            &input,
        )
        .await?;
    let final_commit = store
        .read_commit_optional::<()>(
            &operation.world,
            &owner::execution_commit_id(
                &operation.world,
                &operation.operation_id,
                run,
                "resolution.final",
            )?,
            &input,
        )
        .await?;
    if matches!(record.receipt.result, Some(OperationResult::Resolution(_)))
        && final_commit.is_none()
    {
        return Err(changed());
    }
    if let Some(checkpoint) = checkpoint {
        require_trace_request(
            checkpoint.value.request(),
            &operation.world,
            &operation.operation_id,
            run,
            request,
        )?;
        content
            .discard_committed_stages(store, root, &checkpoint)
            .await?;
    }
    Ok(())
}

pub(super) fn finish<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    step_id: &'a StepId,
    outcome: CaseOutcome,
    oracle: Option<crate::evaluation::OnlineOracleResult>,
) -> StoreFuture<'a, CommandResult, Error> {
    Box::pin(async move {
        if let Some(result) = recover(ctx, request).await? {
            return Ok(result);
        }
        let final_digest = canonical_digest(request)?;
        let state = execution::read_current(ctx, step_id).await?;
        let cancelled = matches!(outcome, CaseOutcome::Cancelled { .. });
        // Cancellation retains execution facts, never promotes an earlier page into a fresh observation.
        let page = if cancelled {
            None
        } else {
            state.observed.as_ref().or_else(|| {
                state
                    .context
                    .as_ref()
                    .and_then(|context| context.page.as_ref())
            })
        };
        if let Some(page) = page {
            crate::query::recheck_page(
                &ctx.store,
                &ctx.resources.content,
                &ctx.admission,
                &request.query,
                &state.task.scope,
                page,
                &ctx.budget,
                &ctx.cancellation,
            )
            .await?;
        }
        let bytes = serde_json::to_vec(&(&state, &outcome)).map_err(|cause| changed().caused(cause))?;
        ctx.budget
            .charge(
                world_protocol::budget::BudgetDimension::Bytes,
                bytes.len() as u64,
            )
            .map_err(|failure| {
                Error::from_host_failure(
                    world_protocol::process::HostFailure::BudgetExceeded {
                        dimension: failure.dimension,
                    },
                    world_protocol::failure::FailureStage::Commit,
                )
            })?;
        let (access, retention) = ctx.evaluation_authority()?.case_policies();
        let mut reads = std::collections::BTreeMap::new();
        let mut sources = std::collections::BTreeMap::new();
        let mut evidence = std::collections::BTreeSet::new();
        let mut definitions = Vec::new();
        let mut receipts = Vec::new();
        if let Some(context) = &state.context {
            receipts.extend(context.page.as_ref().map(|page| page.receipt.clone()));
            if let Some(strategy) = &context.strategy {
                definitions.extend(strategy.used_definitions.iter().cloned());
                receipts.extend(strategy.read_receipts.clone());
                for step in &strategy.steps {
                    match &step.output {
                        Some(crate::abstraction::strategy::StepOutput::Query(page)) => {
                            receipts.push(page.receipt.clone());
                        }
                        Some(crate::abstraction::strategy::StepOutput::Action(
                            owner::StrategyAction::Effect { status, .. },
                        )) => {
                            for receipt in &status.source_receipts {
                                evidence.extend(receipt.evidence.iter().cloned());
                                if sources
                                    .insert(receipt.id.clone(), receipt.clone())
                                    .is_some_and(|previous| previous != *receipt)
                                {
                                    return Err(changed());
                                }
                            }
                            for verification in &status.verifications {
                                receipts.push(verification.read_receipt.clone());
                                evidence.extend(verification.evidence.iter().cloned());
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        receipts.extend(state.observed.as_ref().map(|page| page.receipt.clone()));
        for receipt in receipts {
            for dependency in &receipt.actual_dependencies {
                match dependency {
                    ReadDependency::Definition { reference } => definitions.push(reference.clone()),
                    ReadDependency::Evidence { reference } => {
                        evidence.insert(reference.clone());
                    }
                    _ => {}
                }
            }
            if reads
                .insert(receipt.id.clone(), receipt.clone())
                .is_some_and(|previous| previous != receipt)
            {
                return Err(changed());
            }
        }
        if let Some(contract) = state
            .context
            .as_ref()
            .and_then(|context| context.contract.as_ref())
        {
            definitions.extend(contract.original_definitions.clone());
        }
        definitions.sort();
        definitions.dedup();
        let origin_family = OriginFamilyId::try_new(format!(
            "resolution-{}",
            &canonical_digest(&(&request.task, &request.input))?.as_str()[7..]
        ))
        .map_err(|_| changed())?;
        let occurred_at = execution::now()?;
        let commit = ctx
            .commit_request(
                "resolution.final",
                final_digest.clone(),
                &[
                    "learning",
                    "evaluation",
                    "query",
                    "content",
                    "authorization",
                ],
            )
            .await?;
        let prepare = ctx
            .commit_request(
                "resolution.trace.prepare",
                final_digest,
                &["learning", "authorization"],
            )
            .await?;
        let cleanup = tokio_util::sync::CancellationToken::new();
        let trace = Arc::new(ctx.resources.content.prepare_blob(
            &mut Cursor::new(bytes),
            None,
            if cancelled {
                &cleanup
            } else {
                &ctx.cancellation
            },
        )?);
        let staged = match ctx
            .resources
            .content
            .stage_commit(commit.clone(), &[trace.as_ref()])
        {
            Ok(staged) => staged,
            Err(error) => {
                let error = Error::from(error);
                return Err(match ctx.resources.content.discard_prepared(&trace) {
                    Ok(()) => error,
                    Err(cleanup) => error.with_related(cleanup.into()),
                });
            }
        };
        let usage = ctx.budget.checkpoint_usage();
        let checkpoint = match ctx
            .transact_outcome(prepare, move |tx, _, _, run| {
                Box::pin(async move {
                    owner::checkpoint_usage(tx, &run, owner::confirmed_usage(&run.usage, usage)?)
                        .await?;
                    Ok(staged)
                })
            })
            .await
        {
            Ok(checkpoint) => checkpoint,
            Err(error @ TransactionError::NotCommitted { cleanup: None, .. }) => {
                let error = Error::from(error);
                return Err(match ctx.resources.content.discard_prepared(&trace) {
                    Ok(()) => error,
                    Err(cleanup) => error.with_related(cleanup.into()),
                });
            }
            Err(error) => return Err(error.into()),
        };
        if checkpoint.replayed {
            ctx.resources.content.discard_prepared(&trace)?;
            return recover(ctx, request).await?.ok_or_else(changed);
        }
        let case = Case {
            origin: CaseOrigin::Recorded,
            used_definitions: definitions,
            world: request.task.world.clone(),
            id: state.binding.case_id.clone(),
            task_id: request.task.id.clone(),
            task_revision: request.task.revision,
            input: request.input.clone(),
            observable_trace: trace.reference().clone(),
            release_id: state.binding.release_id.clone(),
            activation_lock_id: state.binding.activation_lock_id.clone(),
            model_binding: None,
            read_receipts: reads.into_values().collect(),
            source_receipts: sources.into_values().collect(),
            evidence: evidence.into_iter().collect(),
            outcome,
            origin_family,
            occurred_at,
            access: access.clone(),
            retention: retention.clone(),
        };
        let id = step_id.clone();
        let request = request.clone();
        let content = ctx.resources.content.clone();
        let usage = ctx.budget.checkpoint_usage();
        let staged = trace.clone();
        let committed = ctx
            .transact_outcome(
                checkpoint.value.request().clone(),
                move |tx, admission, operation, run| {
                    Box::pin(async move {
                        let now = tx.now().await?;
                        admission.require_access(&super::impact(tx, &request).await?)?;
                        let step = owner::read_step(tx, &run.id, &id)
                            .await?
                            .ok_or_else(changed)?;
                        let state = decode(&step)?;
                        if state.binding.case_id != case.id
                            || case.input != request.input
                            || canonical_digest(&case.input)? != state.binding.input_digest
                        {
                            return Err(changed());
                        }
                        if let Some(oracle) = &oracle {
                            crate::evaluation::recheck_online(tx, &admission, oracle, &now).await?;
                            oracle.validate_case(&case)?;
                        } else if matches!(case.outcome, CaseOutcome::Succeeded { .. }) {
                            return Err(changed());
                        }
                        crate::facts::assertions::require_evidence(
                            tx,
                            &admission,
                            &case.evidence,
                            &state.task.scope,
                            None,
                            &now,
                        )
                        .await?;
                        content
                            .retain_prepared(
                                tx,
                                &staged,
                                ContentOwner::Case {
                                    id: case.id.clone(),
                                },
                            )
                            .await?;
                        let case =
                            crate::evaluation::record_case(tx, &admission, &case, false, false, &now)
                                .await?;
                        let result = ResolutionResult {
                            case_id: case.id,
                            outcome: case.outcome,
                        };
                        let mut next = step.clone();
                        next.phase = OperationPhase::Completed;
                        next.result = Some(encode(&result)?);
                        owner::checkpoint_step(tx, &step, next).await?;
                        owner::checkpoint_usage(tx, &run, owner::confirmed_usage(&run.usage, usage)?)
                            .await?;
                        owner::complete_operation(
                            tx,
                            &operation.receipt.accepted,
                            OperationResult::Resolution(result),
                            &now,
                        )
                        .await?;
                        Ok(())
                    })
                },
            )
            .await;
        finish_staged(ctx, &checkpoint, committed).await
    })
}
