use std::{collections::BTreeSet, sync::Arc};

use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    abstraction::{AbstractionContract, AbstractionFailure, AbstractionRequest},
    api::{ProposeAbstraction, WorldCommand},
    bindings::SlotKind,
    failure::FailureStage,
    learning::Candidate,
};

use crate::{
    authorization,
    extensions::invocation::InvocationContext,
    owner::{Error, ExecutionContext},
    store::StoreFuture,
};

/// The complete author command stays with its original owner, not in an incomplete slot request.
pub(crate) struct AbstractionExecution {
    owner: ExecutionContext,
    invocation: InvocationContext,
    command: ProposeAbstraction,
    request: AbstractionRequest,
    result: tokio::sync::OnceCell<Result<(Candidate, AbstractionContract), Error>>,
}

impl AbstractionExecution {
    pub(super) fn new(
        owner: ExecutionContext,
        invocation: InvocationContext,
        command: ProposeAbstraction,
        request: AbstractionRequest,
    ) -> Self {
        Self { owner, invocation, command, request, result: tokio::sync::OnceCell::new() }
    }

    pub(crate) fn execute<'a>(
        &'a self,
        context: &'a InvocationContext,
        request: &'a AbstractionRequest,
        cancel: &'a CancellationToken,
        deadline: Instant,
    ) -> StoreFuture<'a, AbstractionContract, Error> {
        Box::pin(async move {
            let graph = self.invocation.lease().graph();
            let root = graph.node(self.invocation.node()).map_err(crate::extensions::bindings::BindingError::from)?;
            let member = graph.node(context.node()).map_err(crate::extensions::bindings::BindingError::from)?;
            if request != &self.request || member.slot != SlotKind::Abstraction
                || member.binding_id != root.binding_id
                || !Arc::ptr_eq(context.lease(), self.invocation.lease())
                || context.admission().invocation() != self.owner.admission.invocation()
                || context.admission().decision() != self.owner.admission.decision()
                || self.owner.run.activation_lock_id.as_ref() != Some(&graph.lock().id)
            {
                return Err(changed());
            }
            self.check(context, cancel, deadline).await?;
            let (_, contract) = self.result.get_or_init(|| async {
                let command = self.command.clone();
                let expected = self.request.clone();
                let invocation = context.clone();
                let content = self.owner.resources.content.clone();
                let budget = context.budget().clone();
                let cancel = cancel.clone();
                Ok(self.owner.transact("learning.abstraction.create",
                    crate::definitions::canonical_digest(&WorldCommand::ProposeAbstraction(command.clone()))?,
                    &["learning", "releases", "content", "query", "evaluation", "abstraction", "authorization"],
                    move |tx, admission, operation, _| Box::pin(async move {
                        if !matches!(operation.input.command()?, WorldCommand::ProposeAbstraction(actual) if actual == &command) {
                            return Err(changed());
                        }
                        crate::extensions::invocation::check_current_in_transaction(
                            tx, &admission, invocation.lease(), invocation.node(),
                        ).await.map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error))?;
                        let now = tx.now().await?;
                        let (branch, candidate, contract) = super::abstraction_proposal(tx, &command, &now).await?;
                        if projection(tx, &command, &contract).await? != expected { return Err(changed()); }
                        admission.require_access(&super::abstraction_proposal_impact(tx, &branch, &candidate, &contract).await?)?;
                        let candidate = match crate::releases::read_candidate(tx, &candidate.id).await? {
                            Some((branch, stored)) => {
                                admission.require_access(&crate::learning::candidate_impact(tx, &stored, &branch,
                                    world_protocol::authorization::AccessMode::Write).await?)?;
                                crate::learning::recheck_model_calls(tx, &admission, &stored).await?;
                                stored
                            }
                            None => crate::learning::propose_request(tx, &admission, &candidate,
                                &command.change.task, &command.change.compile, None, &budget, &cancel, &now).await?,
                        };
                        let contract = crate::abstraction::record(tx, &content, &admission, &contract, &budget, &cancel).await?;
                        let output = crate::learning::candidate_read_impact(tx, &candidate.id).await?;
                        authorization::check_admitted_output(tx, &admission, &output, 1, &tx.now().await?).await?;
                        Ok((candidate, contract))
                    }),
                ).await?.value)
            }).await.clone()?;
            self.check(context, cancel, deadline).await?;
            Ok(contract)
        })
    }

    async fn check(&self, context: &InvocationContext, cancel: &CancellationToken, deadline: Instant) -> Result<(), Error> {
        if cancel.is_cancelled() || self.owner.cancellation.is_cancelled() {
            return Err(crate::abstraction::Error::from(AbstractionFailure::Cancelled).into());
        }
        if Instant::now() >= deadline.min(self.owner.deadline).min(context.budget().deadline()) {
            return Err(crate::abstraction::Error::from(AbstractionFailure::BudgetExceeded).into());
        }
        context.check_current().await.map_err(|error| {
            Error::from_host_failure(error.host_failure(), FailureStage::Prepare).caused(error)
        })
    }
}

