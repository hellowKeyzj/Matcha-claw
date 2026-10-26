use super::{ResolutionContext, changed, decode, encode};
use crate::{
    abstraction::{self, Resolution},
    authorization,
    extensions::{bindings, invocation::InvocationLease},
    owner::{Error, ExecutionContext},
    query::{self, SourceBrokers},
    sources::connectors::SourceBroker,
    store::StoreFuture,
};
use std::sync::{Arc, Mutex};
use world_protocol::{
    api::ResolveTaskRequest,
    failure::FailureStage,
    ids::*,
    query::{QueryFailure, QueryPage},
};

/// Minted only after the owner's real query receipt has committed. Never native self-report.
pub(crate) struct ObservedResolution {
    page: QueryPage,
    strategy: Option<abstraction::strategy::StrategyExecution>,
}
impl ObservedResolution {
    pub(crate) fn page(&self) -> &QueryPage {
        &self.page
    }
    pub(crate) fn strategy(&self) -> Option<&abstraction::strategy::StrategyExecution> {
        self.strategy.as_ref()
    }
}

pub(super) fn resolve<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    step_id: &'a StepId,
) -> StoreFuture<'a, ResolutionContext, Error> {
    Box::pin(async move {
        let handoff = Arc::new(Mutex::new(None));
        let produced = handoff.clone();
        let saved = request.clone();
        let content = ctx.resources.content.clone();
        let id = step_id.clone();
        let revision = super::execution::read_step_current(ctx, step_id)
            .await?
            .revision;
        let prepare_key = format!("resolution.prepare.{}", revision.0);
        ctx.transact(
            &prepare_key,
            crate::definitions::canonical_digest(request)?,
            &["learning", "authorization"],
            move |tx, admission, _, run| {
                Box::pin(async move {
                    let step = crate::owner::read_step(tx, &run.id, &id)
                        .await?
                        .ok_or_else(changed)?;
                    let state = decode(&step)?;
                    if step.revision != revision || state.context.is_some() {
                        return Err(changed());
                    }
                    let plan = abstraction::prepare(
                        tx,
                        &content,
                        &admission,
                        &saved.abstraction_id,
                        saved.abstraction_revision,
                        &saved.query,
                    )
                    .await?;
                    super::save(tx, &step, &state).await?;
                    *produced.lock().expect("resolution handoff poisoned") = Some(plan);
                    Ok(())
                })
            },
        )
        .await?;
        let plan = handoff
            .lock()
            .expect("resolution handoff poisoned")
            .take()
            .ok_or_else(changed)?;
        let scope = super::execution::read_current(ctx, step_id)
            .await?
            .task
            .scope;
        let (brokers, leases) = brokers(ctx, request, &scope).await?;
        let prepared = abstraction::execute(
            &ctx.store,
            &ctx.resources.content,
            Some(&brokers),
            &ctx.admission,
            plan,
            &ctx.pipeline,
            &ctx.budget,
            &ctx.cancellation,
            ctx.deadline,
        )
        .await;
        for lease in leases {
            lease.finish();
        }
        let prepared = prepared?;
        let id = step_id.clone();
        let content = ctx.resources.content.clone();
        let current = ctx.clone();
        let saved = request.clone();
        let input = Box::new((prepared, content, current, saved, id));
        Ok(ctx
            .transact(
                "resolution.context",
                crate::definitions::canonical_digest(request)?,
                &["learning", "query", "content", "authorization"],
                move |tx, admission, _, run| {
                    Box::pin(async move {
                        let (prepared, content, current, saved, id) = *input;
                        let resolution =
                            abstraction::commit(tx, &content, &admission, prepared).await?;
                        let mut context = match &resolution {
                            Resolution::Applicable {
                                contract, concrete, ..
                            } => ResolutionContext {
                                contract: Some(contract.clone()),
                                page: Some(concrete.clone()),
                                view: None,
                                reason: None,
                                investigate: false,
                                strategy: None,
                                invocation: None,
                            },
                            Resolution::Expanded {
                                contract,
                                concrete,
                                reason,
                                ..
                            } => ResolutionContext {
                                contract: Some(contract.clone()),
                                page: Some(concrete.clone()),
                                view: None,
                                reason: Some(*reason),
                                investigate: false,
                                strategy: None,
                                invocation: None,
                            },
                            Resolution::EvidenceRequired {
                                contract,
                                concrete,
                                reason,
                                ..
                            } => ResolutionContext {
                                contract: Some(contract.clone()),
                                page: Some(concrete.clone()),
                                view: None,
                                reason: Some(*reason),
                                investigate: true,
                                strategy: None,
                                invocation: None,
                            },
                            Resolution::Stopped { reason } => ResolutionContext {
                                contract: None,
                                page: None,
                                view: None,
                                reason: Some(*reason),
                                investigate: false,
                                strategy: None,
                                invocation: None,
                            },
                        };
                        if matches!(
                            resolution,
                            Resolution::Applicable { .. } | Resolution::Expanded { .. }
                        ) {
                            context.strategy = Some(
                                abstraction::prepare_online_strategy(
                                    tx, &current, &admission, &run, &saved, resolution,
                                )
                                .await?,
                            );
                        }
                        let step = crate::owner::read_step(tx, &run.id, &id)
                            .await?
                            .ok_or_else(changed)?;
                        let mut state = decode(&step)?;
                        if state.context.is_some() || context.page.as_ref().is_some_and(|page| {
                            page.receipt.release_id != state.binding.release_id
                                || page.receipt.activation_lock_id != state.binding.activation_lock_id
                        }) {
                            return Err(changed());
                        }
                        state.context = Some(context.clone());
                        super::save(tx, &step, &state).await?;
                        Ok(context)
                    })
                },
            )
            .await?
            .value)
    })
}

