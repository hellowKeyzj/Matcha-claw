use std::ops::ControlFlow;

use super::{
    Checkpoint, InvestigationIdentity, InvestigationReceipt,
    InvestigationRejection, InvestigationRequestState, InvestigationSentness, InvestigationState,
    InvestigationTerminal, InvestigationUsage, changed, checkpoint, decode, encode, observation,
};
use crate::{
    definitions::canonical_digest,
    owner::{self, Error, ExecutionContext, OperationUpdate, StepRecord},
    store::StoreFuture,
};
use world_protocol::{
    api::{ApiFailure, CommandResult, ResolveTaskRequest},
    budget::{Budget, BudgetDimension, Usage},
    failure::{FailureStage, Recovery},
    ids::*,
    learning::{CaseInconclusive, CaseOutcome},
    operation::{OperationFailure, OperationPhase},
    time::{DurationMs, Timestamp},
};

pub(crate) fn run(
    ctx: ExecutionContext,
    request: ResolveTaskRequest,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        if let Some(result) = super::archive::recover(&ctx, &request).await? {
            return Ok(result);
        }
        let binding = super::binding(&ctx, &request)?;
        let step = checkpoint::claim(&ctx, &request, &binding).await?;
        let receipt = 'retained: {
            let (outcome, oracle) = 'terminal: {
                let (mut state, cleanup, oracle) = prepare_context(&ctx, &request, &step.id, &binding).await?;
                if ctx.cancellation.is_cancelled()
                    && state.execution.is_none()
                    && state
                        .context
                        .as_ref()
                        .is_none_or(|context| context.strategy.is_none() && context.invocation.is_none())
                {
                    break 'terminal (
                        CaseOutcome::Cancelled {
                            stage: FailureStage::Execute,
                        },
                        None,
                    );
                }
                if cleanup && state.execution.is_none() { return Err(cleanup_error(&ctx)); }
                if state.execution.is_none() && state.observed.is_none()
                    && !super::context::complete(&ctx, &request, &step.id).await?
                {
                    break 'retained None;
                }
                state = read_current(&ctx, &step.id).await?;
                if !state.context.as_ref().is_some_and(super::context::ready) {
                    return Err(changed());
                }
                let context = state.context.as_ref().ok_or_else(changed)?;
                let oracle = if !context.investigate {
                    if context.strategy.is_none() {
                        break 'terminal (
                            CaseOutcome::Inconclusive {
                                reason: CaseInconclusive::GuardNotSatisfied {
                                    field: world_protocol::failure::FieldPath(vec![
                                        "abstraction".into(),
                                        "guard".into(),
                                    ]),
                                    truth: context.reason.ok_or_else(changed)?,
                                },
                            },
                            None,
                        );
                    }
                    let execution = observation::execute_strategy(&ctx, &request, &step.id).await?;
                    let Some(outcome) = execution.outcome else {
                        break 'retained None;
                    };
                    if !matches!(outcome, CaseOutcome::Succeeded { .. }) {
                        break 'terminal (outcome, None);
                    }
                    oracle
                } else {
                    let receipt = match native_receipt(&ctx, &request, &step.id, &state, cleanup).await? {
                        ControlFlow::Break(outcome) => break 'terminal (outcome, None),
                        ControlFlow::Continue(receipt) => receipt,
                    };
                    match settle_receipt(&ctx, &step.id, receipt, cleanup).await? {
                        NativeOutcome::Retained(receipt) => break 'retained receipt,
                        NativeOutcome::Terminal(outcome) => break 'terminal (outcome, None),
                        NativeOutcome::Completed => {},
                    }
                    Some(match oracle {
                        Some(oracle) => oracle,
                        None => crate::evaluation::prepare_online(&ctx, &request, &binding).await?,
                    })
                };
                let Some(checked) = check_observation(&ctx, &request, &step.id, oracle).await? else {
                    break 'retained None;
                };
                break 'terminal (checked.outcome.clone(), Some(checked));
            };
            return super::archive::finish(&ctx, &request, &step.id, outcome, oracle).await;
        };
        retain(&ctx, &step.id, receipt).await
    })
}

fn prepare_context<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    step_id: &'a StepId,
    binding: &'a crate::authorization::OnlineOracleBinding,
) -> StoreFuture<'a, (Checkpoint, bool, Option<crate::evaluation::OnlineOraclePlan>), Error> {
    Box::pin(async move {
        let mut state = read_current(ctx, step_id).await?;
        let resumed_at = now()?;
        let cleanup = ctx.cancellation.is_cancelled()
            || tokio::time::Instant::now() >= ctx.deadline.min(ctx.budget.deadline())
            || state.execution.as_ref().is_some_and(|execution| execution.budget.deadline.as_ref().is_none_or(|deadline| deadline <= &resumed_at));
        if !cleanup && state.execution.is_none() {
            let authority = ctx.evaluation_authority()?;
            if !authority.same_root(&ctx.authority) || authority.world() != &ctx.operation.world { return Err(changed()); }
        }
        // An existing native request is inspected and settled before any new oracle or context work.
        let oracle = if cleanup || state.execution.is_some() {
            None
        } else {
            Some(crate::evaluation::prepare_online(ctx, request, binding).await?)
        };
        if state.context.is_none() && !cleanup {
            observation::resolve(ctx, request, step_id).await?;
            state = read_current(ctx, step_id).await?;
        }
        Ok((state, cleanup, oracle))
    })
}

