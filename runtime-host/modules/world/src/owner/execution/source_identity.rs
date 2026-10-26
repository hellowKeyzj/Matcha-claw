use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use world_protocol::{
    api::ApiFailure,
    bindings::{ExactClosure, SlotKind},
    failure::{FailureStage, Recovery},
    identity::{IdentityFailure, IdentityProposal, IdentityReceipt, IdentityResolveRequest},
    ids::*,
    operation::{CancellationState, OperationFailure, OperationPhase},
    process::{HostFailure, ProcessFailure, TerminalState},
    slots::{SlotFailure, SlotRequest, SlotResponse},
};

use crate::{
    authorization::{self, Admission},
    extensions::{
        bindings::{self, BindingError, BindingGraph},
        invocation::{
            CompositionFailure, CompositionOutcome, InvocationContext, InvocationFailure, InvocationLease,
            check_current_in_transaction, invoke_composition_checked,
            merge_inspected_composition, replay_composition_checked, retained_composition_closure_settled,
        },
        process::Delivery,
    },
    owner::{Error, StepRecord, ledger, run},
    store::{CommitRequest, RetentionRoots, StoreFuture, WorldTransaction},
};
use super::ExecutionContext;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    prefix: Digest,
    requests: Vec<IdentityResolveRequest>,
    receipts: Vec<IdentityReceipt>,
    closure: ExactClosure,
    calls: Vec<Call>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Call {
    invocation: InvocationId,
    observation: Option<Observation>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    commit: CommitRequest,
    retained: serde_json::Value,
    roots: RetentionRoots,
    settled: bool,
}

/// Original observations only. Source must accept proposals and finish this step in one transaction.
#[derive(Clone)]
pub(crate) struct ObservedSourceIdentities {
    step: StepRecord,
    context: InvocationContext,
    proposals: Vec<IdentityProposal>,
}

impl ObservedSourceIdentities {
    pub(crate) fn proposals(&self) -> &[IdentityProposal] { &self.proposals }

    pub(crate) async fn complete(&self, tx: &WorldTransaction<'_>, admission: &Admission) -> Result<(), Error> {
        if self.context.admission().invocation() != admission.invocation()
            || self.context.admission().decision() != admission.decision() { return Err(changed()); }
        let current_run = run::require_run_invocation(tx, admission, &self.step.run_id).await?;
        let operation = ledger::read(tx, &current_run.operation.operation_id).await?;
        if ledger::terminal(current_run.phase)
            || operation.receipt.cancellation != CancellationState::NotRequested
            || current_run.activation_lock_id.as_ref() != Some(&self.context.lease().graph().lock().id) {
            return Err(changed());
        }
        for node in &self.context.lease().closure().nodes {
            check_current_in_transaction(tx, admission, self.context.lease(), node).await
                .map_err(|error| Error::from_host_failure(error.host_failure(), FailureStage::Commit).caused(error))?;
        }
        let step = run::read_step(tx, &current_run.id, &self.step.id).await?.ok_or_else(changed)?;
        if encode(&step)? != encode(&self.step)? { return Err(changed()); }
        let checkpoint = decode(&step)?;
        if checkpoint.calls.len() != checkpoint.requests.len()
            || checkpoint.calls.iter().any(|call| call.observation.as_ref().is_none_or(|observation| !observation.settled)) {
            return Err(unknown());
        }
        let mut next = step.clone();
        next.phase = OperationPhase::Completed;
        next.result = Some(encode(&self.proposals)?);
        run::checkpoint_step(tx, &step, next).await?;
        Ok(())
    }
}

impl ExecutionContext {
    pub(crate) async fn resolve_source_identities(
        &self, prefix: Digest, requests: Vec<IdentityResolveRequest>, receipts: Vec<IdentityReceipt>,
    ) -> Result<ObservedSourceIdentities, Error> {
        let (graph, node, state, id, mut step) = self.prepare_source_identities(prefix, requests, receipts).await?;
        for index in 0..state.requests.len() {
            step = self.resolve_source_identity(&id, &state, &graph, &node, step, index).await?;
        }
        self.finish_source_identities(&graph, node, step).await
    }

