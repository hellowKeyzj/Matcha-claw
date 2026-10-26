use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use crate::{
    actions,
    authorization::{self, VerifiedInvocation},
    definitions::canonical_digest,
    extensions::{
        bindings,
        invocation::{CallBudget, InvocationLease, LeaseFailure},
    },
    owner::{self, Error, ExecutionContext, StepRecord},
    query,
    sources::connectors::{SourceBroker, effects::Observation},
    store::{CommitRequest, StoreFuture, WorldTransaction},
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    actions::{ActionFailure, ActionProposal, EffectIntent},
    api::{ApiFailure, CommandResult, QueryResult, WorldCommand, WorldQuery},
    authorization::{AccessMode, ActualImpact},
    failure::{FailureStage, FieldPath, InputFailure, Recovery},
    ids::*,
    operation::{OperationPhase, OperationResult},
    query::{Page, QueryFailure},
    time::Timestamp,
};

pub(crate) use actions::{
    approval, impact, operation_retention_roots, policies, run_basis, run_branch,
};
pub(super) mod slots;
mod strategy;
mod submit;
mod verification;
use submit::submit;
use verification::verify;
pub(crate) use strategy::{StrategyAction, execute_strategy_action};

pub(crate) fn step_retention_roots(step: &StepRecord, roots: &mut crate::store::RetentionRoots) -> Result<(), Error> {
    slots::retention(step, roots)?;
    actions::step_retention_roots(step, roots)
}

/// Physical outcomes remain in custody until the original commit identity is resolved.
#[derive(Default)]
pub(crate) struct ActionWorkflows {
    pending: Mutex<BTreeMap<SourceReceiptId, Arc<Pending>>>,
}
impl ActionWorkflows {
    pub(crate) fn has_any_pending(&self) -> bool {
        !self
            .pending
            .lock()
            .expect("action custody poisoned")
            .is_empty()
    }
}
struct Pending {
    commit_id: CommitId,
    request: tokio::sync::Mutex<Option<CommitRequest>>,
    intent: EffectIntent,
    observation: Arc<Observation>,
}

pub(crate) fn run(
    ctx: ExecutionContext,
    command: WorldCommand,
) -> StoreFuture<'static, CommandResult, Error> {
    match command {
        WorldCommand::ActionPropose(request) => Box::pin(async move {
            let input = canonical_digest(&request)?;
            let budget = ctx.budget.clone();
            let cancel = ctx.cancellation.clone();
            let committed = ctx
                .transact(
                    "action.propose",
                    input.clone(),
                    &["actions", "query", "facts", "authorization"],
                    move |tx, admission, operation, run| {
                        Box::pin(async move {
                            let step = claim(tx, &admission, &run, "action.propose", input).await?;
                            let proposal =
                                actions::propose(tx, &admission, &run, request, &budget, &cancel)
                                    .await?;
                            authorization::check_admitted_output(
                                tx,
                                &admission,
                                &proposal.impact,
                                1,
                                &tx.now().await?,
                            )
                            .await?;
                            finish_step(tx, step, &proposal).await?;
                            owner::complete_operation(
                                tx,
                                &operation.receipt.accepted,
                                OperationResult::Proposal(proposal.clone()),
                                &tx.now().await?,
                            )
                            .await?;
                            Ok(proposal)
                        })
                    },
                )
                .await?;
            Ok(CommandResult::Proposal(committed.value))
        }),
        WorldCommand::ActionApprove(request) => Box::pin(async move {
            let input = canonical_digest(&request)?;
            let committed = ctx
                .transact(
                    "action.approve",
                    input.clone(),
                    &["actions", "authorization"],
                    move |tx, admission, operation, run| {
                        Box::pin(async move {
                            let step = claim(tx, &admission, &run, "action.approve", input).await?;
                            let approval = actions::approve(
                                tx,
                                &admission,
                                &operation.receipt.accepted.operation_id,
                                &request,
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
                            finish_step(tx, step, &approval).await?;
                            owner::complete_operation(
                                tx,
                                &operation.receipt.accepted,
                                OperationResult::Approval(approval.clone()),
                                &tx.now().await?,
                            )
                            .await?;
                            Ok(approval)
                        })
                    },
                )
                .await?;
            Ok(CommandResult::Approval(committed.value))
        }),
        WorldCommand::ActionSubmit(request) => submit(ctx, request),
        WorldCommand::ActionReconcile(key) => reconcile(ctx, key),
        WorldCommand::ActionCompensate(key) => compensate(ctx, key),
        _ => Box::pin(async { Err(invalid("command")) }),
    }
}

