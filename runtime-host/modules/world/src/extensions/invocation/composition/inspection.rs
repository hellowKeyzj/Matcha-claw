use std::sync::Arc;

use serde::Deserialize;
use world_protocol::{
    bindings::{Entrypoint, ExactClosure},
    ids::InvocationId,
    process::{CallResult, HostFailure},
};

use super::*;
use crate::extensions::{
    bindings::BindingGraph, lifecycle::LiveExtensions, process::ProcessInspection,
};

fn matches_original(
    inspection: &ProcessInspection,
    graph: &BindingGraph,
    closure: &ExactClosure,
    invocation: &InvocationId,
) -> bool {
    let context = inspection.context();
    context.lease().invocation() == invocation
        && context.lease().graph().lock() == graph.lock()
        && context.lease().closure() == closure
        && closure.nodes.contains(context.node())
}

/// Recover only outcomes still held by their original process calls, never new calls.
/// Missing custody or a member without an original process receipt remains unknown.
pub(crate) async fn merge_inspected_composition(
    graph: &BindingGraph,
    closure: &ExactClosure,
    invocation: &InvocationId,
    request: &SlotRequest,
    inspections: &[ProcessInspection],
) -> Result<Option<CompositionOutcome>, CompositionFailure> {
    let selected = graph.node(&closure.root).map_err(binding_failure)?;
    let composition = graph
        .composition(&selected.binding_id)
        .map_err(binding_failure)?;
    let order = graph
        .composition_order(&selected.binding_id)
        .map_err(binding_failure)?;
    let invalid = || CompositionFailure::Incomplete {
        nodes: order.clone(),
    };
    if closure.activation_lock_id != graph.lock().id
        || !matches!(selected.slot, SlotKind::Evaluation | SlotKind::Context | SlotKind::Identity | SlotKind::Abstraction | SlotKind::Policy | SlotKind::Action | SlotKind::Provenance)
        || selected.slot != slots::request_slot(request)
        || inspections
            .iter()
            .any(|inspection| !matches_original(inspection, graph, closure, invocation))
        || inspections.iter().enumerate().any(|(index, inspection)| {
            inspections[..index]
                .iter()
                .any(|previous| previous.context().node() == inspection.context().node())
        })
    {
        return Err(invalid());
    }
    if inspections.len() != order.len() || inspections.is_empty() {
        return Ok(None);
    }
    if inspections.iter().any(|inspection| {
        !Arc::ptr_eq(
            inspection.context().lease(),
            inspections[0].context().lease(),
        )
    }) {
        return Err(invalid());
    }
    let mut nodes = Vec::with_capacity(order.len());
    for node in &order {
        let Some(inspection) = inspections
            .iter()
            .find(|inspection| inspection.context().node() == node)
        else {
            return Ok(None);
        };
        let member = graph.node(node).map_err(binding_failure)?;
        if !matches!(
            &member.implementation.entrypoint,
            Entrypoint::Process { .. }
        ) || member.slot != slots::request_slot(request)
            || inspection.request() != &wired_request(composition, node, request, &nodes)?
        {
            return Err(invalid());
        }
        let snapshot = inspection.snapshot();
        if !snapshot.settled || !inspection.closure_settled() {
            return Ok(None);
        }
        let Some(outcome) = snapshot.outcome else {
            return Ok(None);
        };
        let result = if let Some(error) = snapshot.failure {
            Err(CompositionFailure::Invocation(InvocationFailure::Process(
                error,
            )))
        } else if !snapshot.streams_consumed {
            Err(CompositionFailure::Invocation(InvocationFailure::Process(
                Arc::new(ProcessError::StreamsPending),
            )))
        } else if let Err(error) = inspection.check_output().await {
            Err(CompositionFailure::Invocation(InvocationFailure::Process(
                error,
            )))
        } else if let Some(error) = &snapshot.host_failure {
            // The private original remains in ProcessOutcome; do not mint a replacement diagnostic.
            Err(CompositionFailure::Invocation(InvocationFailure::Process(
                Arc::new(ProcessError::HostImport(error.clone())),
            )))
        } else if outcome.terminal != TerminalState::Completed {
            match outcome.result.as_ref().map(|result| &result.result) {
                Some(Err(error)) => Err(CompositionFailure::Slot(error.details.clone())),
                _ => Err(CompositionFailure::ProcessTerminal(outcome.terminal)),
            }
        } else {
            match outcome.result.as_ref().map(|result| &result.result) {
                Some(Ok(response)) => Ok(response.clone()),
                Some(Err(error)) => Err(CompositionFailure::Slot(error.details.clone())),
                None => Err(CompositionFailure::ProcessResultMissing),
            }
        };
        nodes.push(CompositionNode {
            node: node.clone(),
            result,
            proposal: None,
            host_failures: Vec::new(),
            process: Some(ProcessEvidence {
                outcome: Some(outcome),
                received_result: snapshot.received_result.map(Arc::new),
                delivery: snapshot.delivery,
                chunks: Vec::new(),
                cleanup: None,
            }),
        });
    }
    let mut result = merge_complete(composition, request, &nodes);
    let context = inspections[0].context();
    if result.is_ok() {
        for node in &closure.nodes {
            let child = context.with_node(node.clone()).map_err(current_failure)?;
            if let Err(error) = child.check_current().await {
                result = Err(current_failure(error));
                break;
            }
        }
        if result.is_ok() {
            if let Err(error) = context.check_output(1).await {
                result = Err(CompositionFailure::Invocation(InvocationFailure::Output(
                    error,
                )));
            }
        }
    }
    if let Err(error) = context.budget().check() {
        if result.is_ok() {
            result = Err(CompositionFailure::Invocation(InvocationFailure::Budget(
                error,
            )));
        }
    }
    Ok(Some(CompositionOutcome {
        binding: selected.binding_id.clone(),
        result,
        nodes,
        usage: inspections[0].context().budget().usage(),
    }))
}

