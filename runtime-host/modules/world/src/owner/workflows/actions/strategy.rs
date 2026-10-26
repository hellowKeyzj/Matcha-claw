use serde::{Deserialize, Serialize};
use world_protocol::{
    actions::{
        ActionPhase, ActionProposal, ActionProposalRequest, ActionStatus, ActionSubmitRequest,
        ApprovalRequirement,
    },
    ids::*,
    operation::{OperationPhase, OperationResult},
    query::{QueryArgument, ReadReceipt},
};

use crate::{
    actions, authorization,
    definitions::canonical_digest,
    owner::{self, Error, ExecutionContext, StepRecord},
    store::{RetentionRoots, WorldTransaction},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum StrategyAction {
    PendingApproval {
        proposal: ActionProposal,
        required: ApprovalRequirement,
    },
    Effect {
        proposal: ActionProposal,
        status: ActionStatus,
    },
}

impl StrategyAction {
    pub(crate) fn completed(&self) -> bool {
        matches!(self, Self::Effect { status, .. } if status.phase == ActionPhase::Completed)
    }

    pub(crate) fn retain(&self, roots: &mut RetentionRoots) -> Result<(), Error> {
        let proposal = match self {
            Self::PendingApproval { proposal, .. } | Self::Effect { proposal, .. } => proposal,
        };
        actions::operation_retention_roots(
            &proposal.request.world,
            &OperationResult::Proposal(proposal.clone()),
            roots,
        )?;
        if let Self::Effect { status, .. } = self {
            actions::operation_retention_roots(
                &proposal.request.world,
                &OperationResult::Action(Box::new(status.clone())),
                roots,
            )?;
        }
        Ok(())
    }
}

pub(crate) async fn execute_strategy_action(
    ctx: &ExecutionContext,
    parent_step: &StepRecord,
    strategy_step: &StepId,
    action: &DefinitionRef,
    arguments: &[QueryArgument],
    basis: &[ReadReceipt],
) -> Result<StrategyAction, Error> {
    if let Some(child) =
        owner::strategy_action_resume_context(ctx, parent_step, strategy_step).await?
    {
        let intent = child_intent(&child)
            .await?
            .ok_or_else(|| super::invalid("strategy.childIntent"))?;
        if intent.action != *action || intent.argument_values.as_slice() != arguments {
            return Err(super::invalid("strategy.childInput"));
        }
        if !owner::terminal_phase(child.run.phase)
            && child.run.phase != OperationPhase::CommitIndeterminate
        {
            let result = async {
                super::resume_observation(&child, &intent.id).await?;
                super::recover_effect(&child, &intent).await
            }
            .await;
            return finish_child(&child, result).await;
        }
        return child_status(&child).await;
    }
    let proposal = propose(ctx, parent_step, strategy_step, action, arguments, basis).await?;

    let identity = canonical_digest(&(
        "world.strategy.action.v1",
        &ctx.operation.world,
        &ctx.operation.operation_id,
        strategy_step,
    ))?;
    let idempotency_key =
        RequestId::try_new(format!("strategy-action-{}", &identity.as_str()[7..]))
            .map_err(|cause| super::invalid("strategy.action.idempotencyKey").caused(cause))?;
    let (required, approval) = approval(ctx, parent_step, &proposal).await?;
    if required != ApprovalRequirement::None && approval.is_none() {
        return Ok(StrategyAction::PendingApproval { proposal, required });
    }
    let submit = ActionSubmitRequest {
        world: ctx.operation.world.clone(),
        proposal_id: proposal.id.clone(),
        proposal_digest: proposal.digest.clone(),
        idempotency_key,
        approval,
    };
    let (child, submit) = admit_child(ctx, parent_step, strategy_step, submit).await?;
    let has_intent = child_intent(&child).await?;
    let executed = if let Some(intent) = has_intent {
        async {
            super::resume_observation(&child, &intent.id).await?;
            super::recover_effect(&child, &intent).await
        }
        .await
    } else {
        super::submit(child.clone(), submit).await.map(|_| ())
    };
    finish_child(&child, executed).await
}

fn propose<'a>(
    ctx: &'a ExecutionContext,
    parent_step: &'a StepRecord,
    strategy_step: &'a StepId,
    action: &'a DefinitionRef,
    arguments: &'a [QueryArgument],
    basis: &'a [ReadReceipt],
) -> crate::store::StoreFuture<'a, ActionProposal, Error> {
    Box::pin(async move {
        let expected = parent_step.clone();
        let exact_step = strategy_step.clone();
        let exact_action = action.clone();
        let exact_arguments = arguments.to_vec();
        ctx.transact(
            &format!("strategy.action.current.{}", uuid::Uuid::new_v4()),
            canonical_digest(&(&parent_step.input_digest, strategy_step, action, arguments))?,
            &["actions", "learning", "authorization"],
            move |tx, _, _, run| {
                Box::pin(async move {
                    require_parent_step(tx, &run, &expected).await?;
                    crate::abstraction::require_online_action(
                        tx,
                        &expected,
                        &exact_step,
                        &exact_action,
                        &exact_arguments,
                    )
                    .await
                })
            },
        )
        .await?;
        let saved_step = parent_step.clone();
        let action = action.clone();
        let arguments = arguments.to_vec();
        let basis: Vec<_> = basis.iter().map(|receipt| receipt.id.clone()).collect();
        let budget = ctx.budget.clone();
        let cancel = ctx.cancellation.clone();
        let exact_strategy_step = strategy_step.clone();
        let input = canonical_digest(&(
            &parent_step.input_digest,
            strategy_step,
            &action,
            &arguments,
        ))?;
        let proposal = ctx
            .transact(
                &format!("strategy.action.propose.{strategy_step}"),
                input,
                &["actions", "facts", "query", "authorization"],
                move |tx, parent, _, run| {
                    Box::pin(async move {
                        require_parent_step(tx, &run, &saved_step).await?;
                        crate::abstraction::require_online_action(
                            tx,
                            &saved_step,
                            &exact_strategy_step,
                            &action,
                            &arguments,
                        )
                        .await?;
                        let request = ActionProposalRequest {
                            world: tx.world().clone(),
                            branch_id: run.branch_id.clone(),
                            targets: actions::targets(tx, &action, &arguments).await?,
                            action,
                            arguments,
                            basis,
                        };
                        let now = tx.now().await?;
                        let admission = authorization::derive_action(
                            tx,
                            &parent,
                            &world_protocol::api::WorldCommand::ActionPropose(request.clone()),
                            &now,
                        )
                        .await?;
                        let limit = actions::action(tx, &request.action).await?.body.budget;
                        let budget = budget.scoped(&limit, &now).map_err(budget_error)?;
                        let proposal =
                            actions::propose(tx, &admission, &run, request, &budget, &cancel).await?;
                        authorization::check_admitted_output(tx, &admission, &proposal.impact, 1, &now)
                            .await?;
                        Ok(proposal)
                    })
                },
            )
            .await?
            .value;

        Ok(proposal)
    })
}