pub(super) async fn projection(
    tx: &crate::store::WorldTransaction<'_>, command: &ProposeAbstraction, contract: &AbstractionContract,
) -> Result<AbstractionRequest, Error> {
    let task = crate::evaluation::read_task(tx, &command.change.task.id, command.change.task.revision).await?;
    Ok(AbstractionRequest {
        world: contract.world.clone(), budget: task.budget.clone(), task,
        definitions: contract.original_definitions.clone(), assurance: contract.assurance,
    })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Invocation {
    command: ProposeAbstraction,
    request: AbstractionRequest,
    contract: AbstractionContract,
    invocation_id: world_protocol::ids::InvocationId,
    closure: world_protocol::bindings::ExactClosure,
    observation: Option<Observation>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    retained: serde_json::Value,
    roots: crate::store::RetentionRoots,
    settled: bool,
}

fn node(graph: &crate::extensions::bindings::BindingGraph) -> Result<world_protocol::ids::NodeId, Error> {
    let bindings: BTreeSet<_> = graph.lock().nodes.iter().filter(|node| node.slot == SlotKind::Abstraction)
        .map(|node| node.binding_id.clone()).collect();
    if bindings.len() != 1 { return Err(changed()); }
    graph.composition_order(bindings.iter().next().expect("one Abstraction composition"))
        .map_err(crate::extensions::bindings::BindingError::from)?.into_iter()
        .find(|node| graph.node(node).is_ok_and(|node| node.slot == SlotKind::Abstraction)).ok_or_else(changed)
}

pub(super) async fn access(
    tx: &crate::store::WorldTransaction<'_>, lock: &world_protocol::ids::ActivationLockId,
    scope: &world_protocol::ids::ScopeId,
) -> Result<world_protocol::authorization::ActualImpact, Error> {
    let graph = crate::extensions::bindings::read_graph_history_in_transaction(tx, lock).await?;
    let root = node(&graph)?;
    let resources = graph.closure_nodes(&root).map_err(crate::extensions::bindings::BindingError::from)?
        .iter().map(|node| graph.node(node).map(|node| world_protocol::ids::ResourceRef::Binding { id: node.binding_id.clone() }))
        .collect::<Result<BTreeSet<_>, _>>().map_err(crate::extensions::bindings::BindingError::from)?;
    Ok(authorization::actual_impact(vec![world_protocol::authorization::AccessScope {
        resources: resources.into_iter().collect(), fields: Vec::new(),
        modes: vec![world_protocol::authorization::AccessMode::Execute], scope: scope.clone(), valid_time: None,
    }], Vec::new(), Vec::new(), Vec::new(), Vec::new())?)
}

pub(super) fn run(ctx: ExecutionContext, command: ProposeAbstraction) -> StoreFuture<'static, world_protocol::api::CommandResult, Error> {
    Box::pin(async move {
        use crate::extensions::{bindings, invocation::{CompositionFailure, invoke_composition_checked, replay_composition_checked,
            merge_inspected_composition, retained_composition_settled}};
        use world_protocol::{ids::*, operation::{OperationPhase, OperationResult}, slots::{SlotRequest, SlotResponse}};
        let digest = crate::definitions::canonical_digest(&WorldCommand::ProposeAbstraction(command.clone()))?;
        if let Some(committed) = ctx.store.read_commit_optional::<Candidate>(&ctx.operation.world,
            &ctx.commit_id("learning.final")?, &digest).await? {
            ctx.recheck_replay(&committed).await?;
            return Ok(world_protocol::api::CommandResult::Candidate(committed.value));
        }
        let step_id = StepId::try_new(format!("abstraction-{}", &digest.as_str()[7..])).map_err(|cause| changed().caused(cause))?;
        let lock = ctx.run.activation_lock_id.clone().ok_or_else(changed)?;
        let admission = ctx.admission.clone();
        let graph = ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
            authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
            Ok::<_, Error>(bindings::read_graph(snapshot, &lock).await?)
        })).await?;
        let root = node(&graph)?;
        let current = ctx.clone();
        let id = step_id.clone();
        let command_in = command.clone();
        let returned = ctx.with_invocation(root.clone(), None, Vec::new(), move |invocation, mut services| {
            let result: StoreFuture<'static, _, Error> = Box::pin(async move {
                let saved = invocation.clone();
                let claimed = current.transact("learning.abstraction.claim", digest,
                    &["learning", "releases", "authorization"], move |tx, admission, operation, run| Box::pin(async move {
                        if !matches!(operation.input.command()?, WorldCommand::ProposeAbstraction(actual) if actual == &command_in) { return Err(changed()); }
                        let (branch, candidate, contract) = super::abstraction_proposal(tx, &command_in, &tx.now().await?).await?;
                        admission.require_access(&super::abstraction_proposal_impact(tx, &branch, &candidate, &contract).await?)?;
                        let selected = Invocation { command: command_in.clone(), request: projection(tx, &command_in, &contract).await?,
                            contract, invocation_id: saved.admission().invocation().id.clone(), closure: saved.lease().closure().clone(), observation: None };
                        let step = crate::owner::claim_step(tx, &admission, &run, id, 0, "learning.abstraction",
                            crate::definitions::canonical_digest(&WorldCommand::ProposeAbstraction(command_in))?, &tx.now().await?).await?;
                        let mut next = step.clone();
                        next.phase = OperationPhase::Retained;
                        next.checkpoint = encode(&selected)?;
                        crate::owner::checkpoint_step(tx, &step, next).await?;
                        Ok(selected)
                    }),
                ).await?;
                let selected = claimed.value;
                if claimed.replayed { return Ok::<_, Error>((selected, None)); }
                services.abstraction = Some(Arc::new(AbstractionExecution::new(current.clone(), invocation.clone(),
                    selected.command.clone(), selected.request.clone())));
                let outcome = invoke_composition_checked(invocation, SlotRequest::Abstraction(selected.request.clone()), services,
                    |_, input| prepare(&selected, input), |_, input, output| check(&selected, input, output)).await;
                Ok((selected, Some(outcome)))
            });
            result.map(Ok::<_, CompositionFailure>)
        }).await.map_err(composition_error)??;
        let (mut selected, outcome) = returned;
        if outcome.is_none() {
            let id = step_id.clone();
            let run = ctx.run.id.clone();
            let admission = ctx.admission.clone();
            let original = selected.clone();
            selected = ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
                authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
                let step = crate::owner::read_step_snapshot(snapshot, &run, &id).await?.ok_or_else(changed)?;
                let actual: Invocation = serde_json::from_value(step.checkpoint).map_err(|cause| changed().caused(cause))?;
                if actual.command != original.command || actual.request != original.request || actual.contract != original.contract
                    || actual.invocation_id != original.invocation_id || actual.closure != original.closure { return Err(changed()); }
                Ok::<_, Error>(actual)
            })).await?;
        }
        if selected.command != command || selected.closure.root != root || selected.closure.activation_lock_id != graph.lock().id { return Err(changed()); }
        if let Some(outcome) = outcome { selected = observe(&ctx, &step_id, &selected, outcome).await?; }
        let inspections: Vec<_> = graph.composition_order(&graph.node(&root).map_err(bindings::BindingError::from)?.binding_id)
            .map_err(bindings::BindingError::from)?.iter().filter_map(|node| {
                ctx.resources.live.inspect_process(&ctx.operation.world, &selected.invocation_id, node)
            }).collect();
        for inspection in &inspections {
            if inspection.request() != &SlotRequest::Abstraction(selected.request.clone()) { return Err(changed()); }
            if !inspection.snapshot().settled || !inspection.closure_settled() {
                tokio::select! { _ = ctx.cancellation.cancelled() => {},
                    _ = inspection.wait(ctx.deadline.min(ctx.budget.deadline())) => {}, }
            }
        }
        if selected.observation.is_none() {
            if let Some(outcome) = merge_inspected_composition(&graph, &selected.closure, &selected.invocation_id,
                &SlotRequest::Abstraction(selected.request.clone()), &inspections).await.map_err(composition_error)? {
                selected = observe(&ctx, &step_id, &selected, Ok(outcome)).await?;
            }
        }
        let Some(observed) = &selected.observation else { return retain(&ctx).await; };
        if !observed.settled && (observed.retained.get("nodes").is_none()
            || !retained_composition_settled(&ctx.resources.live, &graph, &selected.closure,
                &selected.invocation_id, &observed.retained, &inspections).map_err(composition_error)?) {
            return retain(&ctx).await;
        }
        if ctx.resources.live.invocation_unsettled(&ctx.operation.world, &selected.invocation_id) { return retain(&ctx).await; }
        let result: Result<SlotResponse, world_protocol::process::HostFailure> = if observed.retained.get("nodes").is_some() {
            serde_json::from_value(observed.retained.get("result").cloned().ok_or_else(changed)?)
        } else { serde_json::from_value(observed.retained.clone()).map(Err) }.map_err(|cause| changed().caused(cause))?;
        if let Err(failure) = result { return Err(Error::from_host_failure(failure, FailureStage::Execute)); }
        let result = replay_composition_checked(&graph, &root, SlotRequest::Abstraction(selected.request.clone()), &observed.retained,
            |_, input| prepare(&selected, input), |_, input, output| check(&selected, input, output)).map_err(composition_error)?;
        let SlotResponse::Abstraction(contract) = result else { return Err(changed()); };
        let current = ctx.clone();
        let id = step_id;
        let final_result = ctx.with_invocation(root, None, Vec::new(), move |fresh, _| {
            let result: StoreFuture<'static, _, Error> = Box::pin(async move {
                let creator = AbstractionExecution::new(current.clone(), fresh.clone(), command, selected.request.clone());
                if creator.execute(&fresh, &selected.request, &current.cancellation, current.deadline).await? != contract { return Err(changed()); }
                let saved = selected.clone();
                let usage = current.budget.checkpoint_usage();
                let committed = current.transact("learning.final", crate::definitions::canonical_digest(&WorldCommand::ProposeAbstraction(selected.command.clone()))?,
                    &["learning", "releases", "abstraction", "authorization"], move |tx, admission, operation, run| Box::pin(async move {
                        for node in &fresh.lease().closure().nodes {
                            crate::extensions::invocation::check_current_in_transaction(tx, &admission, fresh.lease(), node).await
                                .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Verify).caused(error))?;
                        }
                        let step = crate::owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                        let actual: Invocation = serde_json::from_value(step.checkpoint.clone()).map_err(|cause| changed().caused(cause))?;
                        if actual.command != saved.command || actual.request != saved.request || actual.contract != contract
                            || actual.invocation_id != saved.invocation_id || actual.closure != saved.closure
                            || actual.observation.as_ref().map(encode).transpose()? != saved.observation.as_ref().map(encode).transpose()? { return Err(changed()); }
                        let (branch, candidate, exact) = super::abstraction_proposal(tx, &saved.command, &tx.now().await?).await?;
                        if exact != contract || crate::abstraction::read(tx, &contract.id, contract.revision).await?.as_ref() != Some(&contract) { return Err(changed()); }
                        admission.require_access(&super::abstraction_proposal_impact(tx, &branch, &candidate, &contract).await?)?;
                        let (_, candidate) = crate::releases::read_candidate(tx, &contract.candidate_id).await?.ok_or_else(changed)?;
                        let output = crate::learning::candidate_read_impact(tx, &candidate.id).await?;
                        authorization::check_admitted_output(tx, &admission, &output, 1, &tx.now().await?).await?;
                        let mut next = step.clone(); next.phase = OperationPhase::Completed; next.result = Some(encode(&contract)?);
                        crate::owner::checkpoint_step(tx, &step, next).await?;
                        crate::owner::checkpoint_usage(tx, &run, crate::owner::confirmed_usage(&run.usage, usage)?).await?;
                        crate::owner::complete_operation(tx, &operation.receipt.accepted, OperationResult::Candidate(candidate.clone()), &tx.now().await?).await?;
                        Ok(candidate)
                    }),
                ).await?;
                Ok::<_, Error>(world_protocol::api::CommandResult::Candidate(committed.value))
            });
            result.map(Ok::<_, CompositionFailure>)
        }).await.map_err(composition_error)?;
        final_result
    })
}

