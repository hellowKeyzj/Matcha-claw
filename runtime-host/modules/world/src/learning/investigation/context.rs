use std::{collections::BTreeSet, sync::Arc};

use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::ContextFailure,
    api::ResolveTaskRequest,
    authorization::{AccessMode, AccessScope},
    bindings::{ExactClosure, SlotKind},
    budget::BudgetDimension,
    failure::FailureStage,
    ids::*,
    process::{HostFailure, TerminalState},
    query::QueryPage,
    slots::{ContextRequest, ContextResult, SlotFailure, SlotRequest, SlotResponse},
};

use crate::{
    extensions::{
        bindings::{self, BindingError, BindingGraph},
        invocation::{
            CompositionFailure, CompositionOutcome, InvocationContext, InvocationFailure,
            invoke_composition_checked, merge_inspected_composition, replay_composition_checked,
            retained_composition_settled,
        },
        process::Delivery,
    },
    owner::{self, Error, ExecutionContext},
    store::{CommitRequest, RetentionRoots, StoreFuture},
};
use super::{changed, decode, encode};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ContextInvocation {
    request: ContextRequest,
    invocation_id: InvocationId,
    closure: ExactClosure,
    observation: Option<ContextObservation>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextObservation {
    commit: CommitRequest,
    retained: serde_json::Value,
    roots: RetentionRoots,
    settled: bool,
}

pub(crate) enum ContextExecution {
    Resolution(ResolutionExecution),
    WorldView(Arc<crate::owner::WorldViewContextExecution>),
}

impl ContextExecution {
    fn new(
        owner: ExecutionContext,
        step: StepId,
        invocation: InvocationContext,
        request: ContextRequest,
        page: QueryPage,
    ) -> Self {
        Self::Resolution(ResolutionExecution::new(owner, step, invocation, request, page))
    }

    pub(crate) fn new_world_view(execution: Arc<crate::owner::WorldViewContextExecution>) -> Self {
        Self::WorldView(execution)
    }

    pub(crate) async fn execute(
        &self,
        context: &InvocationContext,
        request: &ContextRequest,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<ContextResult, Error> {
        match self {
            Self::Resolution(execution) => execution.execute(context, request, cancel, deadline).await,
            Self::WorldView(execution) => execution.execute(context, request, cancel, deadline).await,
        }
    }
}

/// One committed resolution page, bound to its original managed composition.
pub(crate) struct ResolutionExecution {
    owner: ExecutionContext,
    step: StepId,
    invocation: InvocationContext,
    request: ContextRequest,
    page: QueryPage,
    result: tokio::sync::OnceCell<Result<ContextResult, Error>>,
}

impl ResolutionExecution {
    fn new(
        owner: ExecutionContext,
        step: StepId,
        invocation: InvocationContext,
        request: ContextRequest,
        page: QueryPage,
    ) -> Self {
        Self { owner, step, invocation, request, page, result: tokio::sync::OnceCell::new() }
    }

    pub(crate) async fn execute(
        &self,
        context: &InvocationContext,
        request: &ContextRequest,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<ContextResult, Error> {
        let graph = self.invocation.lease().graph();
        let root = graph.node(self.invocation.node()).map_err(BindingError::from)?;
        let member = graph.node(context.node()).map_err(BindingError::from)?;
        if request != &self.request
            || member.slot != SlotKind::Context
            || member.binding_id != root.binding_id
            || !Arc::ptr_eq(context.lease(), self.invocation.lease())
            || context.admission().invocation() != self.owner.admission.invocation()
            || context.admission().decision() != self.owner.admission.decision()
            || self.owner.run.activation_lock_id.as_ref() != Some(&graph.lock().id)
        {
            return Err(changed());
        }
        self.check(context, cancel, deadline).await?;
        let result = self.result.get_or_init(|| async {
            let id = self.step.clone();
            let request = self.request.clone();
            let page = self.page.clone();
            let budget = context.budget().clone();
            let cancellation = cancel.clone();
            let invocation = context.clone();
            Ok(self.owner.transact(
                "resolution.context.build",
                crate::definitions::canonical_digest(&(&request, &page))?,
                &["learning", "authorization"],
                move |tx, admission, _, run| Box::pin(async move {
                    current_in_transaction(tx, &admission, &invocation).await?;
                    let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                    let state = decode(&step)?;
                    let current = state.context.as_ref().ok_or_else(changed)?;
                    if state.task != request.task || current.page.as_ref() != Some(&page)
                        || state.binding.activation_lock_id != page.receipt.activation_lock_id
                        || state.binding.release_id != page.receipt.release_id
                    {
                        return Err(changed());
                    }
                    Ok(crate::context::from_page(
                        tx, &admission, &request, page, &budget, &cancellation,
                    ).await?)
                }),
            ).await?.value)
        }).await.clone()?;
        self.check(context, cancel, deadline).await?;
        let scoped = ContextRequest { budget: context.budget().limit(), ..request.clone() };
        crate::context::check_result(&scoped, &self.page, &result)?;
        Ok(result)
    }

    async fn check(
        &self,
        context: &InvocationContext,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), Error> {
        if cancel.is_cancelled() || self.owner.cancellation.is_cancelled() {
            return Err(crate::context::Error::from(ContextFailure::Cancelled).into());
        }
        if Instant::now() >= deadline.min(self.owner.deadline).min(context.budget().deadline()) {
            return Err(crate::context::Error::from(ContextFailure::BudgetExceeded).into());
        }
        context.check_current().await.map_err(|error| {
            Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error)
        })
    }
}

pub(super) fn node(graph: &BindingGraph) -> Result<NodeId, Error> {
    let bindings: BTreeSet<_> = graph.lock().nodes.iter()
        .filter(|node| node.slot == SlotKind::Context)
        .map(|node| node.binding_id.clone()).collect();
    if bindings.len() != 1 {
        return Err(changed());
    }
    graph.composition_order(bindings.iter().next().expect("one Context composition"))
        .map_err(BindingError::from)?.into_iter()
        .find(|node| graph.node(node).is_ok_and(|node| node.slot == SlotKind::Context))
        .ok_or_else(changed)
}

pub(super) fn access(graph: &BindingGraph, scope: &ScopeId) -> Result<AccessScope, Error> {
    let root = node(graph)?;
    let resources = graph.closure_nodes(&root).map_err(BindingError::from)?.iter()
        .map(|node| graph.node(node).map(|node| ResourceRef::Binding { id: node.binding_id.clone() }))
        .collect::<Result<BTreeSet<_>, _>>().map_err(BindingError::from)?;
    Ok(AccessScope { resources: resources.into_iter().collect(), fields: Vec::new(),
        modes: vec![AccessMode::Execute], scope: scope.clone(), valid_time: None })
}

pub(super) fn ready(context: &super::ResolutionContext) -> bool {
    context.page.is_none() || context.view.is_some()
        && context.invocation.as_ref().and_then(|invocation| invocation.observation.as_ref())
            .is_some_and(|observation| observation.settled)
}

pub(super) fn complete<'a>(
    ctx: &'a ExecutionContext,
    request: &'a ResolveTaskRequest,
    step_id: &'a StepId,
) -> StoreFuture<'a, bool, Error> {
    Box::pin(async move {
        let original = super::execution::read_step_current(ctx, step_id).await?;
        let state = decode(&original)?;
        let revision = original.revision;
        let context = state.context.as_ref().ok_or_else(changed)?;
        let Some(page) = &context.page else {
            if context.view.is_some() || context.invocation.is_some() { return Err(changed()); }
            return Ok(true);
        };
        let request = ContextRequest { world: state.task.world.clone(), task: state.task.clone(),
            query: request.query.clone(), budget: state.task.budget.clone() };
        let lock = state.binding.activation_lock_id.clone();
        let admission = ctx.admission.clone();
        let graph = ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
            crate::authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
            Ok::<_, Error>(bindings::read_graph(snapshot, &lock).await?)
        })).await?;
        let root = node(&graph)?;
        if context.view.is_some() && context.invocation.is_none() { return Err(changed()); }
        let selected = if let Some(invocation) = &context.invocation {
            if invocation.request != request || invocation.closure.root != root
                || invocation.closure.activation_lock_id != graph.lock().id {
                return Err(changed());
            }
            Some(invocation.clone())
        } else {
            if ctx.cancellation.is_cancelled() { return Ok(false); }
            let owner = ctx.clone();
            let id = step_id.clone();
            let page = page.clone();
            let request = request.clone();
            let owner = &owner;
            let returned = ctx.with_invocation(root.clone(), None, Vec::new(), move |invocation, services| {
                invoke_context(owner, id, request, page, revision, invocation, services)
            }).await.map_err(composition_error)??;
            match returned {
                Some((binding, outcome)) => Some(retain(ctx, step_id, &binding, outcome).await?),
                None => None,
            }
        };
        let Some(invocation) = selected else { return Ok(false); };
        let Some(invocation) = restore(ctx, step_id, &graph, page, &invocation).await? else {
            return Ok(false);
        };
        let observed = invocation.observation.as_ref().ok_or_else(changed)?;
        if !observed.settled { return Ok(false); }
        let retained: Result<SlotResponse, HostFailure> = serde_json::from_value(
            observed.retained.get("result").cloned().ok_or_else(changed)?,
        ).map_err(|error| changed().caused(error))?;
        if let Err(failure) = retained {
            return Err(Error::from_host_failure(failure, FailureStage::Execute));
        }
        let result = replay_composition_checked(&graph, &root, SlotRequest::Context(request.clone()),
            &observed.retained, |_, input| prepare(&request, input),
            |_, input, output| check(&request, page, input, output)).map_err(composition_error)?;
        let SlotResponse::Context(result) = result else { return Err(changed()); };
        if ctx.resources.live.invocation_unsettled(&ctx.operation.world, &invocation.invocation_id) {
            return Ok(false);
        }
        let id = step_id.clone();
        let expected = encode(&invocation)?;
        let page = page.clone();
        let cancel = ctx.cancellation.clone();
        let current = ctx.clone();
        let current = &current;
        ctx.with_invocation(root, None, Vec::new(), move |fresh, _| {
            ready_context(current, id, invocation, result, expected, page, cancel, request, fresh)
        }).await.map_err(composition_error)??;
        Ok(true)
    })
}