fn check_observation<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    step_id: &'a StepId,
    oracle: Option<crate::evaluation::OnlineOraclePlan>,
) -> StoreFuture<'a, Option<crate::evaluation::OnlineOracleResult>, Error> {
    Box::pin(async move {
        let observed = observation::observe(ctx, request, step_id).await?;
        crate::evaluation::check_online(ctx, oracle.ok_or_else(changed)?, &observed).await
    })
}

enum NativeOutcome {
    Retained(Option<InvestigationReceipt>),
    Terminal(CaseOutcome),
    Completed,
}

fn settle_receipt<'a>(
    ctx: &'a ExecutionContext,
    step_id: &'a StepId,
    receipt: InvestigationReceipt,
    cleanup: bool,
) -> StoreFuture<'a, NativeOutcome, Error> {
    Box::pin(async move {
        let execution = read_current(ctx, step_id).await?.execution.ok_or_else(changed)?;
        if receipt.identity != execution.identity {
            return Ok(NativeOutcome::Retained(None));
        }
        let authority = ctx.investigation_binding().ok_or_else(changed)?;
        authority.observe_receipt(&receipt)?;
        checkpoint_receipt(ctx, step_id, &receipt).await?;
        match &receipt.state {
            InvestigationState::Rejected { .. }
                if receipt.sentness != InvestigationSentness::NotSent || receipt.accepted.is_some() =>
            {
                Ok(NativeOutcome::Retained(Some(receipt)))
            }
            InvestigationState::Rejected { reason } => {
                ctx.join_investigation_child_work(&receipt.identity.binding_id, native_cleanup_deadline(ctx)).await?;
                account_not_sent(ctx, step_id).await?;
                authority.acknowledge_receipt(&receipt)?;
                settle_native(ctx, step_id, authority.clone()).await?;
                let details = match reason {
                    InvestigationRejection::UnsupportedBudget { dimensions }
                        if !dimensions.is_empty() =>
                    {
                        OperationFailure::BudgetExceeded { dimension: dimensions[0], }
                    }
                    _ => OperationFailure::Learning(
                        world_protocol::learning::LearningFailure::UnauthorizedOperation,
                    ),
                };
                let error = Error::new(
                    "world.investigation_rejected",
                    FailureStage::Execute,
                    "调查未发送；执行选择或原生预算能力不满足要求。",
                    ApiFailure::Operation(details),
                    Recovery::Refresh,
                );
                fail_not_sent(ctx, step_id, &error).await?;
                Err(error)
            }
            InvestigationState::Terminal { status } => {
                if receipt.accepted.is_none() {
                    return Ok(NativeOutcome::Retained(Some(receipt)));
                }
                ctx.join_investigation_child_work(&receipt.identity.binding_id, native_cleanup_deadline(ctx)).await?;
                let InvestigationUsage::Complete { usage } = &receipt.usage else {
                    return Ok(NativeOutcome::Retained(Some(receipt)));
                };
                if usage.cost.is_none() && execution.budget.max_cost.is_some() {
                    return Ok(NativeOutcome::Retained(Some(receipt)));
                }
                let accounting_failure = match account_native(ctx, step_id, usage).await {
                    Ok(()) => None,
                    Err(error) => {
                        if !read_current(ctx, step_id).await?.native_usage_accounted { return Err(error); }
                        Some(error)
                    },
                };
                authority.acknowledge_receipt(&receipt)?;
                settle_native(ctx, step_id, authority.clone()).await?;
                if let Some(error) = accounting_failure { return Err(error); }
                if cleanup || ctx.cancellation.is_cancelled() || tokio::time::Instant::now() >= ctx.deadline.min(ctx.budget.deadline()) {
                    return Err(cleanup_error(ctx));
                }
                if ctx.cancellation.is_cancelled() || *status == InvestigationTerminal::Cancelled {
                    return Ok(NativeOutcome::Terminal(CaseOutcome::Cancelled {
                        stage: FailureStage::Execute,
                    }));
                }
                if *status != InvestigationTerminal::Completed {
                    return Ok(NativeOutcome::Terminal(native_failed(ctx, step_id)));
                }
                Ok(NativeOutcome::Completed)
            }
            _ => Ok(NativeOutcome::Retained(Some(receipt))),
        }
    })
}

