use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use world_protocol::{bindings::{ExactClosure, SlotKind}, failure::FailureStage, ids::*,
    process::HostFailure, slots::{SlotRequest, SlotResponse}};
use crate::{authorization, definitions::canonical_digest, extensions::{bindings, invocation::{CompositionFailure,
    CompositionOutcome, invoke_composition_checked, merge_inspected_composition, replay_composition_checked,
    retained_composition_settled}}, owner::{self, Error, ExecutionContext}, store::{RetentionRoots, StoreFuture}};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Call {
    invocation: InvocationId,
    closure: ExactClosure,
    request: SlotRequest,
    observation: Option<Observation>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    retained: serde_json::Value,
    roots: RetentionRoots,
    settled: bool,
}

pub(in crate::owner::workflows) fn select(graph: &bindings::BindingGraph, slot: SlotKind) -> Result<NodeId, Error> {
    let selected: std::collections::BTreeSet<_> = graph.lock().nodes.iter().filter(|node| node.slot == slot)
        .map(|node| node.binding_id.clone()).collect();
    if selected.len() != 1 { return Err(super::invalid("slot.binding")); }
    graph.composition_order(selected.iter().next().expect("one slot composition"))
        .map_err(bindings::BindingError::from)?.into_iter()
        .find(|id| graph.node(id).is_ok_and(|node| node.slot == slot)).ok_or_else(|| super::invalid("slot.binding"))
}

fn check(admission: &authorization::Admission, request: &SlotRequest, response: &SlotResponse) -> Result<Option<SlotResponse>, CompositionFailure> {
    use world_protocol::slots::SlotFailure;
    match (request, response) {
        (SlotRequest::Policy(request), SlotResponse::Policy(result)) => admission.check_policy_result(request, result)
            .map_err(|error| match error { authorization::AuthError::Denied(reason) => CompositionFailure::Slot(SlotFailure::Policy(reason)),
                error => CompositionFailure::Invocation(crate::extensions::invocation::InvocationFailure::Current(
                    crate::extensions::invocation::CurrentFailure::Authorization(error))) })?,
        (SlotRequest::Action(request), SlotResponse::Action(result)) => crate::actions::check_plan(request, result)
            .map_err(|failure| CompositionFailure::Slot(SlotFailure::Action(failure)))?,
        (SlotRequest::Provenance(request), SlotResponse::Provenance(result)) => crate::facts::support::check_proposal(request, result)
            .map_err(|failure| CompositionFailure::Slot(SlotFailure::Provenance(failure)))?,
        _ => return Err(CompositionFailure::ProcessResultMissing),
    }
    Ok(None)
}

