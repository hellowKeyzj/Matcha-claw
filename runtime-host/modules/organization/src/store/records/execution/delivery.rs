use super::*;
use crate::run::delivery::{
    TerminalObservationResolution, TerminalObservationSnapshot, TerminalObservationSnapshotInput,
};
use crate::{
    AuthorizedGraphOutcome, AuthorizedGraphResolution, AuthorizedGraphResolutionReceipt,
    DeliveryClaimSnapshot, DeliveryFailure, DeliveryId, DeliveryPhaseSnapshot,
    DeliveryReceiptReference, DeliveryRequest, DeliverySnapshot, EndpointSessionId,
    NativeDeliveryCorrelation, NativeRunReceiptReference, NativeTerminalStatus, TeamNodeOutput,
};

#[derive(Serialize, Deserialize)]
struct Row {
    id: String,
    team: String,
    run: String,
    node: String,
    execution: String,
    task: String,
    role: String,
    session: String,
    idempotency: String,
    message: Body,
    requested_at: u64,
    max_attempts: u32,
    phase: Phase,
    completed_attempts: u32,
    next_generation: u64,
}
#[derive(Serialize, Deserialize)]
struct Correlation {
    session: String,
    receipt: String,
}
impl Correlation {
    fn from_domain(value: &NativeDeliveryCorrelation) -> Self {
        Self {
            session: value.endpoint_session_id().as_str().to_owned(),
            receipt: value.native_run_receipt().as_str().to_owned(),
        }
    }
    fn into_domain(self) -> Result<NativeDeliveryCorrelation, StoreFault> {
        Ok(NativeDeliveryCorrelation::new(
            valid(EndpointSessionId::try_new(self.session))?,
            valid(NativeRunReceiptReference::try_new(self.receipt))?,
        ))
    }
}
#[derive(Serialize, Deserialize)]
enum Failure {
    ReceiverRejected,
    PolicyRejected,
    Unavailable,
    TimedOut,
}
impl Failure {
    fn from_domain(value: DeliveryFailure) -> Self {
        match value {
            DeliveryFailure::ReceiverRejected => Self::ReceiverRejected,
            DeliveryFailure::PolicyRejected => Self::PolicyRejected,
            DeliveryFailure::Unavailable => Self::Unavailable,
            DeliveryFailure::TimedOut => Self::TimedOut,
        }
    }
    fn into_domain(self) -> DeliveryFailure {
        match self {
            Self::ReceiverRejected => DeliveryFailure::ReceiverRejected,
            Self::PolicyRejected => DeliveryFailure::PolicyRejected,
            Self::Unavailable => DeliveryFailure::Unavailable,
            Self::TimedOut => DeliveryFailure::TimedOut,
        }
    }
}
#[derive(Serialize, Deserialize)]
enum Phase {
    Pending,
    Delivering {
        id: String,
        attempt: u32,
        generation: u64,
        claimed_at: u64,
    },
    RetryScheduled {
        retry_at: u64,
        failure: Failure,
    },
    Delivered {
        receipt: String,
        accepted_at: u64,
        correlation: Option<Correlation>,
    },
    TerminalObserved(Terminal),
    Failed {
        failed_at: u64,
        failure: Failure,
    },
    OutcomeUnknown(u64),
    Cancelled(u64),
}
#[derive(Serialize, Deserialize)]
enum NativeStatus {
    Completed,
    Cancelled,
    Failed,
    Interrupted,
}
#[derive(Serialize, Deserialize)]
struct Output {
    text: Body,
    summary: Body,
    decision: String,
}
#[derive(Serialize, Deserialize)]
enum Resolution {
    Awaiting,
    Cancelled,
    Resolved {
        receipt: String,
        delivery: String,
        run: String,
        fence: Fence,
        completed: bool,
        output_port: String,
        resolved_at: u64,
    },
}
#[derive(Serialize, Deserialize)]
struct Terminal {
    delivery: String,
    run: String,
    node: String,
    fence: Fence,
    role: String,
    correlation: Correlation,
    delivered_receipt: String,
    status: NativeStatus,
    observed_at: u64,
    output: Option<Output>,
    resolution: Resolution,
}
impl Terminal {
    fn from_domain(
        value: &TerminalObservationSnapshot,
        bodies: &Bodies<'_>,
    ) -> Result<Self, StoreFault> {
        let status = match value.native_terminal() {
            NativeTerminalStatus::Completed => NativeStatus::Completed,
            NativeTerminalStatus::Cancelled => NativeStatus::Cancelled,
            NativeTerminalStatus::Failed => NativeStatus::Failed,
            NativeTerminalStatus::Interrupted => NativeStatus::Interrupted,
        };
        let resolution = match value.resolution() {
            TerminalObservationResolution::AwaitingAuthorizedGraphResolution => {
                Resolution::Awaiting
            }
            TerminalObservationResolution::NodeCancelled => Resolution::Cancelled,
            TerminalObservationResolution::GraphResolved(value) => Resolution::Resolved {
                receipt: value.receipt().as_str().to_owned(),
                delivery: value.delivery_id().as_str().to_owned(),
                run: value.graph_run_id().to_owned(),
                fence: Fence::from_domain(value.fence()),
                completed: value.outcome() == AuthorizedGraphOutcome::Completed,
                output_port: value.output_port().to_owned(),
                resolved_at: value.resolved_at(),
            },
        };
        let output = value
            .output()
            .map(|value| -> Result<Output, StoreFault> {
                Ok(Output {
                    text: bodies.put(value.final_assistant_text())?,
                    summary: bodies.put(value.summary())?,
                    decision: value.decision().to_owned(),
                })
            })
            .transpose()?;
        Ok(Self {
            delivery: value.delivery_id().as_str().to_owned(),
            run: value.graph_run_id().to_owned(),
            node: value.node_id().to_owned(),
            fence: Fence::from_domain(value.fence()),
            role: value.role_id().to_owned(),
            correlation: Correlation::from_domain(value.correlation()),
            delivered_receipt: value.delivered_receipt().as_str().to_owned(),
            status,
            observed_at: value.observed_at(),
            output,
            resolution,
        })
    }
    fn into_domain(self, bodies: &Bodies<'_>) -> Result<TerminalObservationSnapshot, StoreFault> {
        let native_terminal = match self.status {
            NativeStatus::Completed => NativeTerminalStatus::Completed,
            NativeStatus::Cancelled => NativeTerminalStatus::Cancelled,
            NativeStatus::Failed => NativeTerminalStatus::Failed,
            NativeStatus::Interrupted => NativeTerminalStatus::Interrupted,
        };
        let resolution = match self.resolution {
            Resolution::Awaiting => {
                TerminalObservationResolution::AwaitingAuthorizedGraphResolution
            }
            Resolution::Cancelled => TerminalObservationResolution::NodeCancelled,
            Resolution::Resolved {
                receipt,
                delivery,
                run,
                fence,
                completed,
                output_port,
                resolved_at,
            } => TerminalObservationResolution::GraphResolved(valid(
                AuthorizedGraphResolution::new(
                    valid(AuthorizedGraphResolutionReceipt::try_new(receipt))?,
                    valid(DeliveryId::new(delivery))?,
                    run,
                    fence.into_domain(),
                    if completed {
                        AuthorizedGraphOutcome::Completed
                    } else {
                        AuthorizedGraphOutcome::Failed
                    },
                    output_port,
                    resolved_at,
                ),
            )?),
        };
        let output = self
            .output
            .map(|value| {
                valid(TeamNodeOutput::restore(
                    bodies.read(value.text)?,
                    bodies.read(value.summary)?,
                    value.decision,
                ))
            })
            .transpose()?;
        Ok(TerminalObservationSnapshot::new(
            TerminalObservationSnapshotInput {
                delivery_id: valid(DeliveryId::new(self.delivery))?,
                graph_run_id: self.run,
                node_id: self.node,
                fence: self.fence.into_domain(),
                role_id: self.role,
                correlation: self.correlation.into_domain()?,
                delivered_receipt: valid(DeliveryReceiptReference::try_new(
                    self.delivered_receipt,
                ))?,
                native_terminal,
                observed_at: self.observed_at,
                output,
                resolution,
            },
        ))
    }
}