    fn prepare_source_identities<'a>(
        &'a self,
        prefix: Digest,
        requests: Vec<IdentityResolveRequest>,
        receipts: Vec<IdentityReceipt>,
    ) -> StoreFuture<'a, (BindingGraph, NodeId, Checkpoint, StepId, StepRecord), Error> {
        Box::pin(async move {
            if requests.len() != receipts.len() || requests.iter().zip(&receipts).any(|(request, receipt)| {
                request.key.world != self.operation.world || request.key != receipt.key || request.scope != receipt.scope
                    || request.type_ref.world != self.operation.world
                    || receipt.dependencies.iter().any(|dependency| !request.dependencies.contains(dependency))
            }) { return Err(changed()); }
            let lock = self.run.activation_lock_id.clone().ok_or_else(changed)?;
            let admission = self.admission.clone();
            let graph = self.store.snapshot(self.operation.world.clone(), move |snapshot| Box::pin(async move {
                authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
                Ok::<_, Error>(bindings::read_graph(snapshot, &lock).await?)
            })).await?;
            let bindings: BTreeSet<_> = graph.lock().nodes.iter().filter(|node| node.slot == SlotKind::Identity)
                .map(|node| node.binding_id.clone()).collect();
            if bindings.len() != 1 { return Err(changed()); }
            let node = graph.composition_order(bindings.iter().next().expect("one Identity composition"))
                .map_err(BindingError::from)?.into_iter()
                .find(|node| graph.node(node).is_ok_and(|node| node.slot == SlotKind::Identity)).ok_or_else(changed)?;
            let closure = self.with_invocation(node.clone(), None, Vec::new(), |context, _| async move {
                Ok::<_, CompositionFailure>(context.lease().closure().clone())
            }).await.map_err(composition_error)?;
            let digest = crate::definitions::canonical_digest(&(&prefix, &requests, &receipts, &closure))?;
            let identity = crate::definitions::canonical_digest(&("world.source.identity.v1", &self.run.id, &prefix))?;
            let id = StepId::try_new(format!("source-identity-{}", &identity.as_str()[7..])).map_err(|_| changed())?;
            let state = Checkpoint { prefix, requests, receipts, closure, calls: Vec::new() };
            let claimed = state.clone();
            let step_id = id.clone();
            let key = format!("{}.claim", id.as_str());
            let step = self.transact(&key, digest.clone(), &["authorization", "sources"], move |tx, admission, _, current_run| Box::pin(async move {
                let previous = tx.query_opt("SELECT body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND kind='sources.identity' AND run_id<>$3 AND body->'checkpoint'->>'prefix'=$4 LIMIT 1",
                    &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &current_run.id.as_str(), &claimed.prefix.as_str()]).await?;
                if let Some(previous) = previous {
                    let previous: StepRecord = serde_json::from_value(previous.get("body")).map_err(|error| changed().caused(error))?;
                    if decode(&previous)?.prefix != claimed.prefix { return Err(changed()); }
                    return Err(Error::new("world.source_identity_original_run", FailureStage::Recover,
                        &format!("来源身份前缀仍属于原执行 {}，不能换执行重新发送。", previous.run_id),
                        ApiFailure::Operation(OperationFailure::Process(ProcessFailure::Retained)), Recovery::ManualReview));
                }
                if let Some(step) = run::read_step(tx, &current_run.id, &step_id).await? {
                    if step.input_digest != digest || !same_input(&decode(&step)?, &claimed)? { return Err(changed()); }
                    return Ok(step);
                }
                let row = tx.query_opt("SELECT COALESCE(MAX(ordinal)::bigint,-1)+1 AS ordinal FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND run_id=$3",
                    &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &current_run.id.as_str()]).await?.ok_or_else(changed)?;
                let ordinal = u32::try_from(row.get::<_, i64>("ordinal")).map_err(|_| changed())?;
                let now = tx.now().await?;
                let step = run::claim_step(tx, &admission, &current_run, step_id, ordinal, "sources.identity", digest, &now).await?;
                let mut next = step.clone();
                next.checkpoint = encode(&claimed)?;
                run::checkpoint_step(tx, &step, next).await
            })).await?.value;
            if ledger::terminal(step.phase) { return Err(changed()); }
            let step = read_current(self, &id).await?;
            Ok((graph, node, state, id, step))
        })
    }

    fn resolve_source_identity<'a>(
        &'a self,
        id: &'a StepId,
        state: &'a Checkpoint,
        graph: &'a BindingGraph,
        node: &'a NodeId,
        step: StepRecord,
        index: usize,
    ) -> StoreFuture<'a, StepRecord, Error> {
        Box::pin(async move {
            self.budget.check().map_err(|error| budget_error(error.dimension))?;
            if self.cancellation.is_cancelled() { return Err(Error::from_host_failure(HostFailure::Cancelled, FailureStage::Execute)); }
            let checkpoint = decode(&step)?;
            let mut dispatched;
            let refreshed;
            let restore_step = if checkpoint.calls.len() > index {
                &step
            } else {
                if checkpoint.calls.len() != index { return Err(changed()); }
                let owner = self.clone();
                let original = step.clone();
                let request = state.requests[index].clone();
                let receipt = state.receipts[index].clone();
                let expected_closure = state.closure.clone();
                dispatched = self.with_invocation(node.clone(), None, Vec::new(), move |context, mut services| -> StoreFuture<'_, _, CompositionFailure> {
                    Box::pin(async move {
                        let attempt: StoreFuture<'_, _, Error> = Box::pin(async {
                            if context.lease().closure() != &expected_closure { return Err(changed()); }
                            let mut checkpoint = decode(&original)?;
                            checkpoint.calls.push(Call { invocation: context.admission().invocation().id.clone(), observation: None });
                            let saved = checkpoint.clone();
                            let expected = original.clone();
                            let claim_key = format!("{}.call.{index}", original.id.as_str());
                            let claimed = owner.transact(&claim_key, crate::definitions::canonical_digest(&saved)?, &["authorization"],
                                move |tx, _, _, current_run| Box::pin(async move {
                                    let step = run::read_step(tx, &current_run.id, &expected.id).await?.ok_or_else(changed)?;
                                    if encode(&step)? != encode(&expected)? { return Err(changed()); }
                                    let mut next = step.clone();
                                    next.phase = OperationPhase::Retained;
                                    next.checkpoint = encode(&saved)?;
                                    run::checkpoint_step(tx, &step, next).await
                                }),
                            ).await?;
                            if claimed.replayed { return Ok((claimed.value, None, context.lease().clone())); }
                            services.identity_receipt = Some(receipt);
                            let expected = request.clone();
                            let outcome = invoke_composition_checked(context.clone(), SlotRequest::Identity(request), services,
                                |_, input| prepare(&expected, input), |_, input, output| check(&expected, input, output)).await;
                            Ok((claimed.value, Some(outcome), context.lease().clone()))
                        });
                        Ok::<_, CompositionFailure>(attempt.await)
                    })
                }).await.map_err(composition_error)??;
                let (claimed, outcome, lease) = &mut dispatched;
                match outcome.take() {
                    Some(outcome) => return observe(self, claimed, index, outcome, lease).await,
                    None => {
                        refreshed = read_current(self, id).await?;
                        &refreshed
                    },
                }
            };
            restore(self, restore_step, graph, index).await
        })
    }

    fn finish_source_identities<'a>(
        &'a self,
        graph: &'a BindingGraph,
        node: NodeId,
        step: StepRecord,
    ) -> StoreFuture<'a, ObservedSourceIdentities, Error> {
        Box::pin(async move {
            let checkpoint = decode(&step)?;
            let mut proposals = Vec::with_capacity(checkpoint.requests.len());
            for index in 0..checkpoint.requests.len() {
                proposals.push(proposal(graph, &checkpoint, index)?);
            }
            let closure = checkpoint.closure.clone();
            let context = self.with_invocation(node, None, Vec::new(), move |context, _| async move {
                if context.lease().closure() != &closure { return Err(CompositionFailure::Slot(SlotFailure::Identity(IdentityFailure::ImpactSetChanged))); }
                Ok::<_, CompositionFailure>(context)
            }).await.map_err(composition_error)?;
            Ok(ObservedSourceIdentities { step, context, proposals })
        })
    }
}

