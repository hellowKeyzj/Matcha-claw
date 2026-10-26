use world_protocol::{
    actions::ActionSubmitRequest,
    api::{ApiFailure, CommandEnvelope, WorldCommand},
    authorization::AuthorizationFailure,
    failure::{FailureStage, Recovery},
    ids::*,
    operation::{CancellationState, OperationPhase},
};

use crate::{
    actions,
    authorization::{self, Admission},
    definitions::canonical_digest,
    store::{StoreFuture, WorldTransaction},
};

use super::{Error, ExecutionContext, RunRecord, RunSpec, StepRecord, head, ledger, run};

pub(crate) fn strategy_action_context<'a>(
    parent: &'a ExecutionContext,
    parent_step: &'a StepRecord,
    strategy_step: &'a StepId,
    request: ActionSubmitRequest,
    admission: Admission,
) -> StoreFuture<'a, ExecutionContext, Error> {
    Box::pin(async move {
        let request_id = request_id(parent, strategy_step)?;
        if request.world != parent.operation.world || request.idempotency_key != request_id {
            return Err(conflict());
        }
        let envelope = CommandEnvelope {
            world: request.world.clone(),
            request_id,
            command: WorldCommand::ActionSubmit(request),
        };
        let link = parent_link(parent, parent_step, strategy_step);
        let id = ledger::operation_id(
            &envelope.world,
            &envelope.request_id,
            envelope.command.operation_name(),
        );
        let current_admission = admission.clone();
        let parent_step = parent_step.clone();
        let strategy_step = strategy_step.clone();
        let saved_link = link.clone();
        let child = parent
            .transact(
                &format!("strategy.action.child.{strategy_step}"),
                canonical_digest(&(&envelope, &link))?,
                &["actions", "packages", "authorization"],
                move |tx, parent_admission, operation, parent_run| {
                    Box::pin(async move {
                        require_parent(tx, &operation, &parent_run, &parent_step).await?;
                        require_identity(&parent_admission, &current_admission)?;
                        let now = tx.now().await?;
                        authorization::recheck(tx, &current_admission, &now).await?;
                        let impact = actions::impact(tx, &envelope.command).await?;
                        parent_admission.require_access(&impact)?;
                        current_admission.require_impact(&impact)?;
                        let WorldCommand::ActionSubmit(request) = &envelope.command else {
                            return Err(conflict());
                        };
                        let (proposal, _) = actions::read_proposal(tx, &request.proposal_id).await?;
                        crate::abstraction::require_online_action(
                            tx,
                            &parent_step,
                            &strategy_step,
                            &proposal.request.action,
                            &proposal.request.arguments,
                        )
                        .await?;
                        let (release_id, lock, mut budget) =
                            actions::run_basis(tx, &envelope.command).await?;
                        let branch_id = actions::run_branch(tx, &envelope.command).await?;
                        if parent_run.release_id.as_ref() != Some(&release_id)
                            || parent_run.activation_lock_id.as_ref() != Some(&lock)
                            || parent_run.branch_id != branch_id
                        {
                            return Err(conflict());
                        }
                        budget.deadline = Some(budget.deadline.as_ref().map_or_else(
                            || parent_admission.invocation().deadline.clone(),
                            |deadline| {
                                deadline
                                    .min(&parent_admission.invocation().deadline)
                                    .clone()
                            },
                        ));
                        let generation = head::read(tx).await?.generation;
                        let operation = ledger::accept_strategy_action(
                            tx,
                            &current_admission,
                            &envelope,
                            saved_link,
                            id.clone(),
                            generation,
                            &now,
                        )
                        .await?;
                        operation
                            .identity
                            .require_resume(current_admission.verified())?;
                        if let Some(id) = &operation.receipt.progress.run_id {
                            return run::read_run(tx, id).await;
                        }
                        let digest = canonical_digest(&("world.run.v1", tx.world(), &id))?;
                        let spec = RunSpec {
                            id: RunId::try_new(format!("run-{}", &digest.as_str()[7..]))
                                .expect("digest identifier"),
                            activation_lock_id: Some(lock),
                            release_id: Some(release_id),
                            branch_id,
                            budget,
                            basis: serde_json::to_value(&envelope.command).map_err(|cause| {
                                Error::internal(FailureStage::Prepare).caused(cause)
                            })?,
                        };
                        run::start(
                            tx,
                            &current_admission,
                            &operation.receipt.accepted,
                            spec,
                            &now,
                        )
                        .await
                    })
                },
            )
            .await?
            .value;
        let expected = link;
        let current = admission.clone();
        let operation_id = child.operation.operation_id.clone();
        parent
            .store
            .snapshot(parent.operation.world.clone(), move |snapshot| {
                Box::pin(async move {
                    let now = snapshot.now().await?;
                    authorization::recheck_read(snapshot, &current, &now).await?;
                    let operation = ledger::read_record_snapshot(snapshot, &operation_id).await?;
                    operation.identity.require_resume(current.verified())?;
                    if operation.strategy_parent.as_ref() != Some(&expected) {
                        return Err(conflict());
                    }
                    Ok::<_, Error>(())
                })
            })
            .await?;
        context(parent, admission, child).await
    })
}