fn observe<'a>(
    ctx: &'a ExecutionContext, id: &'a world_protocol::ids::StepId, selected: &'a Invocation,
    outcome: Result<crate::extensions::invocation::CompositionOutcome, crate::extensions::invocation::CompositionFailure>,
) -> StoreFuture<'a, Invocation, Error> {
    Box::pin(async move {
        let (retained, roots, settled) = match outcome {
            Ok(outcome) => (encode(&outcome.retained())?, outcome.retained_roots(&ctx.operation.world)?,
                !ctx.resources.live.invocation_unsettled(&ctx.operation.world, &selected.invocation_id)
                    && outcome.nodes.iter().all(|node| node.process.as_ref().is_none_or(|process| {
                        process.cleanup.is_none() && (process.delivery == crate::extensions::process::Delivery::NotDispatched
                            || process.outcome.as_ref().is_some_and(|outcome| outcome.terminal != world_protocol::process::TerminalState::Retained))
                    }))),
            Err(error) => {
                let failure = error.host_failure();
                let mut roots = crate::store::RetentionRoots::default();
                if let Some(error) = Error::from_host_failure(failure.clone(), FailureStage::Execute).operation_failure() {
                    crate::owner::operation_failure_roots(&ctx.operation.world, &error.details, &mut roots)?;
                }
                (encode(&failure)?, roots, !ctx.resources.live.invocation_unsettled(&ctx.operation.world, &selected.invocation_id))
            }
        };
        let maximum = usize::try_from(ctx.budget.remaining(world_protocol::budget::BudgetDimension::Bytes)
            .map_err(|error| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Execute))?).unwrap_or(usize::MAX);
        let bytes = world_protocol::wire::encode(&(&retained, &roots), maximum).map_err(|cause| changed().caused(cause))?;
        ctx.budget.charge(world_protocol::budget::BudgetDimension::Bytes, bytes.len() as u64)
            .map_err(|error| Error::from_host_failure(world_protocol::process::HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Execute))?;
        let mut saved = selected.clone(); saved.observation = Some(Observation { retained, roots, settled });
        let id = id.clone();
        let expected = selected.clone();
        let usage = ctx.budget.checkpoint_usage();
        Ok(ctx.transact(&format!("learning.abstraction.observed.{}", crate::definitions::canonical_digest(&saved)?.as_str()),
            crate::definitions::canonical_digest(&saved)?, &["learning", "authorization"], move |tx, _, _, run| Box::pin(async move {
                let step = crate::owner::read_step(tx, &run.id, &id).await?.ok_or_else(changed)?;
                let actual: Invocation = serde_json::from_value(step.checkpoint.clone()).map_err(|cause| changed().caused(cause))?;
                if encode(&actual)? != encode(&expected)? { return Err(changed()); }
                let mut next = step.clone(); next.checkpoint = encode(&saved)?;
                crate::owner::checkpoint_step(tx, &step, next).await?;
                crate::owner::checkpoint_usage(tx, &run, crate::owner::confirmed_usage(&run.usage, usage)?).await?;
                Ok(saved)
            }),
        ).await?.value)
    })
}

