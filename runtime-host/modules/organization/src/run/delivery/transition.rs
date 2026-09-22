use crate::{
    ports::{
        DeliveryReference, DeliveryRejection, EndpointSessionId, IdempotencyKey,
        PromptDeliveryOutcome, PromptDeliveryPort, PromptDeliveryRequest, PromptDispatchPayload,
        RoleSessionReceipt,
    },
    run::graph::{ExecutionFence, GraphRunId, GraphState, NodeId},
};

use super::{
    AuthorizedGraphOutcome, AuthorizedGraphResolution, Delivery, DeliveryClaim, DeliveryFailure,
    DeliveryId, DeliveryPhase, DeliveryReceipt, DeliveryRequest, DeliveryRequestError,
    NativeDeliveryCorrelation, NativeRunReceiptReference, NativeTerminalStatus, TeamNodeOutput,
    TeamNodeOutputError, TerminalObservation, TerminalObservationResolution, delivery_retry_at,
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
    let active_claim =
        delivery
            .active_claim()
            .ok_or_else(|| DeliveryReceiptError::NotDelivering {
                phase: delivery.phase().clone(),
            })?;

    if active_claim != claim {
        return Err(DeliveryReceiptError::StaleClaim {
            delivery_id: claim.delivery_id().clone(),
        });
    }

    match receipt {
        DeliveryReceipt::Accepted {
            receipt,
            native_correlation,
            accepted_at,
        } => {
            delivery.mark_delivered(receipt, native_correlation, accepted_at);
            Ok(DeliveryResolution::Delivered)
        }
        DeliveryReceipt::Rejected {
            failure,
            observed_at,
        } if failure.is_retryable() => {
            let retry_at = delivery_retry_at(observed_at);
            if delivery.schedule_retry(retry_at, observed_at, failure) {
                Ok(DeliveryResolution::RetryScheduled { retry_at })
            } else {
                Ok(DeliveryResolution::Failed)
            }
        }
        DeliveryReceipt::Rejected {
            failure,
            observed_at,
        } => {
            delivery.mark_failed(observed_at, failure);
            Ok(DeliveryResolution::Failed)
        }
        DeliveryReceipt::OutcomeUnknown { observed_at } => {
            delivery.mark_outcome_unknown(observed_at);
            Ok(DeliveryResolution::OutcomeUnknown)
        }
    }
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
    let current = graph
        .current_attempt(&node_id)
        .ok_or(TerminalObservationError::NodeMismatch)?;
    let current_fence = current.fence().clone();
    if current_fence.node_execution_id().as_str() != delivery.facts().node_execution_id {
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
    let reduced = crate::reduce(graph.clone(), event).map_err(|error| match error {
        crate::ReduceError::StaleFence { .. } => TerminalObservationError::StaleFence,
        crate::ReduceError::UnknownNode(_) => TerminalObservationError::NodeMismatch,
        crate::ReduceError::InvalidTransition { .. }
        | crate::ReduceError::TriggerNotArmed(_)
        | crate::ReduceError::AttemptLimitExceeded { .. }
        | crate::ReduceError::StaleGraphIdentity
        | crate::ReduceError::InvalidGraphPatch => TerminalObservationError::StaleFence,
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
            graph
                .current_attempt(&node_id)
                .is_some_and(|current| current.fence() == observation.fence())
                && attempt.status() == crate::AttemptStatus::Waiting
                && attempt.output_port().is_none()
        }
        TerminalObservationResolution::NodeCancelled => {
            graph
                .current_attempt(&node_id)
                .is_some_and(|current| current.fence() == observation.fence())
                && attempt.status() == crate::AttemptStatus::Cancelled
                && attempt.output_port().is_none()
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
    final_assistant_text: String,
    resolved_at: u64,
) -> Result<AuthorizedGraphResolutionOutcome, NativeRunOutputResolutionError> {
    let output = TeamNodeOutput::parse(final_assistant_text).map_err(|error| match error {
        TeamNodeOutputError::MissingEnvelope
        | TeamNodeOutputError::InvalidJson
        | TeamNodeOutputError::MissingField(_)
        | TeamNodeOutputError::UnexpectedField(_)
        | TeamNodeOutputError::InvalidField(_)
        | TeamNodeOutputError::InvalidSummary
        | TeamNodeOutputError::UnsafeOutputPort => NativeRunOutputResolutionError::InvalidOutput,
    })?;
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
        output.output_port(),
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
            if existing != &resolution
                || output
                    .as_ref()
                    .is_some_and(|output| Some(output) != observation.output())
            {
                return Err(AuthorizedGraphResolutionError::ConflictingResolution);
            }
            return graph_matches_resolution(attempt, &resolution)
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
    if current.fence() != observation.fence() {
        return Err(AuthorizedGraphResolutionError::StaleFence);
    }
    if current.status() != crate::AttemptStatus::Waiting || current.output_port().is_some() {
        return Err(AuthorizedGraphResolutionError::GraphStateMismatch);
    }
    require_output_port_routes_or_terminal(graph, &node_id, resolution.output_port())?;
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
    let reduced = crate::reduce(graph.clone(), event).map_err(|error| match error {
        crate::ReduceError::StaleFence { .. } => AuthorizedGraphResolutionError::StaleFence,
        crate::ReduceError::UnknownNode(_) => AuthorizedGraphResolutionError::NodeMismatch,
        crate::ReduceError::InvalidTransition { .. }
        | crate::ReduceError::TriggerNotArmed(_)
        | crate::ReduceError::AttemptLimitExceeded { .. }
        | crate::ReduceError::StaleGraphIdentity
        | crate::ReduceError::InvalidGraphPatch => {
            AuthorizedGraphResolutionError::GraphStateMismatch
        }
    })?;
    let DeliveryPhase::TerminalObserved { observation } = &mut delivery.phase else {
        unreachable!("delivery phase was matched before graph reduction")
    };
    observation.resolve_graph(output, resolution);
    *graph = reduced;
    Ok(AuthorizedGraphResolutionOutcome::Recorded)
}

fn require_output_port_routes_or_terminal(
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
        delivery.mark_outcome_unknown(observed_at);
        return DeliveryRecovery::OutcomeUnknown;
    }

    DeliveryRecovery::Unchanged {
        phase: delivery.phase().clone(),
    }
}

pub fn dispatch_delivery<P: PromptDeliveryPort>(
    delivery: &mut Delivery,
    claim: &DeliveryClaim,
    binding: RoleSessionReceipt,
    payload: PromptDispatchPayload,
    observed_at: u64,
    retry_at: u64,
    port: &mut P,
) -> Result<DeliveryResolution, DeliveryReceiptError> {
    let active_claim =
        delivery
            .active_claim()
            .ok_or_else(|| DeliveryReceiptError::NotDelivering {
                phase: delivery.phase().clone(),
            })?;
    if active_claim != claim {
        return Err(DeliveryReceiptError::StaleClaim {
            delivery_id: claim.delivery_id().clone(),
        });
    }

    let delivery_reference = DeliveryReference::try_new(claim.delivery_id().as_str())
        .expect("a validated delivery identity must be a valid delivery reference");
    let idempotency_key = IdempotencyKey::try_new(delivery.facts().idempotency_key.clone())
        .expect("a validated delivery idempotency key must be a valid idempotency key");
    let request = PromptDeliveryRequest::new(delivery_reference, binding, idempotency_key, payload);

    let receipt = match port.deliver(request) {
        Ok(PromptDeliveryOutcome::Delivered { receipt }) => DeliveryReceipt::Accepted {
            receipt,
            native_correlation: None,
            accepted_at: observed_at,
        },
        Ok(PromptDeliveryOutcome::Rejected {
            rejection: DeliveryRejection::Permanent,
        }) => DeliveryReceipt::Rejected {
            failure: DeliveryFailure::PolicyRejected,
            observed_at,
        },
        Ok(PromptDeliveryOutcome::Rejected {
            rejection: DeliveryRejection::Retryable,
        }) => DeliveryReceipt::Rejected {
            failure: DeliveryFailure::Unavailable,
            observed_at,
        },
        Ok(PromptDeliveryOutcome::OutcomeUnknown) | Err(_) => {
            DeliveryReceipt::OutcomeUnknown { observed_at }
        }
    };

    settle_delivery(delivery, claim, receipt, retry_at)
}