fn native_receipt<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    step_id: &'a StepId,
    state: &'a Checkpoint,
    cleanup: bool,
) -> StoreFuture<'a, ControlFlow<CaseOutcome, InvestigationReceipt>, Error> {
    Box::pin(async move {
        let receipt = if let Some(receipt) = state.receipt.as_ref().filter(|receipt| {
            ctx.investigation_binding().is_some_and(|authority| authority.observe_receipt(receipt).is_ok())
                && matches!(receipt.state, InvestigationState::Terminal { .. })
                && receipt.accepted.is_some()
                && matches!(receipt.usage, InvestigationUsage::Complete { ref usage } if usage.cost.is_some()
                    || state.execution.as_ref().is_some_and(|execution| execution.budget.max_cost.is_none()))
        }) {
            receipt.clone()
        } else if let Some(execution) = &state.execution {
            restore_allowance(ctx, execution, state.native_usage_accounted || state.native_not_sent_accounted)?;
            let identity = execution.identity.clone();
            let authority = current_binding(ctx, step_id).await?;
            let native = execution.request(authority);
            let waiting = if cleanup {
                ctx.resources.investigation.cancel(native, now()?)
            } else {
                // Dispatch was durably recorded: ambiguous outcomes only inspect this original identity.
                ctx.resources.investigation.inspect(native)
            };
            match tokio::time::timeout_at(native_cleanup_deadline(ctx), waiting).await {
                Ok(receipt) => receipt,
                Err(_) => unknown(identity),
            }
        } else {
            if ctx.cancellation.is_cancelled() {
                return Ok(ControlFlow::Break(CaseOutcome::Cancelled {
                    stage: FailureStage::Execute,
                }));
            }
            let (execution, replayed) = prepare_execution(ctx, request, step_id).await?;
            let identity = execution.identity.clone();
            let authority = current_binding(ctx, step_id).await?;
            let native = execution.request(authority);
            let waiting = if replayed {
                ctx.resources.investigation.inspect(native)
            } else {
                ctx.resources.investigation.execute(native)
            };
            match tokio::time::timeout_at(
                if replayed { native_cleanup_deadline(ctx) } else { ctx.deadline },
                waiting,
            ).await {
                Ok(receipt) => receipt,
                Err(_) => unknown(identity),
            }
        };
        Ok(ControlFlow::Continue(receipt))
    })
}

pub(super) fn read_current<'a>(
    ctx: &'a ExecutionContext,
    step: &'a StepId,
) -> StoreFuture<'a, Checkpoint, Error> {
    Box::pin(async move {
        decode(&read_step_current(ctx, step).await?)
    })
}

pub(super) fn read_step_current<'a>(
    ctx: &'a ExecutionContext,
    step: &'a StepId,
) -> StoreFuture<'a, StepRecord, Error> {
    Box::pin(async move {
        let saved = ctx.clone();
        let id = step.clone();
        ctx.store
            .snapshot(ctx.operation.world.clone(), move |snapshot| {
                Box::pin(async move {
                    let now = snapshot.now().await?;
                    crate::authorization::recheck_read(snapshot, &saved.admission, &now).await?;
                    let operation =
                        owner::read_record_snapshot(snapshot, &saved.operation.operation_id).await?;
                    operation
                        .identity
                        .require_resume(saved.admission.verified())?;
                    let step = owner::read_step_snapshot(snapshot, &saved.run.id, &id)
                        .await?
                        .ok_or_else(changed)?;
                    if operation.receipt.progress.run_id.as_ref() != Some(&saved.run.id)
                        || step.run_id != saved.run.id
                        || step.kind != "learning.resolve"
                        || step.input_digest != canonical_digest(operation.input.command()?)?
                    {
                        return Err(changed());
                    }
                    let state = decode(&step)?;
                    if state.binding.operation_id != saved.operation.operation_id
                        || state.binding.run_id != saved.run.id
                        || state.binding.release_id
                            != saved.run.release_id.clone().ok_or_else(changed)?
                        || state.binding.activation_lock_id
                            != saved.run.activation_lock_id.clone().ok_or_else(changed)?
                    {
                        return Err(changed());
                    }
                    Ok(step)
                })
            })
            .await
    })
}