pub(super) fn encode(value: &Delivery, bodies: &Bodies<'_>) -> Result<Vec<u8>, StoreFault> {
    let snapshot = value.snapshot();
    let facts = snapshot.facts();
    if facts.team_id != bodies.team.as_str() || facts.run_id != bodies.run.as_str() {
        return Err(StoreFault::InvalidFacts);
    }
    use DeliveryPhaseSnapshot as P;
    let phase = match snapshot.phase() {
        P::Pending => Phase::Pending,
        P::Delivering(value) => Phase::Delivering {
            id: value.delivery_id().as_str().to_owned(),
            attempt: value.attempt(),
            generation: value.generation(),
            claimed_at: value.claimed_at(),
        },
        P::RetryScheduled { retry_at, failure } => Phase::RetryScheduled {
            retry_at: *retry_at,
            failure: Failure::from_domain(*failure),
        },
        P::Delivered {
            receipt,
            accepted_at,
            native_correlation,
        } => Phase::Delivered {
            receipt: receipt.as_str().to_owned(),
            accepted_at: *accepted_at,
            correlation: native_correlation.as_ref().map(Correlation::from_domain),
        },
        P::TerminalObserved { observation } => {
            Phase::TerminalObserved(Terminal::from_domain(observation, bodies)?)
        }
        P::Failed { failed_at, failure } => Phase::Failed {
            failed_at: *failed_at,
            failure: Failure::from_domain(*failure),
        },
        P::OutcomeUnknown { observed_at } => Phase::OutcomeUnknown(*observed_at),
        P::Cancelled { cancelled_at } => Phase::Cancelled(*cancelled_at),
    };
    serialize(&Row {
        id: facts.delivery_id.as_str().to_owned(),
        team: facts.team_id.clone(),
        run: facts.run_id.clone(),
        node: facts.node_id.clone(),
        execution: facts.node_execution_id.clone(),
        task: facts.task_id.clone(),
        role: facts.role_id.clone(),
        session: facts.session_ref.clone(),
        idempotency: facts.idempotency_key.clone(),
        message: bodies.put(&facts.message)?,
        requested_at: facts.requested_at,
        max_attempts: facts.max_attempts,
        phase,
        completed_attempts: snapshot.completed_attempts(),
        next_generation: snapshot.next_claim_generation(),
    })
}