fn claim_context<'a>(
    owner: &'a ExecutionContext,
    id: StepId,
    page: QueryPage,
    saved: ContextInvocation,
    expected: Revision,
    binding: &'a ContextInvocation,
) -> StoreFuture<'a, bool, Error> {
    Box::pin(async move {
        let claimed = owner.transact("resolution.context.claim",
            crate::definitions::canonical_digest(binding)?, &["learning", "authorization"],
            move |tx, admission, _, run| Box::pin(async move {
                let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                let mut state = decode(&step)?;
                let context = state.context.as_mut().ok_or_else(changed)?;
                if step.revision != expected || context.invocation.is_some() || context.view.is_some()
                    || context.page.as_ref() != Some(&page) {
                    return Err(changed());
                }
                let graph = bindings::read_graph_history_in_transaction(tx, &saved.closure.activation_lock_id).await?;
                let impact = crate::authorization::actual_impact(vec![access(&graph, &saved.request.task.scope)?],
                    Vec::new(), Vec::new(), Vec::new(), Vec::new())?;
                admission.require_access(&impact)?;
                context.invocation = Some(saved.clone());
                super::save(tx, &step, &state).await?;
                Ok(saved)
            }),
        ).await?;
        Ok(claimed.replayed)
    })
}

fn invoke_context<'a>(
    owner: &'a ExecutionContext,
    id: StepId,
    request: ContextRequest,
    page: QueryPage,
    revision: Revision,
    invocation: InvocationContext,
    mut services: crate::extensions::invocation::InvocationServices,
) -> StoreFuture<'a, Result<Option<(ContextInvocation, Result<CompositionOutcome, CompositionFailure>)>, Error>, CompositionFailure> {
    Box::pin(async move {
        let step_id = id;
        let binding = ContextInvocation { request: request.clone(),
            invocation_id: invocation.admission().invocation().id.clone(),
            closure: invocation.lease().closure().clone(), observation: None };
        let expected = revision;
        let id = step_id.clone();
        let saved = binding.clone();
        match claim_context(owner, id, page, saved, expected, &binding).await {
            Ok(true) => return Ok(Ok(None)),
            Ok(false) => {},
            Err(error) => return Ok(Err(error)),
        }
        let page = match super::execution::read_current(owner, &step_id).await.and_then(|state| {
            state.context.ok_or_else(changed)?.page.ok_or_else(changed)
        }) {
            Ok(page) => page,
            Err(error) => return Ok(Err(error)),
        };
        services.context = Some(Arc::new(ContextExecution::new(owner.clone(), step_id.clone(),
            invocation.clone(), request.clone(), page.clone())));
        let checked = request.clone();
        let outcome = invoke_composition_checked(invocation, SlotRequest::Context(request.clone()), services,
            |_, input| prepare(&checked, input),
            |_, input, output| check(&checked, &page, input, output),
        ).await;
        Ok(Ok(Some((binding, outcome))))
    })
}