fn approval<'a>(
    ctx: &'a ExecutionContext,
    parent_step: &'a StepRecord,
    proposal: &'a ActionProposal,
) -> crate::store::StoreFuture<
    'a,
    (
        ApprovalRequirement,
        Option<world_protocol::authorization::ApprovalBinding>,
    ),
    Error,
> {
    Box::pin(async move {
        let proposal_id = proposal.id.clone();
        let saved_step = parent_step.clone();
        let (required, approval) = ctx
            .transact(
                &format!("strategy.action.approval.{}", uuid::Uuid::new_v4()),
                canonical_digest(&proposal.id)?,
                &["actions", "authorization"],
                move |tx, parent, _, run| {
                    Box::pin(async move {
                        require_parent_step(tx, &run, &saved_step).await?;
                        let now = tx.now().await?;
                        let approval =
                            authorization::action_approval(tx, &parent, &proposal_id, &now).await?;
                        Ok((
                            actions::effective_approval(tx, &proposal_id).await?,
                            approval,
                        ))
                    })
                },
            )
            .await?
            .value;
        Ok((required, approval))
    })
}

fn admit_child<'a>(
    ctx: &'a ExecutionContext,
    parent_step: &'a StepRecord,
    strategy_step: &'a StepId,
    submit: ActionSubmitRequest,
) -> crate::store::StoreFuture<'a, (ExecutionContext, ActionSubmitRequest), Error> {
    Box::pin(async move {
        let saved_step = parent_step.clone();
        let parent = ctx.admission.clone();
        let parent_run = ctx.run.id.clone();
        let parent_operation = ctx.operation.operation_id.clone();
        let input = canonical_digest(&submit)?;
        let batch = ctx
            .prepare_batch(
                &format!("strategy.action.admission.{}", uuid::Uuid::new_v4()),
                input,
                &["actions", "authorization"],
            )
            .await?;
        let accepted = authorization::commit_admission(&ctx.store, batch, move |tx| {
            Box::pin(async move {
                tx.require_world_mutation_operation(&parent_operation)?;
                let run = owner::require_run_invocation(tx, &parent, &parent_run).await?;
                if run.operation.operation_id != parent_operation {
                    return Err(super::invalid("strategy.parentOperation"));
                }
                require_parent_step(tx, &run, &saved_step).await?;
                let now = tx.now().await?;
                let command = world_protocol::api::WorldCommand::ActionSubmit(submit.clone());
                let admission = authorization::derive_action(tx, &parent, &command, &now).await?;
                Ok::<_, Error>((submit, admission))
            })
        })
        .await
        .map_err(Error::from)?;
        let (submit, admission) = match accepted {
            authorization::AdmissionCommit::Committed { outcome, admission } => {
                (outcome.value, admission)
            }
            authorization::AdmissionCommit::Replayed(_) => {
                return Err(world_protocol::authorization::AuthorizationFailure::Replay.into());
            }
        };
        let child =
            owner::strategy_action_context(ctx, parent_step, strategy_step, submit.clone(), admission)
                .await?;
        Ok((child, submit))
    })
}