fn prepare_execution<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    step_id: &'a StepId,
) -> StoreFuture<'a, (InvestigationRequestState, bool), Error> {
    Box::pin(async move {
        let original = read_step_current(ctx, step_id).await?;
        let state = decode(&original)?;
        let context = state.context.as_ref().ok_or_else(changed)?;
        let page = context.page.as_ref().ok_or_else(changed)?;
        if context.view.is_none() || !super::context::ready(context) {
            return Err(changed());
        }
        let context_digest = canonical_digest(context)?;
        let revision = original.revision;
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
        // Oracle/expected/policy credentials never enter the investigation prompt.
        let material = (
            &request.task,
            &state.task.input_type,
            &request.input,
            context.view.as_ref().ok_or_else(changed)?,
            context.contract.as_ref(),
        );
        let execution_prompt =
            serde_json::to_string(&material).map_err(|cause| changed().caused(cause))?;
        ctx.budget
            .charge(BudgetDimension::Bytes, execution_prompt.len() as u64)
            .map_err(budget_error)?;
        let material_digest = canonical_digest(&material)?;
        let digest = canonical_digest(&(
            "world.investigation.identity.v1",
            &state.binding,
            &material_digest,
        ))?;
        let created_at = now()?;
        let budget = remaining_budget(ctx, &state.deadline, &created_at)?;
        let allowance = super::authority::allowance(&budget);
        let allowance_id = ctx.commit_id("resolution.native_allowance")?;
        let mut identity = InvestigationIdentity {
            selection: request.execution.clone(),
            binding_id: BindingId::try_new(format!("world-investigation-{}", &digest.as_str()[7..]))
                .map_err(|cause| changed().caused(cause))?,
            native_request_id: format!("world-task-{}", &digest.as_str()[7..]),
            task: request.task.clone(),
            operation: ctx.operation.clone(),
            run_id: ctx.run.id.clone(),
            step_id: step_id.clone(),
            attempt: original.attempt,
            case_id: state.binding.case_id,
            world_request_id: ctx.admission.invocation().replay_id.clone(),
            input_digest: canonical_digest(&request.input)?,
            material_digest,
            content_budget_digest: super::authority::content_budget_digest(&execution_prompt)?,
        };
        let request_id = request.clone();
        let input_digest = canonical_digest(&request_id)?;
        let id = step_id.clone();
        let root = ctx.authority.clone();
        let store = ctx.store.clone();
        let parent_budget = ctx.budget.clone();
        let cancellation = ctx.cancellation.clone();
        let held = allowance_id.clone();
        let dispatched = ctx.transact_investigation(
            "resolution.dispatch", input_digest.clone(), &["learning", "authorization"],
            move |tx, admission, operation, run| Box::pin(async move {
                admission.require_access(&super::impact(tx, &request_id).await?)?;
                let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                let mut state = decode(&step)?;
                if step.revision != revision || state.execution.is_some()
                    || state.context.as_ref().map(canonical_digest).transpose()?.as_ref() != Some(&context_digest)
                    || !state.context.as_ref().is_some_and(super::context::ready)
                {
                    return Err(changed());
                }
                let context = state.context.as_ref().ok_or_else(changed)?;
                let page = context.page.as_ref().ok_or_else(changed)?;
                let context_request = world_protocol::slots::ContextRequest {
                    world: state.task.world.clone(), task: state.task.clone(),
                    query: request_id.query.clone(), budget: state.task.budget.clone(),
                };
                let result = world_protocol::slots::ContextResult {
                    view: context.view.clone().ok_or_else(changed)?, receipt: page.receipt.clone(),
                };
                crate::context::recheck_result(tx, &admission, &context_request, page, &result, &cancellation).await?;
                let (query_impact, (query_root, query_lock)) = crate::owner::investigation_query_preflight(tx, &request_id.query, &state.task.scope).await?;
                admission.require_access(&query_impact)?;
                let graph = crate::extensions::bindings::read_graph_history_in_transaction(tx, &query_lock).await?;
                let bindings = query_impact.access.iter().filter(|access| access.modes.contains(&world_protocol::authorization::AccessMode::Execute))
                    .flat_map(|access| &access.resources).filter_map(|resource| match resource {
                        ResourceRef::Binding { id } => Some(id.clone()), _ => None,
                    }).collect::<std::collections::BTreeSet<_>>();
                let graph_bindings = graph.lock().nodes.iter().map(|node| &node.binding_id).collect::<std::collections::BTreeSet<_>>();
                if !bindings.iter().all(|id| graph_bindings.contains(id))
                    || !bindings.contains(&graph.node(&query_root).map_err(crate::extensions::bindings::BindingError::from)?.binding_id)
                { return Err(changed()); }
                let query_closure = super::InvestigationQueryClosure { activation_lock_id: query_lock, root: query_root, bindings: bindings.into_iter().collect() };
                let finite_impact = super::authority::finite_impact(&state, &query_closure)?;
                admission.require_access(&finite_impact)?;
                identity.world_request_id = operation.input.command_envelope()?.request_id.clone();
                let execution = InvestigationRequestState {
                    identity, execution_prompt, allowed_effects: state.task.allowed_effects.clone(),
                    finite_impact, query_closure, allowance_id: held.clone(), allowance: allowance.clone(), budget, created_at,
                };
                parent_budget.reserve(&held, allowance).map_err(reservation_error)?;
                state.execution = Some(execution.clone());
                let mut next = step.clone();
                next.phase = OperationPhase::Retained;
                next.checkpoint = encode(&state)?;
                let next = owner::checkpoint_step(tx, &step, next).await?;
                let now = tx.now().await?;
                let authority = crate::authorization::mint_investigation(
                    tx, &store, &root, &admission, &operation, &run, &next,
                    &execution.identity, &execution.finite_impact, &parent_budget, &cancellation, &now,
                ).await?;
                owner::checkpoint_usage(tx, &run, owner::confirmed_usage(&run.usage, parent_budget.checkpoint_usage())?).await?;
                owner::update_operation(tx, &operation.receipt.accepted, OperationUpdate {
                    phase: OperationPhase::Retained, progress: operation.receipt.progress.clone(),
                    failure: None, effects: Vec::new(),
                }, &now).await?;
                Ok((execution, authority))
            }),
        ).await;
        match dispatched {
            Ok((committed, _)) => Ok((committed.value, committed.replayed)),
            Err(primary) => {
                // Arbitrate the original dispatch ID; only a proved rollback can release its bound.
                let request = ctx.commit_request("resolution.dispatch", input_digest, &["learning", "authorization"]).await?;
                match ctx.store.transact::<InvestigationRequestState, Error, _>(request.prepare()?, |_| Box::pin(async {
                    Err(crate::store::StoreError::new(world_protocol::commit::CommitFailure::RolledBack, FailureStage::Recover).into())
                })).await {
                    Err(crate::store::TransactionError::NotCommitted { cleanup: None, .. }) => {
                        if ctx.budget.reserved_usage(&allowance_id).is_some() {
                            ctx.budget.release_reserved(&allowance_id).map_err(reservation_error)?;
                        }
                    }
                    _ => {},
                }
                Err(primary)
            }
        }
    })
}

