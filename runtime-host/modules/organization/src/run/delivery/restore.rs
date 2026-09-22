use std::fmt;

use crate::{ports::DeliveryReceiptReference, run::graph::ExecutionFence};

use super::{
    Delivery, DeliveryClaim, DeliveryFailure, DeliveryId, DeliveryPhase, DeliveryRequest,
    DeliveryRequestError, NativeDeliveryCorrelation, NativeTerminalStatus, TeamNodeOutput,
    TerminalObservation, TerminalObservationResolution,
};

#[derive(Clone, Eq, PartialEq)]
pub struct DeliverySnapshot {
    facts: DeliveryRequest,
    phase: DeliveryPhaseSnapshot,
    completed_attempts: u32,
    next_claim_generation: u64,
}

impl fmt::Debug for DeliverySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeliverySnapshot")
            .field("facts", &self.facts)
            .field("phase", &self.phase)
            .field("completed_attempts", &self.completed_attempts)
            .field("next_claim_generation", &self.next_claim_generation)
            .finish()
    }
}

impl DeliverySnapshot {
    pub(crate) fn new(
        facts: DeliveryRequest,
        phase: DeliveryPhaseSnapshot,
        completed_attempts: u32,
        next_claim_generation: u64,
    ) -> Self {
        Self {
            facts,
            phase,
            completed_attempts,
            next_claim_generation,
        }
    }

    pub fn facts(&self) -> &DeliveryRequest {
        &self.facts
    }

    pub fn phase(&self) -> &DeliveryPhaseSnapshot {
        &self.phase
    }

    pub const fn completed_attempts(&self) -> u32 {
        self.completed_attempts
    }

    pub const fn next_claim_generation(&self) -> u64 {
        self.next_claim_generation
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum DeliveryPhaseSnapshot {
    Pending,
    Delivering(DeliveryClaimSnapshot),
    RetryScheduled {
        retry_at: u64,
        failure: DeliveryFailure,
    },
    Delivered {
        receipt: DeliveryReceiptReference,
        native_correlation: Option<NativeDeliveryCorrelation>,
        accepted_at: u64,
    },
    TerminalObserved {
        observation: TerminalObservationSnapshot,
    },
    Failed {
        failed_at: u64,
        failure: DeliveryFailure,
    },
    OutcomeUnknown {
        observed_at: u64,
    },
    Cancelled {
        cancelled_at: u64,
    },
}

#[derive(Clone, Eq, PartialEq)]
pub struct TerminalObservationSnapshot {
    payload: Box<TerminalObservationSnapshotPayload>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct TerminalObservationSnapshotInput {
    pub delivery_id: DeliveryId,
    pub graph_run_id: String,
    pub node_id: String,
    pub fence: ExecutionFence,
    pub role_id: String,
    pub correlation: NativeDeliveryCorrelation,
    pub delivered_receipt: DeliveryReceiptReference,
    pub native_terminal: NativeTerminalStatus,
    pub observed_at: u64,
    pub output: Option<TeamNodeOutput>,
    pub resolution: TerminalObservationResolution,
}

#[derive(Clone, Eq, PartialEq)]
struct TerminalObservationSnapshotPayload {
    delivery_id: DeliveryId,
    graph_run_id: String,
    node_id: String,
    fence: ExecutionFence,
    role_id: String,
    correlation: NativeDeliveryCorrelation,
    delivered_receipt: DeliveryReceiptReference,
    native_terminal: NativeTerminalStatus,
    observed_at: u64,
    output: Option<TeamNodeOutput>,
    resolution: TerminalObservationResolution,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryClaimSnapshot {
    delivery_id: DeliveryId,
    attempt: u32,
    generation: u64,
    claimed_at: u64,
}

impl fmt::Debug for DeliveryPhaseSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending => formatter.write_str("Pending"),
            Self::Delivering(claim) => formatter.debug_tuple("Delivering").field(claim).finish(),
            Self::RetryScheduled { retry_at, failure } => formatter
                .debug_struct("RetryScheduled")
                .field("retry_at", retry_at)
                .field("failure", failure)
                .finish(),
            Self::Delivered { accepted_at, .. } => formatter
                .debug_struct("Delivered")
                .field("receipt", &"<redacted>")
                .field("accepted_at", accepted_at)
                .finish(),
            Self::TerminalObserved { observation } => formatter
                .debug_struct("TerminalObserved")
                .field("observation", observation)
                .finish(),
            Self::Failed { failed_at, failure } => formatter
                .debug_struct("Failed")
                .field("failed_at", failed_at)
                .field("failure", failure)
                .finish(),
            Self::OutcomeUnknown { observed_at } => formatter
                .debug_struct("OutcomeUnknown")
                .field("observed_at", observed_at)
                .finish(),
            Self::Cancelled { cancelled_at } => formatter
                .debug_struct("Cancelled")
                .field("cancelled_at", cancelled_at)
                .finish(),
        }
    }
}

impl TerminalObservationSnapshot {
    pub(crate) fn new(input: TerminalObservationSnapshotInput) -> Self {
        let TerminalObservationSnapshotInput {
            delivery_id,
            graph_run_id,
            node_id,
            fence,
            role_id,
            correlation,
            delivered_receipt,
            native_terminal,
            observed_at,
            output,
            resolution,
        } = input;
        Self {
            payload: Box::new(TerminalObservationSnapshotPayload {
                delivery_id,
                graph_run_id,
                node_id,
                fence,
                role_id,
                correlation,
                delivered_receipt,
                native_terminal,
                observed_at,
                output,
                resolution,
            }),
        }
    }