async fn retain(ctx: &ExecutionContext) -> Result<world_protocol::api::CommandResult, Error> {
    let committed = ctx.transact(&format!("learning.abstraction.retain.{}", ctx.admission.invocation().id),
        crate::definitions::canonical_digest(&ctx.run.id)?, &["learning", "authorization"], move |tx, _, operation, _| Box::pin(async move {
            crate::owner::update_operation(tx, &operation.receipt.accepted, crate::owner::OperationUpdate {
                phase: world_protocol::operation::OperationPhase::Retained, progress: operation.receipt.progress.clone(), failure: None, effects: Vec::new(),
            }, &tx.now().await?).await?;
            Ok(())
        }),
    ).await?;
    Ok(world_protocol::api::CommandResult::Commit(committed.receipt))
}

pub(crate) fn step_retention_roots(step: &crate::owner::StepRecord, roots: &mut crate::store::RetentionRoots) -> Result<(), Error> {
    if step.kind != "learning.abstraction" { return Err(changed()); }
    let selected: Invocation = serde_json::from_value(step.checkpoint.clone()).map_err(|cause| changed().caused(cause))?;
    if step.input_digest != crate::definitions::canonical_digest(&WorldCommand::ProposeAbstraction(selected.command.clone()))? { return Err(changed()); }
    crate::abstraction::retain_contract(&selected.contract.world, &selected.contract, roots);
    roots.resources.extend(selected.closure.affected_bindings.into_iter().map(|id| world_protocol::ids::ResourceRef::Binding { id }));
    if let Some(observed) = selected.observation {
        roots.scopes.extend(observed.roots.scopes); roots.resources.extend(observed.roots.resources);
        roots.definitions.extend(observed.roots.definitions); roots.evidence.extend(observed.roots.evidence);
        roots.dependencies.extend(observed.roots.dependencies); roots.sources.extend(observed.roots.sources);
        roots.releases.extend(observed.roots.releases); roots.branches.extend(observed.roots.branches);
        roots.source_versions.extend(observed.roots.source_versions); roots.parse_artifacts.extend(observed.roots.parse_artifacts);
        roots.schemas.extend(observed.roots.schemas); roots.mappings.extend(observed.roots.mappings);
    }
    Ok(())
}