/// Pure slot proposals stay in their original business Step; recovery never dispatches a missing call again.
pub(in crate::owner::workflows) fn invoke<'a>(ctx: &'a ExecutionContext, kind: &'static str, input: Digest, node: NodeId, request: SlotRequest) -> StoreFuture<'a, SlotResponse, Error> {
    Box::pin(async move {
        let key = match &request { SlotRequest::Policy(_) => "policy", SlotRequest::Action(_) => "action",
            SlotRequest::Provenance(_) => "provenance", _ => return Err(super::invalid("slot.request")) };
        let id = step_id(&ctx.run.id, kind)?;
        let current = ctx.clone(); let selected_id = id.clone(); let selected_request = request.clone();
        let returned = ctx.with_invocation(node.clone(), None, Vec::new(), move |invocation, services| -> StoreFuture<'static, _, CompositionFailure> { Box::pin(async move {
            let result: StoreFuture<'_, _, Error> = Box::pin(async {
                let expected = Call { invocation: invocation.admission().invocation().id.clone(), closure: invocation.lease().closure().clone(),
                    request: selected_request.clone(), observation: None };
                let selected = current.transact(&format!("{kind}.{key}.claim.{}", uuid::Uuid::new_v4()), input.clone(), &["authorization"],
                    move |tx, admission, _, run| Box::pin(async move {
                        let step = match owner::read_step(tx, &run.id, &selected_id).await? {
                            Some(step) if step.kind == kind && step.input_digest == input => step,
                            Some(_) => return Err(super::invalid("slot.step")),
                            None => owner::claim_step(tx, &admission, &run, selected_id, 0, kind, input, &tx.now().await?).await?,
                        };
                        let mut calls = calls(&step.checkpoint)?;
                        if let Some(call) = calls.get(key) {
                            if call.request != expected.request || call.closure != expected.closure { return Err(super::invalid("slot.basis")); }
                            return Ok((call.clone(), false));
                        }
                        calls.insert(key.to_owned(), expected.clone());
                        let mut next = step.clone(); object(&mut next.checkpoint)?.insert("slotCalls".into(), encode(&calls)?);
                        owner::checkpoint_step(tx, &step, next).await?;
                        Ok((expected, true))
                    })).await?;
                let replayed = selected.replayed;
                let (selected, dispatch) = selected.value;
                let outcome = if dispatch && !replayed {
                    Some(invoke_composition_checked(invocation, selected_request, services, |_, request| Ok(request),
                        |_, request, response| check(&current.admission, request, response)).await)
                } else { None };
                Ok::<_, Error>((selected, outcome))
            });
            Ok::<_, CompositionFailure>(result.await)
        }) }).await.map_err(composition_error)??;
        let (mut selected, outcome) = returned;
        if let Some(outcome) = outcome { selected = observe(ctx, kind, key, &id, &selected, outcome).await?; }
        let lock = selected.closure.activation_lock_id.clone(); let admission = ctx.admission.clone();
        let graph = ctx.store.snapshot(ctx.operation.world.clone(), move |snapshot| Box::pin(async move {
            authorization::recheck_read(snapshot, &admission, &snapshot.now().await?).await?;
            Ok::<_, Error>(bindings::read_graph(snapshot, &lock).await?)
        })).await?;
        if selected.request != request || selected.closure.root != node || ctx.run.activation_lock_id.as_ref() != Some(&graph.lock().id) {
            return Err(super::invalid("slot.basis"));
        }
        let inspections: Vec<_> = graph.composition_order(&graph.node(&node).map_err(bindings::BindingError::from)?.binding_id)
            .map_err(bindings::BindingError::from)?.iter().filter_map(|node| ctx.resources.live.inspect_process(&ctx.operation.world, &selected.invocation, node)).collect();
        for inspection in &inspections {
            if !inspection.snapshot().settled || !inspection.closure_settled() {
                tokio::select! { _ = ctx.cancellation.cancelled() => {}, _ = inspection.wait(ctx.deadline.min(ctx.budget.deadline())) => {}, }
            }
        }
        if selected.observation.is_none() {
            if let Some(outcome) = merge_inspected_composition(&graph, &selected.closure, &selected.invocation, &selected.request, &inspections).await.map_err(composition_error)? {
                selected = observe(ctx, kind, key, &id, &selected, Ok(outcome)).await?;
            }
        }
        let observed = selected.observation.as_ref().ok_or_else(retained)?;
        if !observed.settled && (observed.retained.get("nodes").is_none() || !retained_composition_settled(
            &ctx.resources.live, &graph, &selected.closure, &selected.invocation, &observed.retained, &inspections).map_err(composition_error)?) {
            return Err(retained());
        }
        let result: Result<SlotResponse, HostFailure> = if observed.retained.get("nodes").is_some() {
            serde_json::from_value(observed.retained.get("result").cloned().ok_or_else(|| super::invalid("slot.result"))?)
        } else { serde_json::from_value(observed.retained.clone()).map(Err) }.map_err(|cause| super::invalid("slot.result").caused(cause))?;
        if let Err(failure) = result { return Err(Error::from_host_failure(failure, FailureStage::Execute)); }
        replay_composition_checked(&graph, &node, request, &observed.retained, |_, request| Ok(request),
            |_, request, response| check(&ctx.admission, request, response)).map_err(composition_error)
    })
}