fn read_current<'a>(
    ctx: &'a ExecutionContext,
    id: &'a StepId,
) -> StoreFuture<'a, StepRecord, Error> {
    Box::pin(async move {
        let admission = ctx.admission.clone();
        let run_id = ctx.run.id.clone();
        let id = id.clone();
        ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
            authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
            run::read_step_snapshot(snapshot, &run_id, &id).await?.ok_or_else(changed)
        })).await
    })
}

fn observe<'a>(
    ctx: &'a ExecutionContext,
    step: &'a StepRecord,
    index: usize,
    outcome: Result<CompositionOutcome, CompositionFailure>,
    lease: &'a InvocationLease,
) -> StoreFuture<'a, StepRecord, Error> {
    Box::pin(async move {
        let settled = lease.closure().nodes.iter().all(|node| lease.ledger(node).is_some_and(|ledger| {
            !ledger.snapshot().resources.iter().any(|resource| resource.spec.invocation.as_ref() == Some(lease.invocation()))
        }));
        let (retained, roots, settled) = match &outcome {
            Ok(outcome) => (encode(&outcome.retained())?, outcome.retained_roots(&ctx.operation.world)?, settled
                && outcome.nodes.iter().all(|node| node.process.as_ref().is_none_or(|process| process.cleanup.is_none()
                    && (process.delivery == Delivery::NotDispatched || process.outcome.as_ref().is_some_and(|outcome| outcome.terminal != TerminalState::Retained))))),
            Err(error) => {
                let failure = error.host_failure();
                let mut roots = RetentionRoots::default();
                if let Some(error) = Error::from_host_failure(failure.clone(), FailureStage::Execute).operation_failure() {
                    crate::owner::operation_failure_roots(&ctx.operation.world, &error.details, &mut roots)?;
                }
                (encode(&failure)?, roots, settled)
            },
        };
        save_observation(ctx, step, index, retained, roots, settled).await
    })
}