/// Only an existing original intent can use this read/inspect-only recovery context.
pub(crate) fn strategy_action_resume_context<'a>(
    parent: &'a ExecutionContext,
    parent_step: &'a StepRecord,
    strategy_step: &'a StepId,
) -> StoreFuture<'a, Option<ExecutionContext>, Error> {
    Box::pin(async move {
        let request_id = request_id(parent, strategy_step)?;
        let id = ledger::operation_id(&parent.operation.world, &request_id, "action.submit");
        let expected = parent_link(parent, parent_step, strategy_step);
        let step = parent_step.clone();
        let handoff = std::sync::Arc::new(std::sync::Mutex::new(None));
        let produced = handoff.clone();
        let child = parent.transact(
            &format!("strategy.action.inspect.{}", uuid::Uuid::new_v4()), canonical_digest(&expected)?,
            &["actions", "authorization"],
            move |tx, parent_admission, operation, parent_run| Box::pin(async move {
                require_parent(tx, &operation, &parent_run, &step).await?;
                let world = tx.world();
                if tx.query_opt("SELECT 1 FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?.is_none() {
                    return Ok(None);
                }
                let child = ledger::read(tx, &id).await?;
                if child.strategy_parent.as_ref() != Some(&expected) { return Err(conflict()); }
                child.identity.require_resume(parent_admission.verified())?;
                let run = run::read_run(tx, child.receipt.progress.run_id.as_ref().ok_or_else(conflict)?).await?;
                let (intent, execution, _) = actions::read_operation_intent(tx, &id).await?;
                let (proposal, _) = actions::read_proposal(tx, &execution.proposal_id).await?;
                crate::abstraction::require_online_action(tx, &step, &expected.strategy_step, &proposal.request.action, &proposal.request.arguments).await?;
                if intent.operation_id != id || intent.run_id != run.id || run.operation.operation_id != id { return Err(conflict()); }
                let key = world_protocol::operation::OperationKey { world: tx.world().clone(), operation_id: id };
                let admission = authorization::derive_action_recovery(tx, &parent_admission, &key, &tx.now().await?).await?;
                *produced.lock().expect("strategy recovery admission poisoned") = Some(admission);
                Ok(Some(run))
            }),
        ).await?.value;
        match child {
            Some(child) => {
                let admission = handoff
                    .lock()
                    .expect("strategy recovery admission poisoned")
                    .take()
                    .ok_or_else(conflict)?;
                context(parent, admission, child).await.map(Some)
            }
            None => Ok(None),
        }
    })
}

async fn require_parent(
    tx: &WorldTransaction<'_>,
    operation: &super::OperationRecord,
    run: &RunRecord,
    expected: &StepRecord,
) -> Result<(), Error> {
    if operation.receipt.progress.run_id.as_ref() != Some(&run.id)
        || operation.receipt.accepted.operation_id != run.operation.operation_id
        || !matches!(operation.input.command()?, WorldCommand::ResolveTask(_))
        || ledger::terminal(operation.receipt.phase)
        || operation.receipt.cancellation != CancellationState::NotRequested
        || expected.run_id != run.id
    {
        return Err(conflict());
    }
    let step = run::read_step(tx, &run.id, &expected.id)
        .await?
        .ok_or_else(conflict)?;
    if step.input_digest != expected.input_digest
        || step.kind != "learning.strategy"
        || step.ordinal != 2
        || ledger::terminal(step.phase)
        || matches!(
            step.phase,
            OperationPhase::Draining | OperationPhase::Retained
        )
    {
        return Err(conflict());
    }
    Ok(())
}

fn require_identity(parent: &Admission, child: &Admission) -> Result<(), Error> {
    parent.restart_identity().require_resume(child.verified())?;
    if parent.invocation().id != child.invocation().id
        || parent.invocation().request_digest != child.invocation().request_digest
        || parent.invocation().deadline != child.invocation().deadline
    {
        return Err(AuthorizationFailure::InvalidDelegation.into());
    }
    Ok(())
}

async fn context(
    parent: &ExecutionContext,
    admission: Admission,
    run: RunRecord,
) -> Result<ExecutionContext, Error> {
    let now = parent
        .store
        .snapshot(parent.operation.world.clone(), |snapshot| {
            Box::pin(async move { snapshot.now().await })
        })
        .await?;
    let commit = super::execution::execution_commit_id(&run.operation.world, &run.operation.operation_id, &run.id, "native.child.budget")?;
    let budget = parent.budget.run_scoped(&commit, &run.budget, &run.usage, &now).map_err(|failure| match failure {
        crate::extensions::invocation::ReservationFailure::Budget(failure) => Error::from_host_failure(
            world_protocol::process::HostFailure::BudgetExceeded { dimension: failure.dimension }, FailureStage::Prepare,
        ),
        crate::extensions::invocation::ReservationFailure::IdentityConflict(_) => AuthorizationFailure::InvalidDelegation.into(),
    })?;
    Ok(ExecutionContext {
        admission,
        operation: run.operation.clone(),
        run,
        deadline: parent.deadline.min(budget.deadline()),
        budget,
        ..parent.clone()
    })
}

fn parent_link(
    parent: &ExecutionContext,
    step: &StepRecord,
    strategy_step: &StepId,
) -> ledger::StrategyActionParent {
    ledger::StrategyActionParent {
        operation_id: parent.operation.operation_id.clone(),
        run_id: parent.run.id.clone(),
        step_id: step.id.clone(),
        input_digest: step.input_digest.clone(),
        strategy_step: strategy_step.clone(),
    }
}

fn request_id(parent: &ExecutionContext, strategy_step: &StepId) -> Result<RequestId, Error> {
    let digest = canonical_digest(&(
        "world.strategy.action.v1",
        &parent.operation.world,
        &parent.operation.operation_id,
        strategy_step,
    ))?;
    RequestId::try_new(format!("strategy-action-{}", &digest.as_str()[7..]))
        .map_err(|cause| conflict().caused(cause))
}

fn conflict() -> Error {
    Error::new(
        "world.strategy_action_conflict",
        FailureStage::Recover,
        "策略动作与原父执行记录不一致，请读取原操作状态。",
        ApiFailure::RevisionConflict,
        Recovery::Refresh,
    )
}