fn reconcile(
    ctx: ExecutionContext,
    key: world_protocol::operation::OperationKey,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let ctx = &ctx;
        if key.world != ctx.operation.world {
            return Err(invalid("world"));
        }
        let intent = ctx
            .transact(
                "action.reconcile.load",
                canonical_digest(&key)?,
                &["actions"],
                move |tx, admission, _, _| {
                    Box::pin(async move {
                        admission.require_access(
                            &actions::current_impact(tx, &WorldCommand::ActionReconcile(key.clone()))
                                .await?,
                        )?;
                        Ok(actions::read_operation_intent(tx, &key.operation_id)
                            .await?
                            .0)
                    })
                },
            )
            .await?
            .value;
        resume_observation(ctx, &intent.id).await?;
        recover_effect(ctx, &intent).await?;
        complete_recovery(ctx, &intent).await?;
        Ok(CommandResult::Accepted(ctx.operation.clone()))
    })
}

fn recover_effect<'a>(ctx: &'a ExecutionContext, intent: &'a EffectIntent) -> StoreFuture<'a, (), Error> {
    Box::pin(async move {
        let intent_copy = intent.clone();
        let phase = ctx
            .transact(
                &format!("action.recovery.phase.{}", uuid::Uuid::new_v4()),
                canonical_digest(&intent.id)?,
                &["actions"],
                move |tx, _, _, _| {
                    Box::pin(async move { Ok(actions::read_intent(tx, &intent_copy.id).await?.2) })
                },
            )
            .await?
            .value;
        if matches!(
            phase.as_str(),
            "completed" | "rejected" | "cancelled_before_effect" | "cancelled_after_effect"
        ) {
            return Ok(());
        }
        if phase == "prepared" {
            // Recovery cannot mint another send; absence of committed consumption is settled atomically.
            let saved = intent.clone();
            let failure = action_failure(ActionFailure::CancelledBeforeEffect, FailureStage::Recover)
                .safe_failure()
                .clone();
            ctx.transact(
                "action.recovery.not_sent",
                canonical_digest(&intent.id)?,
                &["actions"],
                move |tx, _, _, _| {
                    Box::pin(async move { actions::reject_unconsumed(tx, &saved, &failure).await })
                },
            )
            .await?;
            return Ok(());
        }
        let (broker, lease) = broker(ctx, intent, true).await?;
        let result = recover_with_broker(ctx, intent, &broker).await;
        lease.finish();
        result?;
        verify(ctx, intent).await
    })
}

async fn recover_with_broker(
    ctx: &ExecutionContext,
    intent: &EffectIntent,
    broker: &SourceBroker,
) -> Result<(), Error> {
    let source = broker
        .restore_effect(intent, &ctx.admission)
        .await
        .map_err(actions::source_error)?;
    let observation = broker
        .inspect_effect(
            source,
            &ctx.admission,
            &ctx.pipeline,
            ctx.cancellation.clone(),
            ctx.deadline,
            ctx.budget.clone(),
        )
        .await
        .map_err(actions::source_error)?;
    record_observation(ctx, intent, observation).await
}