fn save_observation<'a>(
    ctx: &'a ExecutionContext,
    step: &'a StepRecord,
    index: usize,
    retained: serde_json::Value,
    roots: RetentionRoots,
    settled: bool,
) -> StoreFuture<'a, StepRecord, Error> {
    Box::pin(async move {
        let digest = crate::definitions::canonical_digest(&(&step.id, step.revision, index, &retained, &roots, settled))?;
        let key = format!("{}.observed.{index}.{}", step.id.as_str(), step.revision.0);
        let commit = ctx.commit_request(&key, digest, &["authorization"]).await?;
        let mut checkpoint = decode(step)?;
        let call = checkpoint.calls.get_mut(index).ok_or_else(changed)?;
        call.observation = Some(Observation { commit: commit.clone(), retained, roots, settled });
        let saved = checkpoint.clone();
        let expected = step.clone();
        let usage = ctx.budget.checkpoint_usage();
        let committed = ctx.transact_outcome(commit, move |tx, _, _, current_run| Box::pin(async move {
            let step = run::read_step(tx, &current_run.id, &expected.id).await?.ok_or_else(changed)?;
            if encode(&step)? != encode(&expected)? { return Err(changed()); }
            let mut next = step.clone();
            next.checkpoint = encode(&saved)?;
            next.phase = if settled { OperationPhase::Running } else { OperationPhase::Retained };
            let next = run::checkpoint_step(tx, &step, next).await?;
            run::checkpoint_usage(tx, &current_run, run::confirmed_usage(&current_run.usage, usage)?).await?;
            Ok(next)
        })).await.map_err(Error::from)?;
        ctx.recheck_replay(&committed).await?;
        if !settled { return Err(unknown()); }
        let checkpoint = decode(&committed.value)?;
        if let Some(failure) = observed_failure(&checkpoint, index)? {
            return Err(Error::from_host_failure(failure, FailureStage::Execute));
        }
        Ok(committed.value)
    })
}