    pub fn delivery_id(&self) -> &DeliveryId {
        &self.payload.delivery_id
    }

    pub fn graph_run_id(&self) -> &str {
        &self.payload.graph_run_id
    }

    pub fn node_id(&self) -> &str {
        &self.payload.node_id
    }

    pub fn fence(&self) -> &ExecutionFence {
        &self.payload.fence
    }

    pub fn role_id(&self) -> &str {
        &self.payload.role_id
    }

    pub fn correlation(&self) -> &NativeDeliveryCorrelation {
        &self.payload.correlation
    }

    pub fn endpoint_session_id(&self) -> &crate::EndpointSessionId {
        self.payload.correlation.endpoint_session_id()
    }

    pub fn delivered_receipt(&self) -> &DeliveryReceiptReference {
        &self.payload.delivered_receipt
    }

    pub fn native_run_receipt(&self) -> &crate::NativeRunReceiptReference {
        self.payload.correlation.native_run_receipt()
    }

    pub const fn native_terminal(&self) -> NativeTerminalStatus {
        self.payload.native_terminal
    }

    pub const fn observed_at(&self) -> u64 {
        self.payload.observed_at
    }

    pub fn output(&self) -> Option<&TeamNodeOutput> {
        self.payload.output.as_ref()
    }

    pub fn resolution(&self) -> &TerminalObservationResolution {
        &self.payload.resolution
    }
}

impl fmt::Debug for TerminalObservationSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalObservationSnapshot")
            .field("delivery_id", &"<redacted>")
            .field("graph_run_id", &"<redacted>")
            .field("node_id", &"<redacted>")
            .field("fence", &"<redacted>")
            .field("role_id", &"<redacted>")
            .field("endpoint_session_id", &"<redacted>")
            .field("delivered_receipt", &"<redacted>")
            .field("native_run_receipt", &"<redacted>")
            .field("native_terminal", &self.payload.native_terminal)
            .field("observed_at", &self.payload.observed_at)
            .field("has_output", &self.payload.output.is_some())
            .field("resolution", &self.payload.resolution)
            .finish()
    }
}

impl DeliveryClaimSnapshot {
    pub fn new(delivery_id: DeliveryId, attempt: u32, generation: u64, claimed_at: u64) -> Self {
        Self {
            delivery_id,
            attempt,
            generation,
            claimed_at,
        }
    }

    pub fn delivery_id(&self) -> &DeliveryId {
        &self.delivery_id
    }