fn ready_context<'a>(
    current: &'a ExecutionContext,
    id: StepId,
    invocation: ContextInvocation,
    result: ContextResult,
    expected: serde_json::Value,
    page: QueryPage,
    cancel: CancellationToken,
    request: ContextRequest,
    fresh: InvocationContext,
) -> StoreFuture<'a, Result<(), Error>, CompositionFailure> {
    Box::pin(async move {
        let step = match super::execution::read_step_current(current, &id).await {
            Ok(step) => step,
            Err(error) => return Ok(Err(error)),
        };
        let revision = step.revision;
        let digest = match crate::definitions::canonical_digest(&(&invocation, &result)) {
            Ok(digest) => digest,
            Err(error) => return Ok(Err(error.into())),
        };
        let checked = current.transact(&format!("resolution.context.ready.{}.{}", revision.0,
            current.admission.invocation().id), digest,
            &["learning", "authorization"],
            move |tx, admission, _, run| Box::pin(async move {
                for node in &fresh.lease().closure().nodes {
                    let child = fresh.with_node(node.clone()).map_err(|error| {
                        Error::from_host_failure(error.host_failure(), FailureStage::Recover).caused(error)
                    })?;
                    current_in_transaction(tx, &admission, &child).await?;
                }
                let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                let mut state = decode(&step)?;
                let context = state.context.as_mut().ok_or_else(changed)?;
                if step.revision != revision || context.page.as_ref() != Some(&page)
                    || context.invocation.as_ref().map(encode).transpose()?.as_ref() != Some(&expected)
                    || context.view.as_ref().is_some_and(|view| view != &result.view) {
                    return Err(changed());
                }
                crate::context::recheck_result(tx, &admission, &request, &page, &result, &cancel).await?;
                if context.view.is_none() {
                    context.view = Some(result.view);
                    super::save(tx, &step, &state).await?;
                }
                Ok(())
            }),
        ).await;
        Ok(checked.map(|_| ()))
    })
}