fn restore<'a>(
    ctx: &'a ExecutionContext,
    step: &'a StepRecord,
    graph: &'a BindingGraph,
    index: usize,
) -> StoreFuture<'a, StepRecord, Error> {
    Box::pin(async move {
        let checkpoint = decode(step)?;
        let call = checkpoint.calls.get(index).ok_or_else(changed)?;
        let request = SlotRequest::Identity(checkpoint.requests[index].clone());
        let selected = graph.node(&checkpoint.closure.root).map_err(BindingError::from)?;
        let inspections: Vec<_> = graph.composition_order(&selected.binding_id).map_err(BindingError::from)?.iter()
            .filter_map(|node| ctx.resources.live.inspect_process_request(&ctx.operation.world, &call.invocation, node, &request)).collect();
        for inspection in &inspections {
            if inspection.request() != &request { return Err(changed()); }
            if !inspection.snapshot().settled || !inspection.closure_settled() {
                tokio::select! {
                    _ = ctx.cancellation.cancelled() => return Err(unknown()),
                    _ = inspection.wait(ctx.deadline.min(ctx.budget.deadline())) => {},
                }
            }
        }
        let Some(observed) = &call.observation else {
            let Some(outcome) = merge_inspected_composition(graph, &checkpoint.closure, &call.invocation, &request, &inspections)
                .await.map_err(composition_error)? else { return Err(unknown()); };
            let lease = inspections.first().ok_or_else(unknown)?.context().lease();
            return observe(ctx, step, index, Ok(outcome), lease).await;
        };
        let committed = ctx.store.read_commit::<StepRecord>(&observed.commit.world, &observed.commit.commit_id, &observed.commit.input_digest).await?;
        let original = decode(&committed.value)?;
        if observed.commit.world != ctx.operation.world || committed.value.id != step.id || committed.value.run_id != step.run_id
            || original.calls.get(index).map(encode).transpose()? != Some(encode(call)?) { return Err(changed()); }
        ctx.recheck_replay(&committed).await?;
        if !observed.settled {
            if observed.retained.get("nodes").is_none()
                || !retained_composition_closure_settled(&ctx.resources.live, graph, &checkpoint.closure, &call.invocation,
                    &observed.retained, &inspections).map_err(composition_error)? { return Err(unknown()); }
            return save_observation(ctx, step, index, observed.retained.clone(), observed.roots.clone(), true).await;
        }
        if let Some(failure) = observed_failure(&checkpoint, index)? {
            return Err(Error::from_host_failure(failure, FailureStage::Execute));
        }
        proposal(graph, &checkpoint, index)?;
        Ok(step.clone())
    })
}

fn observed_failure(checkpoint: &Checkpoint, index: usize) -> Result<Option<HostFailure>, Error> {
    let observed = checkpoint.calls.get(index).and_then(|call| call.observation.as_ref()).ok_or_else(unknown)?;
    if observed.retained.get("nodes").is_none() {
        return serde_json::from_value(observed.retained.clone()).map(Some).map_err(|error| changed().caused(error));
    }
    let result: Result<SlotResponse, HostFailure> = serde_json::from_value(
        observed.retained.get("result").cloned().ok_or_else(changed)?,
    ).map_err(|error| changed().caused(error))?;
    Ok(result.err())
}

fn proposal(graph: &BindingGraph, checkpoint: &Checkpoint, index: usize) -> Result<IdentityProposal, Error> {
    let observed = checkpoint.calls.get(index).and_then(|call| call.observation.as_ref()).filter(|observation| observation.settled).ok_or_else(unknown)?;
    let request = &checkpoint.requests[index];
    let result = replay_composition_checked(graph, &checkpoint.closure.root, SlotRequest::Identity(request.clone()),
        &observed.retained, |_, input| prepare(request, input), |_, input, output| check(request, input, output)).map_err(composition_error)?;
    let SlotResponse::Identity(proposal) = result else { return Err(changed()); };
    Ok(proposal)
}

fn prepare(request: &IdentityResolveRequest, input: SlotRequest) -> Result<SlotRequest, CompositionFailure> {
    if input != SlotRequest::Identity(request.clone()) { return Err(invalid()); }
    Ok(input)
}