fn observe<'a>(ctx: &'a ExecutionContext, kind: &'a str, key: &'static str, id: &'a StepId, selected: &'a Call,
    outcome: Result<CompositionOutcome, CompositionFailure>) -> StoreFuture<'a, Call, Error> {
    Box::pin(async move {
        let (retained, roots, settled) = match outcome {
            Ok(outcome) => (encode(&outcome.retained())?, outcome.retained_roots(&ctx.operation.world)?,
                !ctx.resources.live.invocation_unsettled(&ctx.operation.world, &selected.invocation) && outcome.nodes.iter().all(|node| node.process.as_ref().is_none_or(|process| process.cleanup.is_none()
                    && (process.delivery == crate::extensions::process::Delivery::NotDispatched || process.outcome.as_ref()
                        .is_some_and(|outcome| outcome.terminal != world_protocol::process::TerminalState::Retained))))),
            Err(error) => {
                let failure = error.host_failure(); let mut roots = RetentionRoots::default();
                if let Some(error) = Error::from_host_failure(failure.clone(), FailureStage::Execute).operation_failure() {
                    owner::operation_failure_roots(&ctx.operation.world, &error.details, &mut roots)?;
                }
                (encode(&failure)?, roots, !ctx.resources.live.invocation_unsettled(&ctx.operation.world, &selected.invocation))
            }
        };
        let mut saved = selected.clone(); saved.observation = Some(Observation { retained, roots, settled });
        let maximum = usize::try_from(ctx.budget.remaining(world_protocol::budget::BudgetDimension::Bytes).map_err(|error|
            Error::from_host_failure(HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Execute))?).unwrap_or(usize::MAX);
        let bytes = world_protocol::wire::encode(&saved, maximum).map_err(|cause| super::invalid("slot.observation").caused(cause))?;
        ctx.budget.charge(world_protocol::budget::BudgetDimension::Bytes, bytes.len() as u64).map_err(|error|
            Error::from_host_failure(HostFailure::BudgetExceeded { dimension: error.dimension }, FailureStage::Execute))?;
        let expected = selected.clone(); let id = id.clone(); let usage = ctx.budget.checkpoint_usage();
        Ok(ctx.transact(&format!("{kind}.{key}.observed.{}", canonical_digest(&saved)?.as_str()), canonical_digest(&saved)?, &["authorization"],
            move |tx, _, _, run| Box::pin(async move {
                let step = owner::read_step(tx, &run.id, &id).await?.ok_or_else(|| super::invalid("slot.step"))?;
                let mut calls = calls(&step.checkpoint)?;
                if calls.get(key).map(encode).transpose()? != Some(encode(&expected)?) { return Err(super::invalid("slot.observation")); }
                calls.insert(key.to_owned(), saved.clone());
                let mut next = step.clone(); object(&mut next.checkpoint)?.insert("slotCalls".into(), encode(&calls)?);
                owner::checkpoint_step(tx, &step, next).await?;
                owner::checkpoint_usage(tx, &run, owner::confirmed_usage(&run.usage, usage)?).await?;
                Ok(saved)
            })).await?.value)
    })
}

pub(in crate::owner::workflows) fn retention(step: &owner::StepRecord, roots: &mut RetentionRoots) -> Result<(), Error> {
    for call in calls(&step.checkpoint)?.into_values() {
        roots.resources.extend(call.closure.affected_bindings.into_iter().map(|id| ResourceRef::Binding { id }));
        if let Some(observation) = call.observation { crate::actions::merge_retention_roots(roots, observation.roots); }
    }
    Ok(())
}
fn calls(checkpoint: &serde_json::Value) -> Result<BTreeMap<String, Call>, Error> {
    checkpoint.get("slotCalls").cloned().map(serde_json::from_value).transpose()
        .map(|calls| calls.unwrap_or_default()).map_err(|cause| super::invalid("slot.checkpoint").caused(cause))
}
fn object(value: &mut serde_json::Value) -> Result<&mut serde_json::Map<String, serde_json::Value>, Error> {
    if value.is_null() { *value = serde_json::json!({}); }
    value.as_object_mut().ok_or_else(|| super::invalid("slot.checkpoint"))
}
fn step_id(run: &RunId, kind: &str) -> Result<StepId, Error> {
    StepId::try_new(format!("step-{}", &canonical_digest(&(run, kind))?.as_str()[7..])).map_err(|cause| super::invalid("slot.step").caused(cause))
}
fn encode(value: &impl Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(|cause| super::invalid("slot.observation").caused(cause))
}
fn retained() -> Error { Error::from_host_failure(HostFailure::Process(world_protocol::process::ProcessFailure::Retained), FailureStage::Recover) }
fn composition_error(error: CompositionFailure) -> Error { Error::from_host_failure(error.host_failure(), FailureStage::Execute).caused(error) }