async fn broker(
    ctx: &ExecutionContext,
    intent: &EffectIntent,
    inspect: bool,
) -> Result<(Arc<SourceBroker>, Arc<InvocationLease>), Error> {
    let access = ctx.source_access.clone();
    let binding = intent.source_operation.binding.clone();
    let lock = intent.activation_lock_id.clone();
    let lock_copy = lock.clone();
    let required = if inspect {
        world_protocol::sources::inspect_contract()
    } else {
        world_protocol::sources::write_contract()
    }
    .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
    let (provider, now) = ctx
        .transact(
            &format!("action.provider.{}", uuid::Uuid::new_v4()),
            canonical_digest(&(&binding, &lock))?,
            &["actions"],
            move |tx, _, _, _| {
                Box::pin(async move {
                    let binding = crate::sources::mapping::read_binding(tx, &binding)
                        .await
                        .map_err(crate::facts::assertions::Error::from)?
                        .ok_or_else(|| invalid("binding"))?;
                    let graph = bindings::read_graph_in_transaction(tx, &lock_copy).await?;
                    let nodes: Vec<_> = graph
                        .lock()
                        .nodes
                        .iter()
                        .filter(|node| {
                            node.provider_id == binding.body.connector
                                && node.slot == world_protocol::bindings::SlotKind::Connector
                                && node.implementation.contracts.contains(&required)
                        })
                        .collect();
                    if nodes.len() != 1 {
                        return Err(invalid("binding.connector"));
                    }
                    Ok((nodes[0].id.clone(), tx.now().await?))
                })
            },
        )
        .await?
        .value;
    let lease = Arc::new(
        ctx.resources
            .live
            .acquire(
                &ctx.operation.world,
                &lock,
                &provider,
                ctx.admission.invocation().id.clone(),
                now,
            )
            .map_err(lease_error)?,
    );
    match SourceBroker::for_provider(
        Arc::new(ctx.store.clone()),
        access,
        lease.clone(),
        provider,
        ctx.invocation_service_seed(),
    ) {
        Ok(broker) => Ok((Arc::new(broker), lease)),
        Err(error) => {
            lease.finish();
            Err(actions::source_error(error))
        }
    }
}

async fn record_observation(
    ctx: &ExecutionContext,
    intent: &EffectIntent,
    observation: Observation,
) -> Result<(), Error> {
    let receipt_id = observation.receipt().id.clone();
    let commit_id = ctx.commit_id(&format!("action.source.{receipt_id}"))?;
    let pending = Arc::new(Pending {
        commit_id,
        request: tokio::sync::Mutex::new(None),
        intent: intent.clone(),
        observation: Arc::new(observation),
    });
    let pending = ctx
        .resources
        .actions
        .pending
        .lock()
        .expect("action custody poisoned")
        .entry(receipt_id)
        .or_insert(pending)
        .clone();
    settle_observation(ctx, pending).await
}
async fn resume_observation(ctx: &ExecutionContext, intent: &EffectIntentId) -> Result<(), Error> {
    let pending: Vec<_> = ctx
        .resources
        .actions
        .pending
        .lock()
        .expect("action custody poisoned")
        .values()
        .filter(|pending| &pending.intent.id == intent)
        .cloned()
        .collect();
    for pending in pending {
        settle_observation(ctx, pending).await?;
    }
    Ok(())
}
async fn settle_observation(ctx: &ExecutionContext, pending: Arc<Pending>) -> Result<(), Error> {
    let mut saved_request = pending.request.lock().await;
    if saved_request.is_none() {
        let receipt = pending.observation.receipt();
        let mut request = ctx
            .commit_request(
                &format!("action.source.{}", receipt.id),
                canonical_digest(receipt)?,
                &["actions", "authorization"],
            )
            .await?;
        request.commit_id = pending.commit_id.clone();
        *saved_request = Some(request);
    }
    let batch = saved_request
        .as_ref()
        .expect("retained commit request")
        .clone()
        .prepare()?;
    let retained = pending.clone();
    // Custody only: exact consumed intent/actor/step and opaque source witness, no I/O or disclosure.
    ctx.store
        .transact(batch, move |tx| {
            Box::pin(async move {
                actions::record_source(tx, &retained.intent, &retained.observation).await
            })
        })
        .await
        .map_err(Error::from)?;
    let receipt_id = &pending.observation.receipt().id;
    let mut custody = ctx
        .resources
        .actions
        .pending
        .lock()
        .expect("action custody poisoned");
    if custody
        .get(receipt_id)
        .is_some_and(|current| Arc::ptr_eq(current, &pending))
    {
        custody.remove(receipt_id);
    }
    match pending.observation.failure().cloned() {
        Some(error) => Err(actions::source_error(error)),
        None => Ok(()),
    }
}