fn prepare(request: &ContextRequest, input: SlotRequest) -> Result<SlotRequest, CompositionFailure> {
    if input != SlotRequest::Context(request.clone()) { return Err(invalid()); }
    Ok(input)
}

fn check(request: &ContextRequest, page: &QueryPage, input: &SlotRequest, output: &SlotResponse)
    -> Result<Option<SlotResponse>, CompositionFailure> {
    if input != &SlotRequest::Context(request.clone()) { return Err(invalid()); }
    let SlotResponse::Context(result) = output else { return Err(invalid()); };
    crate::context::check_result(request, page, result).map_err(|error| match error {
        crate::context::Error::Rejected(reason) => CompositionFailure::Slot(SlotFailure::Context(reason)),
        error => CompositionFailure::Invocation(InvocationFailure::Owner(Box::new(error.into()))),
    })?;
    Ok(None)
}

fn invalid() -> CompositionFailure {
    CompositionFailure::Slot(SlotFailure::Context(ContextFailure::BasisChanged))
}

fn composition_error(error: CompositionFailure) -> Error {
    Error::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error)
}

async fn current_in_transaction(
    tx: &crate::store::WorldTransaction<'_>,
    admission: &crate::authorization::Admission,
    invocation: &InvocationContext,
) -> Result<(), Error> {
    if admission.invocation() != invocation.admission().invocation() { return Err(changed()); }
    crate::extensions::invocation::check_current_in_transaction(
        tx, admission, invocation.lease(), invocation.node(),
    ).await.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))
}