fn merge_receipt(state: &mut Checkpoint, mut receipt: InvestigationReceipt) -> Result<(), Error> {
    if state.execution.as_ref().map(|execution| &execution.identity) != Some(&receipt.identity) { return Err(changed()); }
    if let Some(previous) = &state.receipt {
        if previous.identity != receipt.identity
            || previous.accepted.as_ref().zip(receipt.accepted.as_ref()).is_some_and(|(left, right)| left != right)
            || matches!((&previous.usage, &receipt.usage),
                (InvestigationUsage::Complete { usage: left }, InvestigationUsage::Complete { usage: right }) if left != right)
            || previous.accepted.is_some() && receipt.sentness == InvestigationSentness::NotSent
            || matches!((&previous.state, &receipt.state),
                (InvestigationState::Terminal { status: left }, InvestigationState::Terminal { status: right }) if left != right)
        { return Err(changed()); }
        if matches!(previous.state, InvestigationState::Terminal { .. })
            && (!matches!(receipt.state, InvestigationState::Terminal { .. })
                || matches!(previous.usage, InvestigationUsage::Complete { .. }) && matches!(receipt.usage, InvestigationUsage::Unavailable))
        { return Ok(()); }
        if receipt.accepted.is_none() { receipt.accepted = previous.accepted.clone(); }
        if matches!(receipt.usage, InvestigationUsage::Unavailable) { receipt.usage = previous.usage.clone(); }
    }
    state.receipt = Some(receipt);
    Ok(())
}

fn checkpoint_receipt<'a>(
    ctx: &'a ExecutionContext,
    id: &'a StepId,
    receipt: &'a InvestigationReceipt,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let id = id.clone();
        let receipt = receipt.clone();
        ctx.transact(
            &format!(
                "resolution.receipt.{}",
                &canonical_digest(&receipt)?.as_str()[7..]
            ),
            canonical_digest(&receipt)?,
            &["learning", "authorization"],
            move |tx, _, _, run| {
                Box::pin(async move {
                    let step = owner::read_step(tx, &run.id, &id)
                        .await?
                        .ok_or_else(changed)?;
                    let mut state = decode(&step)?;
                    if state
                        .execution
                        .as_ref()
                        .map(|execution| &execution.identity)
                        != Some(&receipt.identity)
                    {
                        return Err(changed());
                    }
                    merge_receipt(&mut state, receipt)?;
                    let mut next = step.clone();
                    next.phase = OperationPhase::Retained;
                    next.checkpoint = encode(&state)?;
                    owner::checkpoint_step(tx, &step, next).await?;
                    Ok(())
                })
            },
        )
        .await?;
        Ok(())
    })
}

fn retain<'a>(
    ctx: &'a ExecutionContext,
    id: &'a StepId,
    receipt: Option<InvestigationReceipt>,
) -> StoreFuture<'a, CommandResult, Error> {
    Box::pin(async move {
        let id = id.clone();
        let committed = ctx
            .transact(
                &format!("resolution.retain.{}", ctx.admission.invocation().id),
                canonical_digest(&(&id, &receipt))?,
                &["learning", "authorization"],
                move |tx, _, operation, run| {
                    Box::pin(async move {
                        let step = owner::read_step(tx, &run.id, &id)
                            .await?
                            .ok_or_else(changed)?;
                        let mut state = decode(&step)?;
                        if let Some(receipt) = receipt {
                            merge_receipt(&mut state, receipt)?;
                        }
                        let mut next = step.clone();
                        next.phase = OperationPhase::Retained;
                        next.result = None;
                        next.checkpoint = encode(&state)?;
                        owner::checkpoint_step(tx, &step, next).await?;
                        owner::update_operation(
                            tx,
                            &operation.receipt.accepted,
                            OperationUpdate {
                                phase: OperationPhase::Retained,
                                progress: operation.receipt.progress.clone(),
                                failure: None,
                                effects: Vec::new(),
                            },
                            &tx.now().await?,
                        )
                        .await?;
                        Ok(())
                    })
                },
            )
            .await?;
        Ok(CommandResult::Commit(committed.receipt))
    })
}