    pub const fn attempt(&self) -> u32 {
        self.attempt
    }

    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub const fn claimed_at(&self) -> u64 {
        self.claimed_at
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum RestoreDeliveryError {
    InvalidRequest(DeliveryRequestError),
    InvalidCompletedAttempts,
    InvalidNextClaimGeneration,
    PendingAttemptMismatch,
    RetryAttemptMismatch,
    RetryFailureNotRetryable,
    TerminalAttemptMismatch,
    TerminalObservationCorrelationMismatch,
    TerminalObservationInvalidResolution,
    DeliveringClaimDeliveryMismatch,
    DeliveringClaimAttemptMismatch,
    DeliveringClaimGenerationMismatch,
}

impl fmt::Debug for RestoreDeliveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(error) => formatter
                .debug_tuple("InvalidRequest")
                .field(error)
                .finish(),
            Self::InvalidCompletedAttempts => formatter.write_str("InvalidCompletedAttempts"),
            Self::InvalidNextClaimGeneration => formatter.write_str("InvalidNextClaimGeneration"),
            Self::PendingAttemptMismatch => formatter.write_str("PendingAttemptMismatch"),
            Self::RetryAttemptMismatch => formatter.write_str("RetryAttemptMismatch"),
            Self::RetryFailureNotRetryable => formatter.write_str("RetryFailureNotRetryable"),
            Self::TerminalAttemptMismatch => formatter.write_str("TerminalAttemptMismatch"),
            Self::TerminalObservationCorrelationMismatch => {
                formatter.write_str("TerminalObservationCorrelationMismatch")
            }
            Self::TerminalObservationInvalidResolution => {
                formatter.write_str("TerminalObservationInvalidResolution")
            }
            Self::DeliveringClaimDeliveryMismatch => {
                formatter.write_str("DeliveringClaimDeliveryMismatch")
            }
            Self::DeliveringClaimAttemptMismatch => {
                formatter.write_str("DeliveringClaimAttemptMismatch")
            }
            Self::DeliveringClaimGenerationMismatch => {
                formatter.write_str("DeliveringClaimGenerationMismatch")
            }
        }
    }
}

impl Delivery {
    pub fn snapshot(&self) -> DeliverySnapshot {
        DeliverySnapshot::new(
            self.facts.clone(),
            DeliveryPhaseSnapshot::from_phase(&self.phase),
            self.completed_attempts,
            self.next_claim_generation,
        )
    }

    pub fn restore(snapshot: DeliverySnapshot) -> Result<Self, RestoreDeliveryError> {
        validate_snapshot(&snapshot)?;

        Ok(Self {
            facts: snapshot.facts,
            phase: snapshot.phase.into_phase(),
            completed_attempts: snapshot.completed_attempts,
            next_claim_generation: snapshot.next_claim_generation,
        })
    }
}

impl DeliveryPhaseSnapshot {
    fn from_phase(phase: &DeliveryPhase) -> Self {
        match phase {
            DeliveryPhase::Pending => Self::Pending,
            DeliveryPhase::Delivering(claim) => {
                Self::Delivering(DeliveryClaimSnapshot::from_claim(claim))
            }
            DeliveryPhase::RetryScheduled { retry_at, failure } => Self::RetryScheduled {
                retry_at: *retry_at,
                failure: *failure,
            },
            DeliveryPhase::Delivered {
                receipt,
                native_correlation,
                accepted_at,
            } => Self::Delivered {
                receipt: receipt.clone(),
                native_correlation: native_correlation.clone(),
                accepted_at: *accepted_at,
            },
            DeliveryPhase::TerminalObserved { observation } => Self::TerminalObserved {
                observation: TerminalObservationSnapshot::from_observation(observation),
            },
            DeliveryPhase::Failed { failed_at, failure } => Self::Failed {
                failed_at: *failed_at,
                failure: *failure,
            },
            DeliveryPhase::OutcomeUnknown { observed_at } => Self::OutcomeUnknown {
                observed_at: *observed_at,
            },
            DeliveryPhase::Cancelled { cancelled_at } => Self::Cancelled {
                cancelled_at: *cancelled_at,
            },
        }
    }