fn retain<'a>(
    ctx: &'a ExecutionContext,
    step_id: &'a StepId,
    binding: &'a ContextInvocation,
    outcome: Result<CompositionOutcome, CompositionFailure>,
) -> StoreFuture<'a, ContextInvocation, Error> {
    Box::pin(async move {
        let (retained, roots, settled) = match &outcome {
            Ok(outcome) => (encode(&outcome.retained())?, outcome.retained_roots(&ctx.operation.world)?,
                !ctx.resources.live.invocation_unsettled(&ctx.operation.world, &binding.invocation_id)
                    && outcome.nodes.iter().all(|node| node.process.as_ref().is_none_or(|process| {
                        process.cleanup.is_none() && (process.delivery == Delivery::NotDispatched
                            || process.outcome.as_ref().is_some_and(|outcome| outcome.terminal != TerminalState::Retained))
                    }))),
            Err(error) => {
                let failure = error.host_failure();
                let mut roots = RetentionRoots::default();
                if let Some(error) = Error::from_host_failure(failure.clone(), FailureStage::Execute).operation_failure() {
                    owner::operation_failure_roots(&ctx.operation.world, &error.details, &mut roots)?;
                }
                (encode(&failure)?, roots,
                    !ctx.resources.live.invocation_unsettled(&ctx.operation.world, &binding.invocation_id))
            },
        };
        let maximum = usize::try_from(ctx.budget.remaining(BudgetDimension::Bytes).map_err(|error| {
            Error::from_host_failure(HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Execute)
        })?).unwrap_or(usize::MAX);
        let bytes = world_protocol::wire::encode(&(&retained, &roots), maximum)
            .map_err(|error| Error::internal(FailureStage::Execute).caused(error))?;
        ctx.budget.charge(BudgetDimension::Bytes, bytes.len() as u64).map_err(|error| {
            Error::from_host_failure(HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Execute)
        })?;
        save_observation(ctx, step_id, binding, retained, roots, settled).await
    })
}

async fn save_observation(
    ctx: &ExecutionContext,
    step_id: &StepId,
    binding: &ContextInvocation,
    retained: serde_json::Value,
    roots: RetentionRoots,
    settled: bool,
) -> Result<ContextInvocation, Error> {
    let step = super::execution::read_step_current(ctx, step_id).await?;
    let revision = step.revision;
    let key = format!("resolution.context.observed.{}", revision.0);
    let digest = crate::definitions::canonical_digest(&(binding, &retained, &roots, settled))?;
    let commit = ctx.commit_request(&key, digest.clone(), &["learning", "authorization"]).await?;
    let mut observed = binding.clone();
    observed.observation = Some(ContextObservation { commit: commit.clone(), retained, roots, settled });
    let saved = observed.clone();
    let expected = encode(binding)?;
    let id = step_id.clone();
    let usage = ctx.budget.checkpoint_usage();
    let committed = ctx.transact_outcome(commit, move |tx, _, _, run| Box::pin(async move {
        let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
        let mut state = decode(&step)?;
        let context = state.context.as_mut().ok_or_else(changed)?;
        if step.revision != revision
            || context.invocation.as_ref().map(encode).transpose()?.as_ref() != Some(&expected)
            || context.view.is_some() { return Err(changed()); }
        context.invocation = Some(saved.clone());
        super::save(tx, &step, &state).await?;
        owner::checkpoint_usage(tx, &run, owner::confirmed_usage(&run.usage, usage)?).await?;
        Ok(saved)
    })).await.map_err(Error::from)?;
    ctx.recheck_replay(&committed).await?;
    Ok(committed.value)
}