fn fail_not_sent<'a>(ctx: &'a ExecutionContext, id: &'a StepId, error: &'a Error) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let id = id.clone();
        let error = error.clone();
        let usage = ctx.budget.checkpoint_usage();
        ctx.transact(
            "resolution.not_sent",
            canonical_digest(&id)?,
            &["learning", "authorization"],
            move |tx, _, operation, run| {
                Box::pin(async move {
                    let step = owner::read_step(tx, &run.id, &id)
                        .await?
                        .ok_or_else(changed)?;
                    let mut next = step.clone();
                    next.phase = OperationPhase::Failed;
                    next.result = Some(serde_json::json!({"notSent": true}));
                    next.failure = error.operation_failure();
                    owner::checkpoint_step(tx, &step, next).await?;
                    owner::checkpoint_usage(tx, &run, owner::confirmed_usage(&run.usage, usage)?)
                        .await?;
                    let operation = owner::update_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationUpdate {
                            phase: OperationPhase::Running,
                            progress: operation.receipt.progress.clone(),
                            failure: None,
                            effects: Vec::new(),
                        },
                        &tx.now().await?,
                    )
                    .await?;
                    owner::fail_operation(
                        tx,
                        &operation.accepted,
                        error.operation_failure().ok_or_else(changed)?,
                        false,
                        &tx.now().await?,
                    )
                    .await?;
                    Ok(())
                })
            },
        )
        .await?;
        Ok(())
    })
}

fn current_binding<'a>(
    ctx: &'a ExecutionContext, id: &'a StepId,
) -> StoreFuture<'a, std::sync::Arc<crate::authorization::InvestigationBinding>, Error> {
    Box::pin(async move {
        let original = read_step_current(ctx, id).await?;
        let execution = decode(&original)?.execution.ok_or_else(changed)?;
        let root = ctx.authority.clone();
        let id = id.clone();
        if let Some(binding) = ctx.investigation_binding() {
            if !binding.budget().same_scope(&ctx.budget) { return Err(changed()); }
            let checked = binding.clone();
            ctx.transact(&format!("resolution.native.resume.{}.{}", original.revision.0, ctx.admission.invocation().id),
                canonical_digest(&execution)?, &["learning", "authorization"],
                move |tx, admission, operation, run| Box::pin(async move {
                    let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                    checked.check_resume(tx, &root, &admission, &operation, &run, &step,
                        &execution.identity, &execution.finite_impact, &tx.now().await?).await?;
                    Ok(())
                }),
            ).await?;
            return Ok(binding);
        }
        let store = ctx.store.clone();
        let budget = ctx.budget.clone();
        let cancellation = ctx.cancellation.clone();
        let (_, binding) = ctx.transact_investigation(
            &format!("resolution.native.restore.{}.{}", original.revision.0, ctx.admission.invocation().id),
            canonical_digest(&execution)?, &["learning", "authorization"],
            move |tx, admission, operation, run| Box::pin(async move {
                let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                let actual = decode(&step)?.execution.ok_or_else(changed)?;
                if canonical_digest(&actual)? != canonical_digest(&execution)? { return Err(changed()); }
                let now = tx.now().await?;
                let cleanup = cancellation.is_cancelled()
                    || operation.receipt.cancellation != world_protocol::operation::CancellationState::NotRequested
                    || actual.budget.deadline.as_ref().is_none_or(|deadline| deadline <= &now);
                let binding = if cleanup {
                    crate::authorization::mint_investigation_recovery(
                        tx, &store, &root, &admission, &operation, &run, &step,
                        &actual.identity, &actual.finite_impact, &budget, &cancellation, &now,
                    ).await?
                } else {
                    crate::authorization::mint_investigation(
                        tx, &store, &root, &admission, &operation, &run, &step,
                        &actual.identity, &actual.finite_impact, &budget, &cancellation, &now,
                    ).await?
                };
                Ok(((), binding))
            }),
        ).await?;
        binding.or_else(|| ctx.investigation_binding()).ok_or_else(changed)
    })
}

fn restore_allowance(ctx: &ExecutionContext, execution: &InvestigationRequestState, accounted: bool) -> Result<(), Error> {
    if !accounted {
        let actual = ctx.commit_id("resolution.native_usage")?;
        if ctx.budget.reserved_usage(&actual).is_none() {
            ctx.budget.restore_reserved(&execution.allowance_id, execution.allowance.clone()).map_err(reservation_error)?;
        }
    }
    Ok(())
}