/// Checks settlement only. The caller preserves the original durable result and failures.
pub(crate) fn retained_composition_settled(
    live: &LiveExtensions,
    graph: &BindingGraph,
    closure: &ExactClosure,
    invocation: &InvocationId,
    observation: &serde_json::Value,
    inspections: &[ProcessInspection],
) -> Result<bool, CompositionFailure> {
    retained_composition_settled_in_scope(live, graph, closure, invocation, observation, inspections, false)
}

/// Identity can share its invocation with a source parent outside its original closure.
/// This never establishes that the parent or the whole invocation can be released.
pub(crate) fn retained_composition_closure_settled(
    live: &LiveExtensions,
    graph: &BindingGraph,
    closure: &ExactClosure,
    invocation: &InvocationId,
    observation: &serde_json::Value,
    inspections: &[ProcessInspection],
) -> Result<bool, CompositionFailure> {
    retained_composition_settled_in_scope(live, graph, closure, invocation, observation, inspections, true)
}

fn retained_composition_settled_in_scope(
    live: &LiveExtensions,
    graph: &BindingGraph,
    closure: &ExactClosure,
    invocation: &InvocationId,
    observation: &serde_json::Value,
    inspections: &[ProcessInspection],
    closure_only: bool,
) -> Result<bool, CompositionFailure> {
    #[derive(Deserialize)]
    struct Observation {
        binding: BindingId,
        #[serde(rename = "result")]
        _result: Result<SlotResponse, HostFailure>,
        nodes: Vec<Node>,
        #[serde(rename = "usage")]
        _usage: Usage,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Node {
        node: NodeId,
        result: Result<SlotResponse, HostFailure>,
        proposal: Option<SlotResponse>,
        process: Option<Process>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Process {
        outcome: Option<Observed>,
        received_result: Option<CallResult>,
        delivery: String,
        cleanup: Option<HostFailure>,
    }
    #[derive(Deserialize)]
    struct Observed {
        result: Option<CallResult>,
        terminal: TerminalState,
        delivery: String,
    }

    let selected = graph.node(&closure.root).map_err(binding_failure)?;
    let order = graph
        .composition_order(&selected.binding_id)
        .map_err(binding_failure)?;
    let invalid = || CompositionFailure::Incomplete {
        nodes: order.clone(),
    };
    let observed: Observation = serde_json::from_value(observation.clone())
        .map_err(|error| CompositionFailure::Invocation(InvocationFailure::Meter(error)))?;
    if closure.activation_lock_id != graph.lock().id
        || !matches!(selected.slot, SlotKind::Evaluation | SlotKind::Context | SlotKind::Identity | SlotKind::Abstraction | SlotKind::Policy | SlotKind::Action | SlotKind::Provenance)
        || closure_only && selected.slot != SlotKind::Identity
        || observed.binding != selected.binding_id
        || observed.nodes.len() != order.len()
        || observed
            .nodes
            .iter()
            .zip(&order)
            .any(|(node, expected)| &node.node != expected)
        || inspections.iter().any(|inspection| {
            !matches_original(inspection, graph, closure, invocation)
                || !order.contains(inspection.context().node())
        })
        || inspections.iter().enumerate().any(|(index, inspection)| {
            inspections[..index]
                .iter()
                .any(|previous| previous.context().node() == inspection.context().node())
        })
    {
        return Err(invalid());
    }
    for node in observed.nodes {
        let member = graph.node(&node.node).map_err(binding_failure)?;
        let inspection = inspections
            .iter()
            .find(|inspection| inspection.context().node() == &node.node);
        match (&member.implementation.entrypoint, node.process) {
            (Entrypoint::Process { .. }, Some(process)) => {
                if !matches!(
                    process.delivery.as_str(),
                    "not_dispatched" | "attempted" | "accepted" | "terminal"
                ) {
                    return Err(invalid());
                }
                if let Some(outcome) = &process.outcome {
                    if outcome.delivery != "terminal"
                        || process.delivery != "terminal"
                        || process
                            .received_result
                            .as_ref()
                            .is_some_and(|received| outcome.result.as_ref() != Some(received))
                        || matches!(
                            outcome.terminal,
                            TerminalState::Completed | TerminalState::Failed
                        ) && outcome.result.is_none()
                        || outcome.terminal == TerminalState::Completed
                            && outcome
                                .result
                                .as_ref()
                                .is_some_and(|result| result.result.is_err())
                        || outcome.terminal == TerminalState::Failed
                            && outcome
                                .result
                                .as_ref()
                                .is_some_and(|result| result.result.is_ok())
                    {
                        return Err(invalid());
                    }
                }
                if let Ok(result) = &node.result {
                    let proposal = node.proposal.as_ref().unwrap_or(result);
                    if process.outcome.as_ref().is_none_or(|outcome| {
                        outcome.terminal != TerminalState::Completed
                            || outcome
                                .result
                                .as_ref()
                                .and_then(|result| result.result.as_ref().ok())
                                != Some(proposal)
                    }) {
                        return Err(invalid());
                    }
                }
                let historical = process.cleanup.is_none()
                    && (process.delivery == "not_dispatched"
                        || process
                            .outcome
                            .as_ref()
                            .is_some_and(|outcome| outcome.terminal != TerminalState::Retained));
                match inspection {
                    Some(inspection) => {
                        let snapshot = inspection.snapshot();
                        if !snapshot.settled || !inspection.closure_settled() {
                            return Ok(false);
                        }
                        if let Some(outcome) = &process.outcome {
                            if snapshot.outcome.as_ref().is_none_or(|current| {
                                current.terminal != outcome.terminal
                                    || current.result != outcome.result
                            }) {
                                return Err(invalid());
                            }
                        }
                        if process.received_result.as_ref().is_some_and(|received| {
                            snapshot.received_result.as_ref() != Some(received)
                        }) {
                            return Err(invalid());
                        }
                    }
                    None if historical => {}
                    None => return Ok(false),
                }
            }
            (Entrypoint::Process { .. }, None) if node.result.is_err() => {
                if let Some(inspection) = inspection {
                    if !inspection.snapshot().settled || !inspection.closure_settled() {
                        return Ok(false);
                    }
                }
            }
            (Entrypoint::Native { .. } | Entrypoint::Wasm { .. }, None) => {}
            _ => return Err(invalid()),
        }
    }
    Ok(if closure_only {
        live.invocation_closure_settled(graph, closure, invocation)
    } else {
        !live.invocation_unsettled(&graph.lock().world, invocation)
    })
}