fn restore<'a>(
    ctx: &'a ExecutionContext,
    step_id: &'a StepId,
    graph: &'a BindingGraph,
    page: &'a QueryPage,
    invocation: &'a ContextInvocation,
) -> StoreFuture<'a, Option<ContextInvocation>, Error> {
    Box::pin(async move {
        let root = graph.node(&invocation.closure.root).map_err(BindingError::from)?;
        let order = graph.composition_order(&root.binding_id).map_err(BindingError::from)?;
        let inspections: Vec<_> = order.iter().filter_map(|node| {
            ctx.resources.live.inspect_process(&ctx.operation.world, &invocation.invocation_id, node)
        }).collect();
        for inspection in &inspections {
            if inspection.request() != &SlotRequest::Context(invocation.request.clone()) {
                return Err(changed());
            }
            if !inspection.snapshot().settled || !inspection.closure_settled() {
                tokio::select! {
                    _ = ctx.cancellation.cancelled() => return Ok(None),
                    _ = inspection.wait(ctx.deadline.min(ctx.budget.deadline())) => {},
                }
            }
        }
        let Some(observed) = &invocation.observation else {
            let Some(mut outcome) = merge_inspected_composition(graph, &invocation.closure,
                &invocation.invocation_id, &SlotRequest::Context(invocation.request.clone()), &inspections)
                .await.map_err(composition_error)? else { return Ok(None); };
            for node in &mut outcome.nodes {
                if let Ok(output) = &node.result {
                    if let Err(error) = check(&invocation.request, page,
                        &SlotRequest::Context(invocation.request.clone()), output) {
                        node.result = Err(error);
                        outcome.result = Err(CompositionFailure::Incomplete { nodes: vec![node.node.clone()] });
                    }
                }
            }
            return retain(ctx, step_id, invocation, Ok(outcome)).await.map(Some);
        };
        let committed = ctx.store.read_commit::<ContextInvocation>(&observed.commit.world,
            &observed.commit.commit_id, &observed.commit.input_digest).await?;
        if observed.commit.world != ctx.operation.world || encode(&committed.value)? != encode(invocation)? {
            return Err(changed());
        }
        ctx.recheck_replay(&committed).await?;
        if observed.retained.get("nodes").is_none() {
            if !observed.settled { return Ok(None); }
            let failure: HostFailure = serde_json::from_value(observed.retained.clone())
                .map_err(|error| changed().caused(error))?;
            return Err(Error::from_host_failure(failure, FailureStage::Execute));
        }
        if !retained_composition_settled(&ctx.resources.live, graph, &invocation.closure,
            &invocation.invocation_id, &observed.retained, &inspections).map_err(composition_error)? {
            return Ok(None);
        }
        let result: Result<SlotResponse, HostFailure> = serde_json::from_value(
            observed.retained.get("result").cloned().ok_or_else(changed)?,
        ).map_err(|error| changed().caused(error))?;
        if let Err(failure) = result {
            return Err(Error::from_host_failure(failure, FailureStage::Execute));
        }
        if observed.settled { return Ok(Some(invocation.clone())); }
        save_observation(ctx, step_id, invocation, observed.retained.clone(), observed.roots.clone(), true)
            .await.map(Some)
    })
}

pub(super) fn retain_roots(invocation: &ContextInvocation, roots: &mut RetentionRoots) {
    roots.resources.extend(invocation.closure.affected_bindings.iter().cloned()
        .map(|id| ResourceRef::Binding { id }));
    if let Some(observed) = &invocation.observation {
        let retained = &observed.roots;
        roots.scopes.extend(retained.scopes.iter().cloned());
        roots.resources.extend(retained.resources.iter().cloned());
        roots.definitions.extend(retained.definitions.iter().cloned());
        roots.evidence.extend(retained.evidence.iter().cloned());
        roots.dependencies.extend(retained.dependencies.iter().cloned());
        roots.sources.extend(retained.sources.iter().cloned());
        roots.releases.extend(retained.releases.iter().cloned());
        roots.branches.extend(retained.branches.iter().cloned());
        roots.source_versions.extend(retained.source_versions.iter().cloned());
        roots.parse_artifacts.extend(retained.parse_artifacts.iter().cloned());
        roots.schemas.extend(retained.schemas.iter().cloned());
        roots.mappings.extend(retained.mappings.iter().cloned());
    }
}
