use super::{Checkpoint, changed, combined, decode, encode};
use crate::{
    authorization::{self, OnlineOracleBinding},
    owner::{self, Error, ExecutionContext, StepRecord},
    store::{StoreFuture, WorldTransaction},
};
use world_protocol::{
    api::{ResolveTaskRequest, WorldCommand},
    authorization::{AccessMode, AccessScope, ActualImpact},
    bindings::ImplementationRef,
    budget::Budget,
    ids::*,
    learning::{OracleSpec, TaskContract},
    operation::{CancellationState, OperationPhase},
    time::Timestamp,
};

pub(crate) async fn task(
    tx: &WorldTransaction<'_>,
    request: &ResolveTaskRequest,
) -> Result<TaskContract, Error> {
    let task = crate::evaluation::read_task(tx, &request.task.id, request.task.revision).await?;
    let contract =
        crate::abstraction::read(tx, &request.abstraction_id, request.abstraction_revision)
            .await?
            .ok_or_else(changed)?;
    if request.task.world != *tx.world()
        || request.query.world != *tx.world()
        || task.world != request.task.world
        || contract.task_id != task.id
        || contract.task_revision != task.revision
        || contract.scope != task.scope
        || request.query.release_id.as_ref() != Some(&contract.base_release)
        || request.query.branch_id.as_ref() != contract.branch.as_ref().map(|branch| &branch.id)
        || request.query.page.cursor.is_some()
        || request.query.known_at.is_some()
        || request.query.valid_at.is_some()
    {
        return Err(changed());
    }
    crate::definitions::validate_value(&task.input_type, false, &request.input)
        .map_err(crate::definitions::DefinitionError::from)
        .map_err(crate::learning::Error::from)?;
    Ok(task)
}