fn check(request: &IdentityResolveRequest, input: &SlotRequest, output: &SlotResponse) -> Result<Option<SlotResponse>, CompositionFailure> {
    if input != &SlotRequest::Identity(request.clone()) { return Err(invalid()); }
    let SlotResponse::Identity(proposal) = output else { return Err(invalid()); };
    let valid = match proposal {
        IdentityProposal::Same { target, .. } => request.candidates.iter().any(|candidate| match (&candidate.identity.record, target) {
            (world_protocol::identity::IdentityRecord::Object(object), world_protocol::identity::SubjectRef::Object { id }) => &object.id == id,
            (world_protocol::identity::IdentityRecord::Relation(relation), world_protocol::identity::SubjectRef::Relation { id }) => &relation.id == id,
            _ => false,
        }),
        IdentityProposal::New { type_ref, .. } => type_ref == &request.type_ref,
        IdentityProposal::Ambiguous { .. } => true,
    };
    if !valid { return Err(invalid()); }
    Ok(None)
}

pub(in crate::owner) fn step_retention_roots(step: &StepRecord, roots: &mut RetentionRoots) -> Result<(), Error> {
    let checkpoint = decode(step)?;
    roots.resources.extend(checkpoint.closure.affected_bindings.iter().cloned().map(|id| ResourceRef::Binding { id }));
    for (request, receipt) in checkpoint.requests.iter().zip(&checkpoint.receipts) {
        roots.scopes.push(request.scope.clone());
        roots.resources.push(ResourceRef::Source { id: request.key.source_id.clone() });
        roots.definitions.push(request.type_ref.clone());
        roots.dependencies.extend(request.dependencies.clone());
        roots.dependencies.extend(receipt.dependencies.clone());
        for candidate in &request.candidates { roots.evidence.extend(candidate.evidence.clone()); }
    }
    for call in checkpoint.calls {
        if let Some(observed) = call.observation {
            roots.scopes.extend(observed.roots.scopes);
            roots.resources.extend(observed.roots.resources);
            roots.definitions.extend(observed.roots.definitions);
            roots.evidence.extend(observed.roots.evidence);
            roots.dependencies.extend(observed.roots.dependencies);
            roots.sources.extend(observed.roots.sources);
            roots.releases.extend(observed.roots.releases);
            roots.branches.extend(observed.roots.branches);
            roots.source_versions.extend(observed.roots.source_versions);
            roots.parse_artifacts.extend(observed.roots.parse_artifacts);
            roots.schemas.extend(observed.roots.schemas);
            roots.mappings.extend(observed.roots.mappings);
        }
    }
    Ok(())
}

fn same_input(left: &Checkpoint, right: &Checkpoint) -> Result<bool, Error> {
    Ok(crate::definitions::canonical_digest(&(&left.prefix, &left.requests, &left.receipts, &left.closure))?
        == crate::definitions::canonical_digest(&(&right.prefix, &right.requests, &right.receipts, &right.closure))?)
}
fn decode(step: &StepRecord) -> Result<Checkpoint, Error> {
    if step.kind != "sources.identity" { return Err(changed()); }
    let checkpoint: Checkpoint = serde_json::from_value(step.checkpoint.clone()).map_err(|error| changed().caused(error))?;
    if checkpoint.requests.len() != checkpoint.receipts.len() || checkpoint.calls.len() > checkpoint.requests.len()
        || step.input_digest != crate::definitions::canonical_digest(&(&checkpoint.prefix, &checkpoint.requests, &checkpoint.receipts, &checkpoint.closure))? {
        return Err(changed());
    }
    Ok(checkpoint)
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(|error| Error::internal(FailureStage::Commit).caused(error))
}
fn invalid() -> CompositionFailure { CompositionFailure::Slot(SlotFailure::Identity(IdentityFailure::CandidateScopeIncomplete)) }
fn composition_error(error: CompositionFailure) -> Error {
    Error::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error)
}
fn budget_error(dimension: world_protocol::budget::BudgetDimension) -> Error {
    Error::from_host_failure(HostFailure::BudgetExceeded { dimension }, FailureStage::Execute)
}
fn unknown() -> Error {
    Error::new("world.source_identity_unsettled", FailureStage::Recover, "原身份调用尚无已结清观察，不能重新发送。",
        ApiFailure::Operation(OperationFailure::Process(ProcessFailure::Retained)), Recovery::ManualReview)
}
fn changed() -> Error {
    Error::new("world.source_identity_basis_changed", FailureStage::Recover, "原来源身份前缀或调用依据已变化。",
        ApiFailure::RevisionConflict, Recovery::Refresh)
}