async fn complete_recovery(ctx: &ExecutionContext, intent: &EffectIntent) -> Result<(), Error> {
    if ctx.operation.operation_id == intent.operation_id {
        return Ok(());
    }
    let original = intent.operation_id.clone();
    ctx.transact(
        "action.recovery.complete",
        canonical_digest(&intent.id)?,
        &["actions"],
        move |tx, admission, operation, run| {
            Box::pin(async move {
                let status = actions::status(tx, &original).await?;
                let step = claim(
                    tx,
                    &admission,
                    &run,
                    "action.reconcile",
                    canonical_digest(&original)?,
                )
                .await?;
                finish_step(tx, step, &status).await?;
                let (_, execution, _) = actions::read_operation_intent(tx, &original).await?;
                let (proposal, _) = actions::read_proposal(tx, &execution.proposal_id).await?;
                let impact =
                    actions::status_impact(tx, admission.impact().clone(), &proposal, &status)
                        .await?;
                actions::check_status_output(tx, &admission, &impact, &status, &tx.now().await?)
                    .await?;
                owner::complete_operation(
                    tx,
                    &operation.receipt.accepted,
                    OperationResult::Action(Box::new(status)),
                    &tx.now().await?,
                )
                .await?;
                Ok(())
            })
        },
    )
    .await?;
    Ok(())
}