    fn into_phase(self) -> DeliveryPhase {
        match self {
            Self::Pending => DeliveryPhase::Pending,
            Self::Delivering(claim) => DeliveryPhase::Delivering(claim.into_claim()),
            Self::RetryScheduled { retry_at, failure } => {
                DeliveryPhase::RetryScheduled { retry_at, failure }
            }
            Self::Delivered {
                receipt,
                native_correlation,
                accepted_at,
            } => DeliveryPhase::Delivered {
                receipt,
                native_correlation,
                accepted_at,
            },
            Self::TerminalObserved { observation } => DeliveryPhase::TerminalObserved {
                observation: observation.into_observation(),
            },
            Self::Failed { failed_at, failure } => DeliveryPhase::Failed { failed_at, failure },
            Self::OutcomeUnknown { observed_at } => DeliveryPhase::OutcomeUnknown { observed_at },
            Self::Cancelled { cancelled_at } => DeliveryPhase::Cancelled { cancelled_at },
        }
    }
}

impl TerminalObservationSnapshot {
    fn from_observation(observation: &TerminalObservation) -> Self {
        Self::new(TerminalObservationSnapshotInput {
            delivery_id: observation.delivery_id().clone(),
            graph_run_id: observation.graph_run_id().to_owned(),
            node_id: observation.node_id().to_owned(),
            fence: observation.fence().clone(),
            role_id: observation.role_id().to_owned(),
            correlation: observation.correlation().clone(),
            delivered_receipt: observation.delivered_receipt().clone(),
            native_terminal: observation.native_terminal(),
            observed_at: observation.observed_at(),
            output: observation.output().cloned(),
            resolution: observation.resolution().clone(),
        })
    }

    fn into_observation(self) -> TerminalObservation {
        let TerminalObservationSnapshot { payload } = self;
        let TerminalObservationSnapshotPayload {
            delivery_id,
            graph_run_id,
            node_id,
            fence,
            role_id,
            correlation,
            delivered_receipt,
            native_terminal,
            observed_at,
            output,
            resolution,
        } = *payload;
        TerminalObservation::restore(super::model::TerminalObservationPayload {
            delivery_id,
            graph_run_id,
            node_id,
            fence,
            role_id,
            correlation,
            delivered_receipt,
            native_terminal,
            observed_at,
            output,
            resolution,
        })
    }
}

impl DeliveryClaimSnapshot {
    fn from_claim(claim: &DeliveryClaim) -> Self {
        Self::new(
            claim.delivery_id().clone(),
            claim.attempt(),
            claim.generation(),
            claim.claimed_at(),
        )
    }

    fn into_claim(self) -> DeliveryClaim {
        DeliveryClaim::restore(
            self.delivery_id,
            self.attempt,
            self.generation,
            self.claimed_at,
        )
    }
}