pub(super) fn decode(bytes: &[u8], bodies: &Bodies<'_>) -> Result<Delivery, StoreFault> {
    let row: Row = deserialize(bytes)?;
    if row.team != bodies.team.as_str() || row.run != bodies.run.as_str() {
        return Err(StoreFault::CorruptRecord);
    }
    let facts = DeliveryRequest {
        delivery_id: valid(DeliveryId::new(row.id))?,
        team_id: row.team,
        run_id: row.run,
        node_id: row.node,
        node_execution_id: row.execution,
        task_id: row.task,
        role_id: row.role,
        session_ref: row.session,
        idempotency_key: row.idempotency,
        message: bodies.read(row.message)?,
        requested_at: row.requested_at,
        max_attempts: row.max_attempts,
    };
    use DeliveryPhaseSnapshot as P;
    let phase = match row.phase {
        Phase::Pending => P::Pending,
        Phase::Delivering {
            id,
            attempt,
            generation,
            claimed_at,
        } => P::Delivering(DeliveryClaimSnapshot::new(
            valid(DeliveryId::new(id))?,
            attempt,
            generation,
            claimed_at,
        )),
        Phase::RetryScheduled { retry_at, failure } => P::RetryScheduled {
            retry_at,
            failure: failure.into_domain(),
        },
        Phase::Delivered {
            receipt,
            accepted_at,
            correlation,
        } => P::Delivered {
            receipt: valid(DeliveryReceiptReference::try_new(receipt))?,
            accepted_at,
            native_correlation: correlation.map(Correlation::into_domain).transpose()?,
        },
        Phase::TerminalObserved(value) => P::TerminalObserved {
            observation: value.into_domain(bodies)?,
        },
        Phase::Failed { failed_at, failure } => P::Failed {
            failed_at,
            failure: failure.into_domain(),
        },
        Phase::OutcomeUnknown(observed_at) => P::OutcomeUnknown { observed_at },
        Phase::Cancelled(cancelled_at) => P::Cancelled { cancelled_at },
    };
    valid(Delivery::restore(DeliverySnapshot::new(
        facts,
        phase,
        row.completed_attempts,
        row.next_generation,
    )))
}