fn prepare(selected: &Invocation, input: world_protocol::slots::SlotRequest) -> Result<world_protocol::slots::SlotRequest, crate::extensions::invocation::CompositionFailure> {
    if input != world_protocol::slots::SlotRequest::Abstraction(selected.request.clone()) { return Err(invalid()); }
    Ok(input)
}

fn check(selected: &Invocation, input: &world_protocol::slots::SlotRequest, output: &world_protocol::slots::SlotResponse) -> Result<Option<world_protocol::slots::SlotResponse>, crate::extensions::invocation::CompositionFailure> {
    if input != &world_protocol::slots::SlotRequest::Abstraction(selected.request.clone())
        || output != &world_protocol::slots::SlotResponse::Abstraction(selected.contract.clone()) { return Err(invalid()); }
    Ok(None)
}

fn invalid() -> crate::extensions::invocation::CompositionFailure {
    crate::extensions::invocation::CompositionFailure::Slot(world_protocol::slots::SlotFailure::Abstraction(AbstractionFailure::BasisChanged))
}
fn composition_error(error: crate::extensions::invocation::CompositionFailure) -> Error {
    Error::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error)
}
fn encode<T: Serialize>(value: &T) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(|cause| changed().caused(cause))
}
fn changed() -> Error {
    crate::abstraction::Error::from(AbstractionFailure::BasisChanged).into()
}
