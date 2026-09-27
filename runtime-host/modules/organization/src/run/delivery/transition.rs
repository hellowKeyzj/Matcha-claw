use crate::{
    ports::EndpointSessionId,
    run::graph::{ExecutionFence, GraphRunId, GraphState, NodeId},
};

use super::{
    AuthorizedGraphOutcome, AuthorizedGraphResolution, Delivery, DeliveryClaim, DeliveryId,
    DeliveryPhase, DeliveryReceipt, DeliveryRequest, DeliveryRequestError,
    NativeDeliveryCorrelation, NativeRunReceiptReference, NativeTerminalStatus, TeamNodeOutput,
    TerminalObservation, TerminalObservationResolution, delivery_retry_at,
};

struct TerminalObservationInput<'a> {
    delivery: &'a Delivery,
    correlation: &'a NativeDeliveryCorrelation,
    observed_session: EndpointSessionId,
    fence: ExecutionFence,
    delivered_receipt: crate::DeliveryReceiptReference,
    native_run_receipt: NativeRunReceiptReference,
    native_terminal: NativeTerminalStatus,
    observed_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryDispatch {
    Recorded,
    Replayed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegisterDeliveryError {
    InvalidRequest(DeliveryRequestError),
    ConflictingDeliveryId { delivery_id: DeliveryId },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryStart {
    Claimed(DeliveryClaim),
    AlreadyClaimed(DeliveryClaim),
    AwaitingRetry { retry_at: u64 },
    Terminal(DeliveryPhase),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryResolution {
    Delivered,
    RetryScheduled { retry_at: u64 },
    Failed,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalObservationOutcome {
    RecordedAwaitingAuthorizedGraphResolution,
    RecordedNodeCancelled,
    Replayed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorizedGraphResolutionOutcome {
    Recorded,
    Replayed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorizedGraphResolutionError {
    DeliveryNotAwaitingAuthorizedResolution,
    DeliveryMismatch,
    RunMismatch,
    NodeMismatch,
    StaleFence,
    GraphStateMismatch,
    OutputPortDoesNotMatchEdge,
    ConflictingResolution,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeRunOutputResolutionError {
    InvalidOutput,
    NativeTerminalNotResolvable,
    AuthorizedResolution(AuthorizedGraphResolutionError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryReceiptError {
    DeliveryMismatch { delivery_id: DeliveryId },
    StaleClaim { delivery_id: DeliveryId },
    NotDelivering { phase: DeliveryPhase },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalObservationError {
    DeliveryMismatch,
    DeliveryNotAccepted,
    RunMismatch,
    NodeMismatch,
    StaleFence,
    SessionMismatch,
    NativeReceiptMismatch,
    ConflictingObservation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryRecovery {
    OutcomeUnknown,
    Unchanged { phase: DeliveryPhase },
}

pub fn register_delivery(
    deliveries: &mut Vec<Delivery>,
    request: DeliveryRequest,
) -> Result<DeliveryDispatch, RegisterDeliveryError> {
    request
        .validate()
        .map_err(RegisterDeliveryError::InvalidRequest)?;

    if deliveries
        .iter()
        .any(|delivery| delivery.facts().idempotency_key == request.idempotency_key)
    {
        return Ok(DeliveryDispatch::Replayed);
    }
    if let Some(existing) = deliveries
        .iter()
        .find(|delivery| delivery.facts().delivery_id == request.delivery_id)
    {
        if existing.facts() == &request {
            return Ok(DeliveryDispatch::Replayed);
        }

        return Err(RegisterDeliveryError::ConflictingDeliveryId {
            delivery_id: request.delivery_id,
        });
    }

    deliveries.push(Delivery::request(request).expect("validated delivery request"));
    Ok(DeliveryDispatch::Recorded)
}

pub fn begin_delivery(delivery: &mut Delivery, now: u64) -> DeliveryStart {
    match delivery.phase().clone() {
        DeliveryPhase::Delivering(claim) => DeliveryStart::AlreadyClaimed(claim),
        DeliveryPhase::RetryScheduled { retry_at, .. } if now < retry_at => {
            DeliveryStart::AwaitingRetry { retry_at }
        }
        DeliveryPhase::Pending | DeliveryPhase::RetryScheduled { .. } => {
            DeliveryStart::Claimed(delivery.start_claim(now))
        }
        phase => DeliveryStart::Terminal(phase),
    }
}

pub fn settle_delivery(
    delivery: &mut Delivery,
    claim: &DeliveryClaim,
    receipt: DeliveryReceipt,
    _retry_at: u64,
) -> Result<DeliveryResolution, DeliveryReceiptError> {
    let active_claim = active_claim_for_delivery_settlement(delivery)?;
    ensure_current_delivery_claim(&active_claim, claim)?;

    Ok(record_delivery_receipt(delivery, receipt))
}

/// Records only a terminal fact already classified by a runtime-native terminal consumer.
///
/// This is crate-private until a verified runtime adapter is composed. Organization deliberately
/// has no public transport or generic native-receipt writer that could forge this source fact.
pub(crate) fn observe_native_terminal(
    delivery: &mut Delivery,
    graph: &mut GraphState,
    observed_session: EndpointSessionId,
    native_run_receipt: NativeRunReceiptReference,
    native_terminal: NativeTerminalStatus,
    observed_at: u64,
) -> Result<TerminalObservationOutcome, TerminalObservationError> {
    let (delivered_receipt, correlation, existing_observation) = match delivery.phase() {
        DeliveryPhase::Delivered {
            receipt,
            native_correlation: Some(correlation),
            ..
        } => (receipt.clone(), correlation.clone(), None),
        DeliveryPhase::Delivered { .. } => {
            return Err(TerminalObservationError::DeliveryNotAccepted);
        }
        DeliveryPhase::TerminalObserved { observation } => (
            observation.delivered_receipt().clone(),
            observation.correlation().clone(),
            Some(observation.clone()),
        ),
        _ => return Err(TerminalObservationError::DeliveryNotAccepted),
    };

    if graph.definition().run_id() != &GraphRunId::new(delivery.facts().run_id.clone()) {
        return Err(TerminalObservationError::RunMismatch);
    }
    if let Some(existing) = existing_observation {
        let observation = terminal_observation(TerminalObservationInput {
            delivery,
            correlation: &correlation,
            observed_session,
            fence: existing.fence().clone(),
            delivered_receipt,
            native_run_receipt,
            native_terminal,
            observed_at,
        })?;
        if !existing.matches_native_fact(&observation) {
            return Err(TerminalObservationError::ConflictingObservation);
        }
        return terminal_observation_matches_graph(graph, &existing)
            .then_some(TerminalObservationOutcome::Replayed)
            .ok_or(TerminalObservationError::StaleFence);
    }

    let node_id = NodeId::new(delivery.facts().node_id.clone());
    let history = graph
        .executions()
        .get(&node_id)
        .ok_or(TerminalObservationError::NodeMismatch)?;
    let attempt = history
        .attempts()
        .iter()
        .find(|attempt| {
            attempt.fence().node_execution_id().as_str() == delivery.facts().node_execution_id
        })
        .ok_or(TerminalObservationError::StaleFence)?;
    let current_fence = attempt.fence().clone();
    let superseded = history.current().fence() != &current_fence;
    if superseded
        && !matches!(
            attempt.status(),
            crate::AttemptStatus::Ready
                | crate::AttemptStatus::Running
                | crate::AttemptStatus::Waiting
        )
    {
        return Err(TerminalObservationError::StaleFence);
    }
    let observation = terminal_observation(TerminalObservationInput {
        delivery,
        correlation: &correlation,
        observed_session,
        fence: current_fence,
        delivered_receipt,
        native_run_receipt,
        native_terminal,
        observed_at,
    })?;
    let event = match native_terminal {
        NativeTerminalStatus::Cancelled => crate::GraphEvent::NodeCancelled {
            node_id,
            fence: observation.fence().clone(),
            cancelled_at: observed_at,
        },
        NativeTerminalStatus::Completed
        | NativeTerminalStatus::Failed
        | NativeTerminalStatus::Interrupted => crate::GraphEvent::NodeWaiting {
            node_id,
            fence: observation.fence().clone(),
            waiting_at: observed_at,
        },
    };
    let reduced = if superseded {
        if native_terminal == NativeTerminalStatus::Cancelled {
            crate::run::graph::settle_superseded_attempt(graph.clone(), event)
        } else {
            // The native fact is durable, but only its authorized output can settle history.
            Ok(graph.clone())
        }
    } else {
        crate::reduce(graph.clone(), event)
    }
    .map_err(|error| match error {
        crate::ReduceError::UnknownNode(_) => TerminalObservationError::NodeMismatch,
        _ => TerminalObservationError::StaleFence,
    })?;

    let outcome = match observation.resolution() {
        TerminalObservationResolution::AwaitingAuthorizedGraphResolution => {
            TerminalObservationOutcome::RecordedAwaitingAuthorizedGraphResolution
        }
        TerminalObservationResolution::NodeCancelled => {
            TerminalObservationOutcome::RecordedNodeCancelled
        }
        TerminalObservationResolution::GraphResolved(_) => {
            unreachable!("a newly recorded terminal observation cannot already be graph-resolved")
        }
    };
    delivery.mark_terminal_observed(observation);
    *graph = reduced;
    Ok(outcome)
}

fn terminal_observation_matches_graph(
    graph: &GraphState,
    observation: &TerminalObservation,
) -> bool {
    let node_id = NodeId::new(observation.node_id().to_owned());
    let Some(history) = graph.executions().get(&node_id) else {
        return false;
    };
    let Some(attempt) = history
        .attempts()
        .iter()
        .find(|attempt| attempt.fence() == observation.fence())
    else {
        return false;
    };
    match observation.resolution() {
        TerminalObservationResolution::AwaitingAuthorizedGraphResolution => {
            let current = history.current().fence() == observation.fence();
            (attempt.status() == crate::AttemptStatus::Waiting
                || (!current
                    && matches!(
                        attempt.status(),
                        crate::AttemptStatus::Ready | crate::AttemptStatus::Running
                    )))
                && attempt.output_port().is_none()
        }
        TerminalObservationResolution::NodeCancelled => {
            attempt.status() == crate::AttemptStatus::Cancelled && attempt.output_port().is_none()
        }
        TerminalObservationResolution::GraphResolved(resolution) => {
            resolution.delivery_id() == observation.delivery_id()
                && resolution.graph_run_id() == observation.graph_run_id()
                && resolution.fence() == observation.fence()
                && resolution.resolved_at() >= observation.observed_at()
                && graph_matches_resolution(attempt, resolution)
        }
    }
}

pub(crate) fn resolve_native_run_output(
    delivery: &mut Delivery,
    graph: &mut GraphState,
    receipt: crate::AuthorizedGraphResolutionReceipt,
    output: TeamNodeOutput,
    resolved_at: u64,
) -> Result<AuthorizedGraphResolutionOutcome, NativeRunOutputResolutionError> {
    let observation = match delivery.phase() {
        DeliveryPhase::TerminalObserved { observation } => observation.clone(),
        _ => {
            return Err(NativeRunOutputResolutionError::AuthorizedResolution(
                AuthorizedGraphResolutionError::DeliveryNotAwaitingAuthorizedResolution,
            ));
        }
    };
    let outcome = match observation.native_terminal() {
        NativeTerminalStatus::Completed => AuthorizedGraphOutcome::Completed,
        NativeTerminalStatus::Failed | NativeTerminalStatus::Interrupted => {
            AuthorizedGraphOutcome::Failed
        }
        NativeTerminalStatus::Cancelled => {
            return Err(NativeRunOutputResolutionError::NativeTerminalNotResolvable);
        }
    };
    let resolution = AuthorizedGraphResolution::new(
        receipt,
        observation.delivery_id().clone(),
        observation.graph_run_id(),
        observation.fence().clone(),
        outcome,
        output.decision(),
        resolved_at,
    )
    .map_err(|_| NativeRunOutputResolutionError::InvalidOutput)?;
    resolve_authorized_graph_outcome_with_output(delivery, graph, Some(output), resolution)
        .map_err(NativeRunOutputResolutionError::AuthorizedResolution)
}

pub(crate) fn resolve_authorized_graph_outcome(
    delivery: &mut Delivery,
    graph: &mut GraphState,
    resolution: AuthorizedGraphResolution,
) -> Result<AuthorizedGraphResolutionOutcome, AuthorizedGraphResolutionError> {
    resolve_authorized_graph_outcome_with_output(delivery, graph, None, resolution)
}

fn resolve_authorized_graph_outcome_with_output(
    delivery: &mut Delivery,
    graph: &mut GraphState,
    output: Option<TeamNodeOutput>,
    resolution: AuthorizedGraphResolution,
) -> Result<AuthorizedGraphResolutionOutcome, AuthorizedGraphResolutionError> {
    let observation = match delivery.phase() {
        DeliveryPhase::TerminalObserved { observation } => observation.clone(),
        _ => return Err(AuthorizedGraphResolutionError::DeliveryNotAwaitingAuthorizedResolution),
    };
    if resolution.delivery_id() != observation.delivery_id() {
        return Err(AuthorizedGraphResolutionError::DeliveryMismatch);
    }
    if resolution.graph_run_id() != observation.graph_run_id()
        || graph.definition().run_id().as_str() != observation.graph_run_id()
    {
        return Err(AuthorizedGraphResolutionError::RunMismatch);
    }
    if resolution.fence() != observation.fence() {
        return Err(AuthorizedGraphResolutionError::StaleFence);
    }
    if resolution.resolved_at() < observation.observed_at() {
        return Err(AuthorizedGraphResolutionError::GraphStateMismatch);
    }
    let node_id = NodeId::new(observation.node_id().to_owned());
    let history = graph
        .executions()
        .get(&node_id)
        .ok_or(AuthorizedGraphResolutionError::NodeMismatch)?;
    let attempt = history
        .attempts()
        .iter()
        .find(|attempt| attempt.fence() == observation.fence())
        .ok_or(AuthorizedGraphResolutionError::StaleFence)?;
    match observation.resolution() {
        TerminalObservationResolution::GraphResolved(existing) => {
            let replay = if resolution.outcome() == AuthorizedGraphOutcome::Completed
                && existing.outcome() == AuthorizedGraphOutcome::Failed
                && resolution.output_port() == "rework"
            {
                resolution
                    .clone()
                    .with_outcome(AuthorizedGraphOutcome::Failed)
            } else {
                resolution.clone()
            };
            if existing != &replay
                || output
                    .as_ref()
                    .is_some_and(|output| Some(output) != observation.output())
            {
                return Err(AuthorizedGraphResolutionError::ConflictingResolution);
            }
            return graph_matches_resolution(attempt, existing)
                .then_some(AuthorizedGraphResolutionOutcome::Replayed)
                .ok_or(AuthorizedGraphResolutionError::GraphStateMismatch);
        }
        TerminalObservationResolution::AwaitingAuthorizedGraphResolution => {}
        TerminalObservationResolution::NodeCancelled => {
            return Err(AuthorizedGraphResolutionError::DeliveryNotAwaitingAuthorizedResolution);
        }
    }
    let current = graph
        .current_attempt(&node_id)
        .ok_or(AuthorizedGraphResolutionError::NodeMismatch)?;
    let superseded = current.fence() != observation.fence();
    if attempt.output_port().is_some()
        || !(attempt.status() == crate::AttemptStatus::Waiting
            || (superseded
                && matches!(
                    attempt.status(),
                    crate::AttemptStatus::Ready | crate::AttemptStatus::Running
                )))
    {
        return Err(AuthorizedGraphResolutionError::GraphStateMismatch);
    }
    if resolution.outcome() == AuthorizedGraphOutcome::Completed {
        require_source_port_routes_or_terminal(graph, &node_id, resolution.output_port())?;
    }
    let event = match resolution.outcome() {
        AuthorizedGraphOutcome::Completed => crate::GraphEvent::NodeCompleted {
            node_id,
            fence: observation.fence().clone(),
            output_port: resolution.output_port().to_owned(),
            completed_at: resolution.resolved_at(),
        },
        AuthorizedGraphOutcome::Failed => crate::GraphEvent::NodeFailed {
            node_id,
            fence: observation.fence().clone(),
            output_port: resolution.output_port().to_owned(),
            failed_at: resolution.resolved_at(),
        },
    };
    let reduced = if superseded {
        crate::run::graph::settle_superseded_attempt(graph.clone(), event)
    } else {
        crate::reduce(graph.clone(), event)
    }
    .map_err(|error| match error {
        crate::ReduceError::StaleFence { .. } => AuthorizedGraphResolutionError::StaleFence,
        crate::ReduceError::UnknownNode(_) => AuthorizedGraphResolutionError::NodeMismatch,
        _ => AuthorizedGraphResolutionError::GraphStateMismatch,
    })?;
    let settled = reduced.executions()[&NodeId::new(observation.node_id())]
        .attempts()
        .iter()
        .find(|attempt| attempt.fence() == resolution.fence())
        .ok_or(AuthorizedGraphResolutionError::StaleFence)?;
    let effective_outcome = match settled.status() {
        crate::AttemptStatus::Completed => AuthorizedGraphOutcome::Completed,
        crate::AttemptStatus::Failed => AuthorizedGraphOutcome::Failed,
        _ => return Err(AuthorizedGraphResolutionError::GraphStateMismatch),
    };
    let resolution = resolution.with_outcome(effective_outcome);
    let DeliveryPhase::TerminalObserved { observation } = &mut delivery.phase else {
        unreachable!("delivery phase was matched before graph reduction")
    };
    observation.resolve_graph(output, resolution);
    *graph = reduced;
    Ok(AuthorizedGraphResolutionOutcome::Recorded)
}

fn require_source_port_routes_or_terminal(
    graph: &GraphState,
    node_id: &NodeId,
    output_port: &str,
) -> Result<(), AuthorizedGraphResolutionError> {
    let mut outgoing = graph.definition().outgoing_edges(node_id);
    match outgoing.next() {
        None => Ok(()),
        Some(first) if first.source_port() == output_port => Ok(()),
        Some(_) if outgoing.any(|edge| edge.source_port() == output_port) => Ok(()),
        Some(_) => Err(AuthorizedGraphResolutionError::OutputPortDoesNotMatchEdge),
    }
}

fn graph_matches_resolution(
    attempt: &crate::NodeAttempt,
    resolution: &AuthorizedGraphResolution,
) -> bool {
    attempt.output_port() == Some(resolution.output_port())
        && matches!(
            (resolution.outcome(), attempt.status()),
            (
                AuthorizedGraphOutcome::Completed,
                crate::AttemptStatus::Completed
            ) | (AuthorizedGraphOutcome::Failed, crate::AttemptStatus::Failed)
        )
}

fn terminal_observation(
    input: TerminalObservationInput<'_>,
) -> Result<TerminalObservation, TerminalObservationError> {
    if input.correlation.endpoint_session_id() != &input.observed_session {
        return Err(TerminalObservationError::SessionMismatch);
    }
    if input.correlation.native_run_receipt() != &input.native_run_receipt {
        return Err(TerminalObservationError::NativeReceiptMismatch);
    }
    if input.fence.node_execution_id().as_str() != input.delivery.facts().node_execution_id {
        return Err(TerminalObservationError::StaleFence);
    }
    let resolution = match input.native_terminal {
        NativeTerminalStatus::Cancelled => TerminalObservationResolution::NodeCancelled,
        NativeTerminalStatus::Completed
        | NativeTerminalStatus::Failed
        | NativeTerminalStatus::Interrupted => {
            TerminalObservationResolution::AwaitingAuthorizedGraphResolution
        }
    };
    Ok(TerminalObservation::new(
        input.delivery.facts(),
        input.fence,
        input.correlation,
        input.delivered_receipt,
        input.native_terminal,
        input.observed_at,
        resolution,
    ))
}

pub fn recover_interrupted_delivery(delivery: &mut Delivery, observed_at: u64) -> DeliveryRecovery {
    if delivery.active_claim().is_some() {
        record_delivery_outcome_unknown_without_retry(delivery, observed_at);
        return DeliveryRecovery::OutcomeUnknown;
    }

    DeliveryRecovery::Unchanged {
        phase: delivery.phase().clone(),
    }
}

fn active_claim_for_delivery_settlement(
    delivery: &Delivery,
) -> Result<DeliveryClaim, DeliveryReceiptError> {
    delivery
        .active_claim()
        .cloned()
        .ok_or_else(|| DeliveryReceiptError::NotDelivering {
            phase: delivery.phase().clone(),
        })
}

fn ensure_current_delivery_claim(
    active_claim: &DeliveryClaim,
    submitted_claim: &DeliveryClaim,
) -> Result<(), DeliveryReceiptError> {
    if active_claim == submitted_claim {
        Ok(())
    } else {
        Err(DeliveryReceiptError::StaleClaim {
            delivery_id: submitted_claim.delivery_id().clone(),
        })
    }
}

fn record_delivery_receipt(
    delivery: &mut Delivery,
    receipt: DeliveryReceipt,
) -> DeliveryResolution {
    match receipt {
        DeliveryReceipt::Accepted {
            receipt,
            native_correlation,
            accepted_at,
        } => {
            delivery.mark_delivered(receipt, native_correlation, accepted_at);
            DeliveryResolution::Delivered
        }
        DeliveryReceipt::Rejected {
            failure,
            observed_at,
        } if failure.is_retryable() => {
            schedule_delivery_retry_or_fail(delivery, observed_at, failure)
        }
        DeliveryReceipt::Rejected {
            failure,
            observed_at,
        } => {
            delivery.mark_failed(observed_at, failure);
            DeliveryResolution::Failed
        }
        DeliveryReceipt::OutcomeUnknown { observed_at } => {
            record_delivery_outcome_unknown_without_retry(delivery, observed_at);
            DeliveryResolution::OutcomeUnknown
        }
    }
}

fn schedule_delivery_retry_or_fail(
    delivery: &mut Delivery,
    observed_at: u64,
    failure: super::DeliveryFailure,
) -> DeliveryResolution {
    let retry_at = delivery_retry_at(observed_at);
    if delivery.schedule_retry(retry_at, observed_at, failure) {
        DeliveryResolution::RetryScheduled { retry_at }
    } else {
        DeliveryResolution::Failed
    }
}

fn record_delivery_outcome_unknown_without_retry(delivery: &mut Delivery, observed_at: u64) {
    delivery.mark_outcome_unknown(observed_at);
}