fn remaining_budget(ctx: &ExecutionContext, original_deadline: &Timestamp, now: &Timestamp) -> Result<Budget, Error> {
    let mut budget = ctx.budget.limit();
    budget.max_wall_time = DurationMs(
        ctx.deadline
            .min(ctx.budget.deadline())
            .saturating_duration_since(tokio::time::Instant::now())
            .as_millis()
            .min(u64::MAX as u128) as u64,
    );
    for (dimension, limit) in [
        (BudgetDimension::Steps, &mut budget.max_steps),
        (BudgetDimension::SourceReads, &mut budget.max_source_reads),
        (BudgetDimension::Rows, &mut budget.max_rows),
        (BudgetDimension::Bytes, &mut budget.max_bytes),
        (BudgetDimension::ModelCalls, &mut budget.max_model_calls),
        (BudgetDimension::InputTokens, &mut budget.max_input_tokens),
        (BudgetDimension::OutputTokens, &mut budget.max_output_tokens),
    ] {
        *limit = ctx.budget.remaining(dimension).map_err(budget_error)?;
        if matches!(dimension, BudgetDimension::Steps | BudgetDimension::SourceReads | BudgetDimension::Rows | BudgetDimension::Bytes) {
            *limit /= 2;
        }
    }
    budget.max_cost = ctx.budget.remaining_cost().map_err(budget_error)?;
    let absolute = chrono::DateTime::parse_from_rfc3339(now.as_str()).map_err(|cause| changed().caused(cause))?
        .checked_add_signed(chrono::Duration::milliseconds(i64::try_from(budget.max_wall_time.0).map_err(|cause| changed().caused(cause))?))
        .ok_or_else(changed)?;
    let absolute = Timestamp::try_new(absolute.to_rfc3339()).map_err(|cause| changed().caused(cause))?;
    budget.deadline = Some(budget.deadline.unwrap_or_else(|| original_deadline.clone()).min(original_deadline.clone()).min(absolute));
    if budget.max_wall_time.0 == 0 { return Err(budget_error(crate::extensions::invocation::BudgetFailure { dimension: BudgetDimension::WallTime })); }
    for (dimension, amount) in [(BudgetDimension::Steps, budget.max_steps), (BudgetDimension::Bytes, budget.max_bytes)] {
        if amount == 0 { return Err(budget_error(crate::extensions::invocation::BudgetFailure { dimension })); }
    }
    Ok(budget)
}

fn account_native<'a>(ctx: &'a ExecutionContext, step: &'a StepId, usage: &'a Usage) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let id = ctx.commit_id("resolution.native_usage")?;
        let state = read_current(ctx, step).await?;
        if !matches!(state.receipt.as_ref().map(|receipt| &receipt.usage),
            Some(InvestigationUsage::Complete { usage: recorded }) if recorded == usage)
        {
            return Err(changed());
        }
        if state.native_usage_accounted {
            if ctx.budget.reserved_usage(&id).is_some() {
                ctx.budget.ack_actual(&id).map_err(reservation_error)?;
            }
            return Ok(());
        }
        let mut delta = usage.clone();
        delta.elapsed = DurationMs(0);
        let execution = state.execution.as_ref().ok_or_else(changed)?;
        restore_allowance(ctx, execution, false)?;
        let exceeded = match ctx.budget.settle_actual(&execution.allowance_id, &id, delta) {
            Ok(()) => None,
            Err(crate::extensions::invocation::ReservationFailure::Budget(failure)) => Some(failure),
            Err(cause) => return Err(reservation_error(cause)),
        };
        let confirmed = ctx
            .budget
            .checkpoint_with_actual(&id)
            .map_err(reservation_error)?;
        let step = step.clone();
        let exact = usage.clone();
        ctx.transact("resolution.native_usage", canonical_digest(usage)?, &["learning", "authorization"], move |tx, _, _, run| Box::pin(async move {
            let current = owner::read_step(tx, &run.id, &step).await?.ok_or_else(changed)?;
            let mut state = decode(&current)?;
            if !matches!(state.receipt.as_ref().map(|receipt| &receipt.usage), Some(InvestigationUsage::Complete { usage }) if usage == &exact) { return Err(changed()); }
            owner::checkpoint_usage(tx, &run, owner::confirmed_usage(&run.usage, confirmed)?).await?;
            state.native_usage_accounted = true;
            super::save(tx, &current, &state).await?;
            Ok(())
        })).await?;
        ctx.budget.ack_actual(&id).map_err(reservation_error)?;
        exceeded.map_or(Ok(()), |failure| Err(budget_error(failure)))
    })
}

fn account_not_sent<'a>(ctx: &'a ExecutionContext, id: &'a StepId) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let state = read_current(ctx, id).await?;
        if !state.receipt.as_ref().is_some_and(|receipt| matches!(receipt.state, InvestigationState::Rejected { .. })
            && receipt.sentness == InvestigationSentness::NotSent && receipt.accepted.is_none()) { return Err(changed()); }
        if state.native_not_sent_accounted { return Ok(()); }
        let execution = state.execution.as_ref().ok_or_else(changed)?;
        restore_allowance(ctx, execution, false)?;
        ctx.budget.release_reserved(&execution.allowance_id).map_err(reservation_error)?;
        let id = id.clone();
        let receipt = state.receipt;
        let usage = ctx.budget.checkpoint_usage();
        ctx.transact("resolution.native_not_sent", canonical_digest(&receipt)?, &["learning", "authorization"],
            move |tx, _, _, run| Box::pin(async move {
                let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                let mut state = decode(&step)?;
                if state.receipt != receipt { return Err(changed()); }
                owner::checkpoint_usage(tx, &run, owner::confirmed_usage(&run.usage, usage)?).await?;
                state.native_not_sent_accounted = true;
                super::save(tx, &step, &state).await?;
                Ok(())
            }),
        ).await?;
        Ok(())
    })
}