fn validate_snapshot(snapshot: &DeliverySnapshot) -> Result<(), RestoreDeliveryError> {
    snapshot
        .facts
        .validate()
        .map_err(RestoreDeliveryError::InvalidRequest)?;

    if snapshot.next_claim_generation == 0 || snapshot.next_claim_generation == u64::MAX {
        return Err(RestoreDeliveryError::InvalidNextClaimGeneration);
    }

    let claim_generation = u64::from(snapshot.completed_attempts) + 1;
    let next_generation_after_claim = claim_generation + 1;

    match &snapshot.phase {
        DeliveryPhaseSnapshot::Pending => {
            if snapshot.completed_attempts != 0 || snapshot.next_claim_generation != 1 {
                return Err(RestoreDeliveryError::PendingAttemptMismatch);
            }
        }
        DeliveryPhaseSnapshot::RetryScheduled { failure, .. } => {
            if !failure.is_retryable() {
                return Err(RestoreDeliveryError::RetryFailureNotRetryable);
            }
            if snapshot.completed_attempts >= snapshot.facts.max_attempts {
                return Err(RestoreDeliveryError::InvalidCompletedAttempts);
            }
            if snapshot.completed_attempts == 0
                || snapshot.next_claim_generation != claim_generation
            {
                return Err(RestoreDeliveryError::RetryAttemptMismatch);
            }
        }
        DeliveryPhaseSnapshot::Delivering(claim) => {
            if snapshot.completed_attempts >= snapshot.facts.max_attempts
                || claim.delivery_id != snapshot.facts.delivery_id
            {
                return Err(RestoreDeliveryError::DeliveringClaimDeliveryMismatch);
            }
            if claim.attempt != snapshot.completed_attempts + 1 {
                return Err(RestoreDeliveryError::DeliveringClaimAttemptMismatch);
            }
            if claim.generation != claim_generation
                || snapshot.next_claim_generation != next_generation_after_claim
            {
                return Err(RestoreDeliveryError::DeliveringClaimGenerationMismatch);
            }
        }
        DeliveryPhaseSnapshot::Delivered { .. } => {
            let legacy_delivered = snapshot.completed_attempts == 0
                && snapshot.next_claim_generation == next_generation_after_claim;
            if !legacy_delivered && snapshot.next_claim_generation != claim_generation {
                return Err(RestoreDeliveryError::TerminalAttemptMismatch);
            }
        }
        DeliveryPhaseSnapshot::OutcomeUnknown { .. } => {
            if snapshot.completed_attempts == 0
                || snapshot.next_claim_generation != claim_generation
            {
                return Err(RestoreDeliveryError::TerminalAttemptMismatch);
            }
        }
        DeliveryPhaseSnapshot::TerminalObserved { observation } => {
            if snapshot.completed_attempts == 0
                || snapshot.next_claim_generation != claim_generation
            {
                return Err(RestoreDeliveryError::TerminalAttemptMismatch);
            }
            validate_terminal_observation(snapshot, observation)?;
        }
        DeliveryPhaseSnapshot::Failed { failure, .. } => {
            if snapshot.completed_attempts == 0
                || snapshot.next_claim_generation != claim_generation
                || (failure.is_retryable()
                    && snapshot.completed_attempts != snapshot.facts.max_attempts)
            {
                return Err(RestoreDeliveryError::TerminalAttemptMismatch);
            }
        }
        DeliveryPhaseSnapshot::Cancelled { .. } => {
            if snapshot.next_claim_generation != claim_generation
                && snapshot.next_claim_generation != next_generation_after_claim
            {
                return Err(RestoreDeliveryError::TerminalAttemptMismatch);
            }
        }
    }

    Ok(())
}

fn validate_terminal_observation(
    snapshot: &DeliverySnapshot,
    observation: &TerminalObservationSnapshot,
) -> Result<(), RestoreDeliveryError> {
    if observation.delivery_id() != &snapshot.facts.delivery_id
        || observation.graph_run_id() != snapshot.facts.run_id
        || observation.node_id() != snapshot.facts.node_id
        || observation.fence().node_execution_id().as_str() != snapshot.facts.node_execution_id
        || observation.role_id() != snapshot.facts.role_id
    {
        return Err(RestoreDeliveryError::TerminalObservationCorrelationMismatch);
    }
    match (observation.native_terminal(), observation.resolution()) {
        (
            NativeTerminalStatus::Completed
            | NativeTerminalStatus::Failed
            | NativeTerminalStatus::Interrupted,
            TerminalObservationResolution::AwaitingAuthorizedGraphResolution,
        ) if observation.output().is_none() => Ok(()),
        (NativeTerminalStatus::Cancelled, TerminalObservationResolution::NodeCancelled)
            if observation.output().is_none() =>
        {
            Ok(())
        }
        (
            NativeTerminalStatus::Completed
            | NativeTerminalStatus::Failed
            | NativeTerminalStatus::Interrupted,
            TerminalObservationResolution::GraphResolved(resolution),
        ) if observation
            .output()
            .is_none_or(|output| output.output_port() == resolution.output_port())
            && resolution.delivery_id() == observation.delivery_id()
            && resolution.graph_run_id() == observation.graph_run_id()
            && resolution.fence() == observation.fence()
            && resolution.resolved_at() >= observation.observed_at() =>
        {
            Ok(())
        }
        _ => Err(RestoreDeliveryError::TerminalObservationInvalidResolution),
    }
}