pub(super) fn execute_strategy<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    step_id: &'a StepId,
) -> StoreFuture<'a, abstraction::strategy::StrategyExecution, Error> {
    Box::pin(async move {
        let state = super::execution::read_current(ctx, step_id).await?;
        let (brokers, leases) = brokers(ctx, request, &state.task.scope).await?;
        let executed = abstraction::execute_online(ctx, request, None, &brokers, None).await;
        for lease in leases {
            lease.finish();
        }
        let executed = executed?;
        if ctx.cancellation.is_cancelled() {
            return Ok(executed);
        }
        let id = step_id.clone();
        let execution = executed.clone();
        ctx.transact(
            &format!(
                "resolution.strategy.{}",
                crate::definitions::canonical_digest(&execution)?.as_str()
            ),
            crate::definitions::canonical_digest(&execution)?,
            &["learning", "authorization"],
            move |tx, _, _, run| {
                Box::pin(async move {
                    let step = crate::owner::read_step(tx, &run.id, &id)
                        .await?
                        .ok_or_else(changed)?;
                    let mut state = decode(&step)?;
                    state.context.as_mut().ok_or_else(changed)?.strategy = Some(execution);
                    super::save(tx, &step, &state).await?;
                    Ok(())
                })
            },
        )
        .await?;
        Ok(executed)
    })
}

pub(super) fn observe<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    step_id: &'a StepId,
) -> StoreFuture<'a, ObservedResolution, Error> {
    Box::pin(async move {
        let original = super::execution::read_step_current(ctx, step_id).await?;
        let state = decode(&original)?;
        let page = if let Some(page) = state.observed {
            if original.phase == world_protocol::operation::OperationPhase::Verifying {
                page
            } else {
                let id = step_id.clone();
                let revision = original.revision;
                let digest = crate::definitions::canonical_digest(&page)?;
                ctx.transact(
                    &format!("resolution.verify.{}", revision.0),
                    digest.clone(),
                    &["learning", "authorization"],
                    move |tx, _, operation, run| {
                        Box::pin(async move {
                            let step = crate::owner::read_step(tx, &run.id, &id)
                                .await?
                                .ok_or_else(changed)?;
                            let state = decode(&step)?;
                            if step.revision != revision
                                || crate::owner::terminal_phase(step.phase)
                                || state.observed_digest.as_ref() != Some(&digest)
                                || state
                                    .observed
                                    .as_ref()
                                    .map(crate::definitions::canonical_digest)
                                    .transpose()?
                                    .as_ref()
                                    != Some(&digest)
                            {
                                return Err(changed());
                            }
                            let mut next = step.clone();
                            next.phase = world_protocol::operation::OperationPhase::Verifying;
                            crate::owner::checkpoint_step(tx, &step, next).await?;
                            crate::owner::update_operation(
                                tx,
                                &operation.receipt.accepted,
                                crate::owner::OperationUpdate {
                                    phase: world_protocol::operation::OperationPhase::Verifying,
                                    progress: operation.receipt.progress.clone(),
                                    failure: None,
                                    effects: Vec::new(),
                                },
                                &tx.now().await?,
                            )
                            .await?;
                            Ok(page)
                        })
                    },
                )
                .await?
                .value
            }
        } else {
            let (brokers, leases) = brokers(ctx, request, &state.task.scope).await?;
            let prepared = query::execute(
                &ctx.store,
                &ctx.resources.content,
                Some(&brokers),
                &ctx.admission,
                &request.query,
                &state.task.scope,
                &ctx.pipeline,
                &ctx.budget,
                &ctx.cancellation,
                ctx.deadline,
            )
            .await;
            for lease in leases {
                lease.finish();
            }
            let prepared = prepared?;
            let id = step_id.clone();
            ctx.transact(
                "resolution.observed",
                crate::definitions::canonical_digest(request)?,
                &["learning", "query", "authorization"],
                move |tx, admission, operation, run| {
                    Box::pin(async move {
                        let page = query::commit_read(tx, &admission, prepared).await?;
                        let step = crate::owner::read_step(tx, &run.id, &id)
                            .await?
                            .ok_or_else(changed)?;
                        let mut state = decode(&step)?;
                        if page.receipt.release_id != state.binding.release_id
                            || page.receipt.activation_lock_id != state.binding.activation_lock_id
                        {
                            return Err(changed());
                        }
                        state.observed_digest = Some(crate::definitions::canonical_digest(&page)?);
                        state.observed = Some(page.clone());
                        let mut next = step.clone();
                        next.phase = world_protocol::operation::OperationPhase::Verifying;
                        next.checkpoint = encode(&state)?;
                        crate::owner::checkpoint_step(tx, &step, next).await?;
                        crate::owner::update_operation(
                            tx,
                            &operation.receipt.accepted,
                            crate::owner::OperationUpdate {
                                phase: world_protocol::operation::OperationPhase::Verifying,
                                progress: operation.receipt.progress.clone(),
                                failure: None,
                                effects: Vec::new(),
                            },
                            &tx.now().await?,
                        )
                        .await?;
                        Ok(page)
                    })
                },
            )
            .await?
            .value
        };
        query::recheck_page(
            &ctx.store,
            &ctx.resources.content,
            &ctx.admission,
            &request.query,
            &state.task.scope,
            &page,
            &ctx.budget,
            &ctx.cancellation,
        )
        .await?;
        Ok(ObservedResolution {
            page,
            strategy: state
                .context
                .as_ref()
                .and_then(|context| context.strategy.clone()),
        })
    })
}