fn settle_native<'a>(
    ctx: &'a ExecutionContext, id: &'a StepId, authority: std::sync::Arc<crate::authorization::InvestigationBinding>,
) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let step_id = id.clone();
        let id = id.clone();
        let settled = ctx.transact("resolution.native_settlement", canonical_digest(&id)?, &["learning", "authorization"],
            move |tx, _, _, run| Box::pin(async move {
                let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                let mut state = decode(&step)?;
                if !state.native_usage_accounted && !state.native_not_sent_accounted { return Err(changed()); }
                let at = match state.native_settlement_at.clone() {
                    Some(at) => at,
                    None => { let at = tx.now().await?; state.native_settlement_at = Some(at.clone()); at },
                };
                super::save(tx, &step, &state).await?;
                Ok((state.execution.ok_or_else(changed)?, at))
            }),
        ).await?.value;
        let request = settled.0.request(authority.clone());
        authority.require_settlement(&request).map_err(native_verification_error)?;
        match tokio::time::timeout_at(native_cleanup_deadline(ctx), ctx.resources.investigation.settle(request.clone(), settled.1)).await {
            Ok(result) => result.map_err(native_verification_error)?,
            Err(_) => return Err(Error::new("world.investigation_settlement_pending", FailureStage::Drain,
                "原生调查结算确认尚未完成，保留原请求重试。", ApiFailure::Operation(OperationFailure::CleanupFailed), Recovery::Refresh)),
        }
        let identity = request.identity.clone();
        ctx.transact("resolution.native_settled", canonical_digest(&(&identity, &request.created_at))?, &["learning", "authorization"],
            move |tx, _, _, run| Box::pin(async move {
                let step = owner::read_step(tx, &run.id, &step_id).await?.ok_or_else(changed)?;
                let mut state = decode(&step)?;
                if state.execution.as_ref().map(|execution| &execution.identity) != Some(&identity)
                    || state.native_settlement_at.is_none() || (!state.native_usage_accounted && !state.native_not_sent_accounted) { return Err(changed()); }
                state.native_settled = true;
                super::save(tx, &step, &state).await?;
                Ok(())
            }),
        ).await?;
        authority.acknowledge_settlement(&request).map_err(native_verification_error)
    })
}

fn native_verification_error(cause: crate::NativeVerificationError) -> Error {
    Error::new("world.investigation_settlement_failed", FailureStage::Drain,
        "原生调查结算确认失败，原任务托管仍保留。", ApiFailure::Authorization(cause.reason().clone()), Recovery::Refresh).caused(cause)
}

fn native_cleanup_deadline(ctx: &ExecutionContext) -> tokio::time::Instant {
    tokio::time::Instant::now() + ctx.resources.preparation.execution_policy().cleanup_timeout
}

fn cleanup_error(ctx: &ExecutionContext) -> Error {
    if ctx.cancellation.is_cancelled() { return Error::from_host_failure(world_protocol::process::HostFailure::Cancelled, FailureStage::Execute); }
    budget_error(crate::extensions::invocation::BudgetFailure { dimension: BudgetDimension::WallTime })
}

fn reservation_error(failure: crate::extensions::invocation::ReservationFailure) -> Error {
    match failure {
        crate::extensions::invocation::ReservationFailure::Budget(failure) => budget_error(failure),
        crate::extensions::invocation::ReservationFailure::IdentityConflict(commit_id) => {
            crate::store::StoreError::new(
                world_protocol::commit::CommitFailure::CommitIdPayloadConflict { commit_id },
                FailureStage::Recover,
            )
            .into()
        }
    }
}

fn native_failed(ctx: &ExecutionContext, step: &StepId) -> CaseOutcome {
    CaseOutcome::Failed {
        failure: world_protocol::failure::Failure {
            code: "world.investigation_native_failed".into(),
            stage: FailureStage::Execute,
            message: "原生调查未完成任务执行。".into(),
            diagnostic_id: DiagnosticId::try_new(uuid::Uuid::new_v4().to_string())
                .expect("UUID identifier"),
            operation_id: Some(ctx.operation.operation_id.clone()),
            run_id: Some(ctx.run.id.clone()),
            step_id: Some(step.clone()),
            details: world_protocol::learning::LearningFailure::InternalFault,
            recovery: Recovery::None,
        },
    }
}

fn unknown(identity: InvestigationIdentity) -> InvestigationReceipt {
    InvestigationReceipt {
        identity,
        state: InvestigationState::Unknown,
        sentness: InvestigationSentness::MayHaveSent,
        accepted: None,
        usage: InvestigationUsage::Unavailable,
    }
}

fn budget_error(failure: crate::extensions::invocation::BudgetFailure) -> Error {
    Error::from_host_failure(
        world_protocol::process::HostFailure::BudgetExceeded {
            dimension: failure.dimension,
        },
        FailureStage::Execute,
    )
}

pub(super) fn now() -> Result<Timestamp, Error> {
    Timestamp::try_new(chrono::Utc::now().to_rfc3339())
        .map_err(|cause| Error::internal(FailureStage::Execute).caused(cause))
}