fn finish_child<'a>(
    ctx: &'a ExecutionContext,
    result: Result<(), Error>,
) -> crate::store::StoreFuture<'a, StrategyAction, Error> {
    Box::pin(async move {
        if let Err(error) = result {
            let settled = ctx
                .fail(&error)
                .await
                .map_err(|settlement| error.clone().with_related(settlement))?;
            if error.unresolved_phase() == Some(OperationPhase::CommitIndeterminate) {
                return Err(error);
            }
            if matches!(
                settled.phase,
                OperationPhase::EffectIndeterminate
                    | OperationPhase::Verifying
                    | OperationPhase::Retained
            ) || settled.failure.as_ref().is_some_and(|failure| {
                matches!(
                    failure.details,
                    world_protocol::operation::OperationFailure::Action(_)
                )
            }) {
                return child_status(ctx)
                    .await
                    .map_err(|disclosure| disclosure.with_related(error));
            }
            return Err(error);
        }
        child_status(ctx).await
    })
}

async fn require_parent_step(
    tx: &WorldTransaction<'_>,
    run: &owner::RunRecord,
    expected: &StepRecord,
) -> Result<(), Error> {
    let step = owner::read_step(tx, &run.id, &expected.id)
        .await?
        .ok_or_else(|| super::invalid("strategy.parentStep"))?;
    if expected.run_id != run.id
        || step.run_id != run.id
        || step.input_digest != expected.input_digest
        || step.kind != "learning.strategy"
        || expected.kind != step.kind
        || step.ordinal != expected.ordinal
        || owner::terminal_phase(step.phase)
        || matches!(
            step.phase,
            OperationPhase::Draining | OperationPhase::Retained
        )
    {
        return Err(super::invalid("strategy.parentStep"));
    }
    Ok(())
}

async fn child_intent(
    ctx: &ExecutionContext,
) -> Result<Option<world_protocol::actions::EffectIntent>, Error> {
    ctx.transact(
        &format!("strategy.action.intent.{}", uuid::Uuid::new_v4()),
        canonical_digest(&ctx.operation.operation_id)?, &["actions"],
        move |tx, _, operation, _| Box::pin(async move {
            let exists = tx.query_opt(
                "SELECT intent_id FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 AND operation_id=$3",
                &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &operation.receipt.accepted.operation_id.as_str()],
            ).await?;
            if exists.is_none() { return Ok(None); }
            Ok(Some(actions::read_operation_intent(tx, &operation.receipt.accepted.operation_id).await?.0))
        }),
    ).await.map(|committed| committed.value)
}

async fn child_status(ctx: &ExecutionContext) -> Result<StrategyAction, Error> {
    ctx.transact(
        &format!("strategy.action.status.{}", uuid::Uuid::new_v4()),
        canonical_digest(&ctx.operation.operation_id)?,
        &["actions", "authorization"],
        move |tx, admission, operation, _| {
            Box::pin(async move {
                let status = actions::status(tx, &operation.receipt.accepted.operation_id).await?;
                let (_, execution, _) =
                    actions::read_operation_intent(tx, &status.operation_id).await?;
                let (proposal, _) = actions::read_proposal(tx, &execution.proposal_id).await?;
                let impact =
                    actions::status_impact(tx, admission.impact().clone(), &proposal, &status)
                        .await?;
                actions::check_status_output(tx, &admission, &impact, &status, &tx.now().await?)
                    .await?;
                if operation.receipt.phase == OperationPhase::CommitIndeterminate
                    || status.phase == ActionPhase::CommitIndeterminate
                {
                    return Err(operation
                        .receipt
                        .failure
                        .clone()
                        .map(Error::from)
                        .or_else(|| {
                            status
                                .failure
                                .as_ref()
                                .map(|failure| Error::from(actions::operation_failure(failure)))
                        })
                        .unwrap_or_else(|| {
                            Error::internal(world_protocol::failure::FailureStage::Recover)
                        }));
                }
                if (owner::terminal_phase(operation.receipt.phase)
                    && operation.receipt.phase != OperationPhase::Completed)
                    || matches!(
                        status.phase,
                        ActionPhase::Rejected
                            | ActionPhase::CancelledBeforeEffect
                            | ActionPhase::CancelledAfterEffect
                    )
                {
                    return Err(status
                        .failure
                        .as_ref()
                        .map(|failure| Error::from(actions::operation_failure(failure)))
                        .or_else(|| operation.receipt.failure.clone().map(Error::from))
                        .unwrap_or_else(|| {
                            Error::internal(world_protocol::failure::FailureStage::Recover)
                        }));
                }
                Ok(StrategyAction::Effect { proposal, status })
            })
        },
    )
    .await
    .map(|committed| committed.value)
}

fn budget_error(error: crate::extensions::invocation::BudgetFailure) -> Error {
    Error::from_host_failure(
        world_protocol::process::HostFailure::BudgetExceeded {
            dimension: error.dimension,
        },
        world_protocol::failure::FailureStage::Prepare,
    )
}