async fn brokers(
    ctx: &ExecutionContext,
    request: &ResolveTaskRequest,
    scope: &ScopeId,
) -> Result<(SourceBrokers, Vec<Arc<InvocationLease>>), Error> {
    let mode = request.query.read_mode.clone();
    let request = request.query.clone();
    let scope = scope.clone();
    let admission = ctx.admission.clone();
    let (release, graph, providers, now) = ctx
        .store
        .snapshot(ctx.operation.world.clone(), move |snapshot| {
            Box::pin(async move {
                let now = snapshot.now().await?;
                authorization::recheck_read(snapshot, &admission, &now).await?;
                admission.require_access(&query::impact(snapshot, &request, &scope).await?)?;
                let release = query::read_release(snapshot, &request).await?;
                let graph =
                    bindings::read_graph(snapshot, &release.artifact.activation_lock_id).await?;
                let providers = query::source_connectors(
                    snapshot,
                    &request,
                    &release,
                    world_protocol::api::MAX_PAGE_ITEMS as u64,
                )
                .await?;
                Ok::<_, Error>((release, graph, providers, now))
            })
        })
        .await?;
    let mut brokers = SourceBrokers::new();
    let mut leases: Vec<Arc<InvocationLease>> = Vec::new();
    for provider in providers {
        let nodes: Vec<_> = graph
            .lock()
            .nodes
            .iter()
            .filter(|node| {
                node.provider_id == provider
                    && node
                        .implementation
                        .contracts
                        .iter()
                        .any(|contract| contract.id.as_str() == "source.read")
            })
            .collect();
        if nodes.len() != 1 {
            for lease in leases {
                InvocationLease::finish(&lease);
            }
            return Err(query::QueryError::from(QueryFailure::GuaranteeUnsatisfied {
                mode: mode.clone(),
                source_id: None,
            })
            .into());
        }
        let node = &nodes[0].id;
        let lease = match ctx.resources.live.acquire(
            &ctx.operation.world,
            &release.artifact.activation_lock_id,
            node,
            ctx.admission.invocation().id.clone(),
            now.clone(),
        ) {
            Ok(lease) => Arc::new(lease),
            Err(cause) => {
                for lease in leases {
                    lease.finish();
                }
                return Err(Error::from_host_failure(
                    cause.host_failure(),
                    FailureStage::Prepare,
                )
                .caused(std::io::Error::other(format!("{cause:?}"))));
            }
        };
        let broker = match SourceBroker::for_provider(
            Arc::new(ctx.store.clone()),
            ctx.source_access.clone(),
            lease.clone(),
            node.clone(),
            ctx.invocation_service_seed(),
        ) {
            Ok(broker) => broker,
            Err(cause) => {
                lease.finish();
                for lease in leases {
                    lease.finish();
                }
                return Err(query::QueryError::from(cause).into());
            }
        };
        leases.push(lease);
        brokers.insert(provider, Arc::new(broker));
    }
    Ok((brokers, leases))
}