fn compensate(
    ctx: ExecutionContext,
    key: world_protocol::operation::OperationKey,
) -> StoreFuture<'static, CommandResult, Error> {
    Box::pin(async move {
        let input = canonical_digest(&key)?;
        let budget = ctx.budget.clone();
        let cancel = ctx.cancellation.clone();
        ctx.transact(
            "action.compensate",
            input.clone(),
            &["actions", "facts", "query", "authorization"],
            move |tx, admission, operation, run| {
                Box::pin(async move {
                    let (intent, execution, _) =
                        actions::read_operation_intent(tx, &key.operation_id).await?;
                    let witness = query::evaluate_compensation(
                        tx,
                        &admission,
                        &intent.action,
                        &execution.context.release_id,
                        None,
                        &intent.argument_values,
                        &execution.context.scope,
                        &budget,
                        &cancel,
                        &tx.now().await?,
                    )
                    .await?;
                    for (index, value) in witness.preconditions().iter().enumerate() {
                        match value {
                            world_protocol::expression::TruthValue::True => {}
                            world_protocol::expression::TruthValue::False => {
                                return Err(action_failure(
                                    ActionFailure::PreconditionFalse {
                                        index: index as u32,
                                    },
                                    FailureStage::Admission,
                                ));
                            }
                            value => {
                                return Err(action_failure(
                                    ActionFailure::PreconditionUnknown {
                                        index: index as u32,
                                        value: *value,
                                    },
                                    FailureStage::Admission,
                                ));
                            }
                        }
                    }
                    let request = world_protocol::actions::ActionProposalRequest {
                        world: tx.world().clone(),
                        branch_id: None,
                        action: witness.action().clone(),
                        arguments: witness.arguments().to_vec(),
                        targets: witness.targets().to_vec(),
                        basis: Vec::new(),
                    };
                    let impact = actions::compensation_impact(
                        tx,
                        actions::current_impact(tx, &WorldCommand::ActionPropose(request.clone()))
                            .await?,
                        &intent,
                    )
                    .await?;
                    let policies =
                        actions::policies(tx, &WorldCommand::ActionPropose(request.clone())).await?;
                    let current = authorization::admit(
                        tx,
                        admission.verified(),
                        &impact,
                        &policies,
                        None,
                        &tx.now().await?,
                    )
                    .await?;
                    let step = claim(tx, &current, &run, "action.compensate", input).await?;
                    let proposal = actions::propose_compensation(
                        tx, &current, &run, &intent, &witness, &budget, &cancel,
                    )
                    .await?;
                    finish_step(tx, step, &proposal).await?;
                    authorization::check_admitted_output(
                        tx,
                        &current,
                        &proposal.impact,
                        1,
                        &tx.now().await?,
                    )
                    .await?;
                    owner::complete_operation(
                        tx,
                        &operation.receipt.accepted,
                        OperationResult::Proposal(proposal),
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

fn reject_prepared<'a>(
    ctx: &'a ExecutionContext,
    intent: &'a EffectIntent,
    error: Error,
) -> futures_util::future::BoxFuture<'a, Error> {
    Box::pin(async move {
        let saved = intent.clone();
        let failure = error.safe_failure().clone();
        let result = ctx
            .transact(
                "action.prepare.reject",
                canonical_digest(&(intent.id.clone(), &failure.details))
                    .unwrap_or_else(|_| intent.proposal_digest.clone()),
                &["actions"],
                move |tx, _, _, _| {
                    Box::pin(async move { actions::reject_unconsumed(tx, &saved, &failure).await })
                },
            )
            .await;
        match result {
            Ok(_) => error,
            Err(cleanup) => error.with_related(cleanup),
        }
    })
}

pub(crate) async fn query_impact(
    tx: &WorldTransaction<'_>,
    request: &WorldQuery,
) -> Result<ActualImpact, Error> {
    match request {
        WorldQuery::ActionProposals(_) => crate::releases::directory_impact(tx).await,
        WorldQuery::ActionStatus(key) => {
            let (intent, execution, _) =
                actions::read_operation_intent(tx, &key.operation_id).await?;
            let (proposal, _) = actions::read_proposal(tx, &execution.proposal_id).await?;
            let mut impact =
                actions::current_impact(tx, &WorldCommand::ActionReconcile(key.clone())).await?;
            for scope in &mut impact.access {
                scope.modes = vec![AccessMode::Read];
            }
            let status = actions::status(tx, &intent.operation_id).await?;
            actions::status_impact(tx, impact, &proposal, &status).await
        }
        _ => Err(invalid("query")),
    }
}

pub(crate) async fn query(
    tx: &WorldTransaction<'_>,
    verified: &VerifiedInvocation,
    request: &WorldQuery,
    now: &Timestamp,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<QueryResult, Error> {
    query_checkpoint(budget, cancel)?;
    let impact = query_impact(tx, request).await?;
    let admission = authorization::admit(tx, verified, &impact, &[], None, now).await?;
    match request {
        WorldQuery::ActionStatus(key) => {
            let status = actions::status(tx, &key.operation_id).await?;
            actions::check_status_output(tx, &admission, &impact, &status, &tx.now().await?)
                .await?;
            Ok(QueryResult::ActionStatus(status))
        }
        WorldQuery::ActionProposals(request) => {
            let page = &request.page;
            if page.limit == 0 || page.limit > world_protocol::api::MAX_PAGE_ITEMS {
                return Err(invalid("page"));
            }
            let mut after = page.cursor.clone().unwrap_or_default();
            if !after.is_empty() {
                CandidateId::try_new(after.clone()).map_err(|_| invalid("cursor"))?;
            }
            let mut items = Vec::new();
            let result = 'scan: loop {
                if tx.now().await? >= verified.invocation().deadline {
                    return Err(query::QueryError::from(QueryFailure::BudgetExceeded {
                        limit: world_protocol::query::TruncationReason::Deadline,
                    })
                    .into());
                }
                let rows = tx.query("SELECT proposal_id FROM world_action_proposal WHERE tenant_id=$1 AND world_id=$2 AND proposal_id>$3 ORDER BY proposal_id LIMIT 128", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
                let exhausted = rows.len() < 128;
                for row in rows {
                    query_checkpoint(budget, cancel)?;
                    budget
                        .charge(world_protocol::budget::BudgetDimension::Rows, 1)
                        .map_err(|reason| {
                            Error::from_host_failure(
                                world_protocol::process::HostFailure::BudgetExceeded {
                                    dimension: reason.dimension,
                                },
                                FailureStage::Read,
                            )
                        })?;
                    after = row.get("proposal_id");
                    let id =
                        CandidateId::try_new(after.clone()).map_err(|_| invalid("proposalId"))?;
                    let (proposal, _) = actions::read_proposal(tx, &id).await?;
                    let item_impact = actions::proposal_read_impact(tx, &proposal).await?;
                    let current = match authorization::admit(
                        tx,
                        verified,
                        &item_impact,
                        &[],
                        None,
                        &tx.now().await?,
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(authorization::AuthError::Denied(_)) => continue,
                        Err(error) => return Err(error.into()),
                    };
                    authorization::check_admitted_output(
                        tx,
                        &current,
                        &item_impact,
                        (items.len() + 1).min(page.limit as usize) as u64,
                        &tx.now().await?,
                    )
                    .await?;
                    if items.len() == page.limit as usize {
                        break 'scan Page {
                            next_cursor: items
                                .last()
                                .map(|item: &ActionProposal| item.id.to_string()),
                            items,
                        };
                    }
                    items.push(proposal);
                }
                if exhausted {
                    break Page {
                        items,
                        next_cursor: None,
                    };
                }
            };
            authorization::check_admitted_output(
                tx,
                &admission,
                &impact,
                result.items.len() as u64,
                &tx.now().await?,
            )
            .await?;
            Ok(QueryResult::ActionProposals(result))
        }
        _ => Err(invalid("query")),
    }
}

async fn claim(
    tx: &mut WorldTransaction<'_>,
    admission: &authorization::Admission,
    run: &owner::RunRecord,
    kind: &str,
    input: Digest,
) -> Result<StepRecord, Error> {
    let digest = canonical_digest(&(&run.id, kind))?;
    let id = StepId::try_new(format!("step-{}", &digest.as_str()[7..]))
        .map_err(|cause| Error::internal(FailureStage::Prepare).caused(cause))?;
    owner::claim_step(tx, admission, run, id, 0, kind, input, &tx.now().await?).await
}
async fn finish_step(
    tx: &mut WorldTransaction<'_>,
    step: StepRecord,
    result: &impl serde::Serialize,
) -> Result<(), Error> {
    let mut next = step.clone();
    next.phase = OperationPhase::Completed;
    next.result = Some(
        serde_json::to_value(result)
            .map_err(|cause| Error::internal(FailureStage::Commit).caused(cause))?,
    );
    owner::checkpoint_step(tx, &step, next).await?;
    Ok(())
}
fn query_checkpoint(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), Error> {
    if cancel.is_cancelled() {
        return Err(query::QueryError::from(QueryFailure::Cancelled).into());
    }
    budget
        .charge(world_protocol::budget::BudgetDimension::Steps, 1)
        .map_err(|reason| {
            Error::from_host_failure(
                world_protocol::process::HostFailure::BudgetExceeded {
                    dimension: reason.dimension,
                },
                FailureStage::Read,
            )
        })
}
fn invalid(field: &str) -> Error {
    Error::new(
        "world.action_input",
        FailureStage::Validate,
        "动作输入或保留依据无效。",
        ApiFailure::Input(InputFailure::InvalidValue {
            field: FieldPath(field.split('.').map(str::to_owned).collect()),
        }),
        Recovery::Refresh,
    )
}
fn action_failure(reason: ActionFailure, stage: FailureStage) -> Error {
    Error::new(
        "world.action_failed",
        stage,
        "动作尚未完成，请按原意图对账。",
        ApiFailure::Operation(world_protocol::operation::OperationFailure::Action(reason)),
        Recovery::Refresh,
    )
}
fn lease_error(error: LeaseFailure) -> Error {
    match error {
        LeaseFailure::Binding(reason) => bindings::BindingError::from(reason).into(),
        LeaseFailure::Gate(reason) => bindings::BindingError::Gate(reason).into(),
        reason => Error::new(
            "world.action_lease_failed",
            FailureStage::Prepare,
            "动作固定执行图当前不可用。",
            ApiFailure::Operation(world_protocol::operation::OperationFailure::Lifecycle(
                match reason {
                    LeaseFailure::MissingGeneration(node_id) => {
                        world_protocol::lifecycle::LifecycleFailure::DependencyMissing { node_id }
                    }
                    LeaseFailure::ConcurrentCallLimit(node_id) => {
                        world_protocol::lifecycle::LifecycleFailure::ConcurrentCallLimit { node_id }
                    }
                    _ => world_protocol::lifecycle::LifecycleFailure::AcquisitionClosed,
                },
            )),
            Recovery::Refresh,
        ),
    }
}