pub(crate) fn impact<'a>(
    tx: &'a WorldTransaction<'_>,
    request: &'a ResolveTaskRequest,
) -> StoreFuture<'a, ActualImpact, Error> {
    Box::pin(async move {
        let task = task(tx, request).await?;
        let contract =
            crate::abstraction::read(tx, &request.abstraction_id, request.abstraction_revision)
                .await?
                .ok_or_else(changed)?;
        let (branch, candidate) = crate::releases::read_candidate(tx, &contract.candidate_id)
            .await?
            .ok_or_else(changed)?;
        let context = world_protocol::slots::ContextRequest {
            world: request.task.world.clone(),
            task: task.clone(),
            query: request.query.clone(),
            budget: task.budget.clone(),
        };
        let mut access = vec![
            AccessScope {
                resources: vec![ResourceRef::Task { id: task.id }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read, AccessMode::Execute],
                scope: task.scope.clone(),
                valid_time: None,
            },
            AccessScope {
                resources: vec![ResourceRef::TestCase {
                    id: request.test.id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: task.scope.clone(),
                valid_time: None,
            },
            AccessScope {
                resources: Vec::new(),
                fields: Vec::new(),
                modes: vec![AccessMode::Write],
                scope: task.scope.clone(),
                valid_time: None,
            },
        ];
        access.push(AccessScope {
            resources: vec![ResourceRef::ChangeSet {
                id: candidate.change_set.id,
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: task.scope.clone(),
            valid_time: None,
        });
        access.push(AccessScope {
            resources: vec![ResourceRef::Branch { id: branch.id }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: task.scope.clone(),
            valid_time: None,
        });
        let (_, lock, _, _) = run_basis(tx, request).await?;
        let graph = crate::extensions::bindings::read_graph_history_in_transaction(
            tx, &lock.ok_or_else(changed)?,
        ).await?;
        access.push(super::context::access(&graph, &task.scope)?);
        let base =
            authorization::actual_impact(access, Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
        combined(
            combined(base, crate::abstraction::online_impact(tx, request).await?)?,
            combined(crate::context::impact(tx, &context).await?,
                crate::owner::investigation_query_preflight(tx, &request.query, &task.scope).await?.0)?,
        )
    })
}

pub(crate) async fn run_basis(
    tx: &WorldTransaction<'_>,
    request: &ResolveTaskRequest,
) -> Result<
    (
        Option<ReleaseId>,
        Option<ActivationLockId>,
        Option<BranchId>,
        Budget,
    ),
    Error,
> {
    let task = task(tx, request).await?;
    let contract =
        crate::abstraction::read(tx, &request.abstraction_id, request.abstraction_revision)
            .await?
            .ok_or_else(changed)?;
    let lock = if let Some(reference) = &contract.branch {
        let branch = crate::releases::read_branch_revision(tx, reference)
            .await?
            .ok_or_else(changed)?;
        branch.compile.activation_lock.id
    } else {
        crate::releases::read_release(tx, &contract.base_release)
            .await?
            .ok_or_else(changed)?
            .artifact
            .activation_lock_id
    };
    Ok((
        Some(contract.base_release),
        Some(lock),
        request.query.branch_id.clone(),
        task.budget,
    ))
}

pub(crate) fn require_settled_execution(
    step: &StepRecord, authority: &crate::authorization::InvestigationBinding,
) -> Result<bool, Error> {
    if step.kind != "learning.resolve" || !authority.released() { return Ok(false); }
    let state = decode(step)?;
    let Some(execution) = state.execution.as_ref() else { return Ok(false); };
    if &execution.identity != authority.identity() || state.native_settlement_at.is_none() || !state.native_settled { return Ok(false); }
    super::authority::require_investigation_recovery_checkpoint(step, &execution.identity, &execution.finite_impact)?;
    let Some(receipt) = state.receipt.as_ref() else { return Ok(false); };
    if receipt.identity != execution.identity { return Err(changed()); }
    authority.observe_receipt(receipt)?;
    Ok(match &receipt.state {
        super::InvestigationState::Terminal { .. } => state.native_usage_accounted && receipt.accepted.is_some()
            && matches!(&receipt.usage, super::InvestigationUsage::Complete { usage } if usage.cost.is_some() || execution.budget.max_cost.is_none()),
        super::InvestigationState::Rejected { .. } => state.native_not_sent_accounted
            && receipt.sentness == super::InvestigationSentness::NotSent && receipt.accepted.is_none(),
        _ => false,
    })
}

pub(crate) async fn has_unsettled_execution(
    store: &crate::store::WorldStore, world: &WorldRef, run: &RunId, request: &ResolveTaskRequest,
) -> Result<bool, Error> {
    let run_id = run.clone();
    let request = request.clone();
    store.snapshot(world.clone(), move |snapshot| Box::pin(async move {
        let run = owner::read_run_snapshot(snapshot, &run_id).await?;
        let operation = owner::read_record_snapshot(snapshot, &run.operation.operation_id).await?;
        if !matches!(operation.input.command()?, WorldCommand::ResolveTask(actual) if actual == &request)
            || operation.receipt.progress.run_id.as_ref() != Some(&run.id)
            || owner::terminal_phase(operation.receipt.phase) || owner::terminal_phase(run.phase)
        { return Ok(false); }
        let digest = crate::definitions::canonical_digest(&(
            "world.resolution.v1", snapshot.world(), &operation.receipt.accepted.operation_id, &run.id,
        ))?;
        let id = StepId::try_new(format!("resolution-{}", &digest.as_str()[7..])).map_err(|cause| changed().caused(cause))?;
        let Some(step) = owner::read_step_snapshot(snapshot, &run.id, &id).await? else { return Ok(false); };
        if owner::terminal_phase(step.phase) { return Ok(false); }
        let state = decode(&step)?;
        let Some(execution) = state.execution.as_ref() else { return Ok(false); };
        if step.input_digest != crate::definitions::canonical_digest(operation.input.command()?)?
            || execution.identity.operation.world != operation.receipt.accepted.world
            || execution.identity.operation.operation_id != operation.receipt.accepted.operation_id
            || execution.identity.operation.incarnation != operation.receipt.accepted.incarnation
            || execution.identity.selection != request.execution || execution.identity.task != request.task
            || execution.identity.world_request_id != operation.input.command_envelope()?.request_id
            || execution.identity.input_digest != crate::definitions::canonical_digest(&request.input)?
            || state.binding.test != request.test || state.binding.task != request.task
            || run.release_id.as_ref() != Some(&state.binding.release_id)
            || run.activation_lock_id.as_ref() != Some(&state.binding.activation_lock_id)
        { return Err(changed()); }
        super::authority::require_investigation_recovery_checkpoint(&step, &execution.identity, &execution.finite_impact)?;
        Ok(true)
    })).await
}

pub(crate) fn binding(
    ctx: &ExecutionContext,
    request: &ResolveTaskRequest,
) -> Result<OnlineOracleBinding, Error> {
    let digest = crate::definitions::canonical_digest(&(
        "world.resolution.v1",
        &ctx.operation.world,
        &ctx.operation.operation_id,
        &ctx.run.id,
    ))?;
    Ok(OnlineOracleBinding {
        operation_id: ctx.operation.operation_id.clone(),
        run_id: ctx.run.id.clone(),
        step_id: StepId::try_new(format!("resolution-{}", &digest.as_str()[7..]))
            .map_err(|_| changed())?,
        task: request.task.clone(),
        test: request.test.clone(),
        case_id: CaseId::try_new(format!("resolution-{}", &digest.as_str()[7..]))
            .map_err(|_| changed())?,
        release_id: ctx.run.release_id.clone().ok_or_else(changed)?,
        activation_lock_id: ctx.run.activation_lock_id.clone().ok_or_else(changed)?,
        input_digest: crate::definitions::canonical_digest(&request.input)?,
    })
}

pub(super) fn claim<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    binding: &'a OnlineOracleBinding,
) -> StoreFuture<'a, StepRecord, Error> {
    Box::pin(async move {
        let request = request.clone();
        let binding = binding.clone();
        let digest = crate::definitions::canonical_digest(&WorldCommand::ResolveTask(request.clone()))?;
        Ok(ctx
            .transact(
                "resolution.claim",
                digest.clone(),
                &["learning", "authorization"],
                move |tx, admission, operation, run| {
                    Box::pin(async move {
                        if let Some(step) = owner::read_step(tx, &run.id, &binding.step_id).await? {
                            if step.input_digest != digest || decode(&step)?.binding != binding {
                                return Err(changed());
                            }
                            return Ok(step);
                        }
                        let now = tx.now().await?;
                        let task = task(tx, &request).await?;
                        let step = owner::claim_step(
                            tx,
                            &admission,
                            &run,
                            binding.step_id.clone(),
                            0,
                            "learning.resolve",
                            digest,
                            &now,
                        )
                        .await?;
                        let deadline = run
                            .budget
                            .deadline
                            .clone()
                            .unwrap_or_else(|| admission.invocation().deadline.clone())
                            .min(admission.invocation().deadline.clone());
                        let state = Checkpoint {
                            binding,
                            task,
                            deadline,
                            context: None,
                            execution: None,
                            receipt: None,
                            native_usage_accounted: false,
                            native_not_sent_accounted: false,
                            native_settlement_at: None,
                            native_settled: false,
                            observed: None,
                            observed_digest: None,
                        };
                        let mut next = step.clone();
                        next.checkpoint = encode(&state)?;
                        let next = owner::checkpoint_step(tx, &step, next).await?;
                        let mut progress = operation.receipt.progress.clone();
                        progress.step_id = Some(next.id.clone());
                        owner::update_operation(
                            tx,
                            &operation.receipt.accepted,
                            owner::OperationUpdate {
                                phase: OperationPhase::Running,
                                progress,
                                failure: None,
                                effects: Vec::new(),
                            },
                            &now,
                        )
                        .await?;
                        Ok(next)
                    })
                },
            )
            .await?
            .value)
    })
}

pub(crate) async fn require_online_oracle_binding(
    tx: &WorldTransaction<'_>,
    binding: &OnlineOracleBinding,
    implementation: &ImplementationRef,
    observed: &Digest,
    now: &Timestamp,
) -> Result<Timestamp, Error> {
    let operation = owner::read_operation_record(tx, &binding.operation_id).await?;
    let run = owner::read_run(tx, &binding.run_id).await?;
    let step = owner::read_step(tx, &binding.run_id, &binding.step_id)
        .await?
        .ok_or_else(changed)?;
    let state = decode(&step)?;
    let WorldCommand::ResolveTask(request) = operation.input.command()? else {
        return Err(changed());
    };
    let task = task(tx, request).await?;
    let test = crate::evaluation::read_online_test(tx, &request.test).await?;
    if binding.task.world != *tx.world()
        || state.binding != *binding
        || state.task != task
        || request.task != binding.task
        || request.test != binding.test
        || test.world != *tx.world()
        || !test.protected
        || test.task_id != task.id
        || test.task_revision != task.revision
        || test.oracle != task.success_oracle
        || !matches!(&task.success_oracle, OracleSpec::Program { implementation: exact, .. } if exact == implementation)
        || run.operation.operation_id != binding.operation_id
        || run.release_id.as_ref() != Some(&binding.release_id)
        || run.activation_lock_id.as_ref() != Some(&binding.activation_lock_id)
        || operation.receipt.progress.run_id.as_ref() != Some(&binding.run_id)
        || operation.receipt.progress.step_id.as_ref() != Some(&binding.step_id)
        || operation.receipt.cancellation != CancellationState::NotRequested
        || owner::terminal_phase(operation.receipt.phase)
        || step.kind != "learning.resolve"
        || !matches!(
            step.phase,
            OperationPhase::Verifying | OperationPhase::Running
        )
        || step.result.is_some()
        || state.deadline <= *now
        || state.observed_digest.as_ref() != Some(observed)
        || crate::definitions::canonical_digest(&request.input)? != binding.input_digest
        || step.input_digest != crate::definitions::canonical_digest(operation.input.command()?)?
    {
        return Err(changed());
    }
    if let Some(strategy) = state
        .context
        .as_ref()
        .and_then(|context| context.strategy.as_ref())
    {
        if state.execution.is_some() {
            return Err(changed());
        }
        crate::abstraction::require_online_strategy(tx, binding, request, strategy).await?;
    } else {
        let execution = state.execution.as_ref().ok_or_else(changed)?;
        let receipt = state.receipt.as_ref().ok_or_else(changed)?;
        let identity = &execution.identity;
        if !state.native_usage_accounted
            || receipt.identity != *identity
            || !matches!(receipt.state, super::InvestigationState::Terminal { status: super::InvestigationTerminal::Completed })
            || !matches!(receipt.usage, super::InvestigationUsage::Complete { .. })
            || identity.task != binding.task
            || identity.operation.operation_id != binding.operation_id
            || identity.operation.world != *tx.world()
            || identity.run_id != binding.run_id
            || identity.step_id != binding.step_id
            || identity.case_id != binding.case_id
            || identity.world_request_id != operation.input.command_envelope()?.request_id
            || identity.selection != request.execution
            || receipt.accepted.as_ref().is_none_or(|accepted| {
                accepted.binding_id != identity.binding_id
                    || accepted.accepted_request_id != identity.native_request_id
                    || accepted.content_budget_digest != identity.content_budget_digest
            })
        {
            return Err(changed());
        }
    }
    let page = state.observed.as_ref().ok_or_else(changed)?;
    if crate::definitions::canonical_digest(page)? != *observed
        || page.receipt.world != *tx.world()
        || page.receipt.release_id != binding.release_id
        || page.receipt.activation_lock_id != binding.activation_lock_id
    {
        return Err(changed());
    }
    Ok(state.deadline)
}
