use super::*;
use crate::{
    ActivityClaimSnapshot, ActivityDispatchSnapshot, ActivityFailure, ActivityId, ActivityKind,
    ActivityPhaseSnapshot, ActivityRequest, ActivitySnapshot, ActivityTarget, NodeExecutionId,
    NodeId,
};

#[derive(Serialize, Deserialize)]
struct Row {
    id: String,
    run: String,
    node: String,
    execution: String,
    fence: Fence,
    kind: Kind,
    target: String,
    idempotency: String,
    created_at: u64,
    max_attempts: u32,
    phase: Phase,
    completed_attempts: u32,
    next_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settlement: Option<SettlementProof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_terminal_claim: Option<Claim>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettlementProof {
    claim: Claim,
    receipt: super::delivery::Receipt,
    settlement: Option<Settlement>,
    delivery_outcome: DeliveryOutcome,
    activity_outcome: Option<ActivityOutcome>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
enum Settlement {
    RetryScheduled {
        retry_at: u64,
        observed_at: u64,
        failure: Failure,
    },
    Failed {
        failed_at: u64,
        failure: Failure,
    },
    OutcomeUnknown(u64),
}
#[derive(Serialize, Deserialize)]
enum DeliveryOutcome {
    Delivered,
    RetryScheduled(u64),
    Failed,
    OutcomeUnknown,
}
#[derive(Serialize, Deserialize)]
enum ActivityOutcome {
    RetryScheduled,
    Failed,
    OutcomeUnknown,
}
impl Settlement {
    fn from_domain(value: &crate::ActivitySettlement) -> Result<Self, StoreFault> {
        use crate::ActivitySettlement as S;
        Ok(match value {
            S::RetryScheduled { retry_at, observed_at, failure } => Self::RetryScheduled {
                retry_at: *retry_at,
                observed_at: *observed_at,
                failure: Failure::from_domain(*failure),
            },
            S::Failed { failed_at, failure } => Self::Failed {
                failed_at: *failed_at,
                failure: Failure::from_domain(*failure),
            },
            S::OutcomeUnknown { observed_at } => Self::OutcomeUnknown(*observed_at),
            _ => return Err(StoreFault::InvalidFacts),
        })
    }
    fn into_domain(self) -> crate::ActivitySettlement {
        use crate::ActivitySettlement as S;
        match self {
            Self::RetryScheduled { retry_at, observed_at, failure } => S::RetryScheduled {
                retry_at,
                observed_at,
                failure: failure.into_domain(),
            },
            Self::Failed { failed_at, failure } => S::Failed {
                failed_at,
                failure: failure.into_domain(),
            },
            Self::OutcomeUnknown(observed_at) => S::OutcomeUnknown { observed_at },
        }
    }
}
impl DeliveryOutcome {
    fn from_domain(value: crate::DeliveryResolution) -> Self {
        match value {
            crate::DeliveryResolution::Delivered => Self::Delivered,
            crate::DeliveryResolution::RetryScheduled { retry_at } => Self::RetryScheduled(retry_at),
            crate::DeliveryResolution::Failed => Self::Failed,
            crate::DeliveryResolution::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
    fn into_domain(self) -> crate::DeliveryResolution {
        match self {
            Self::Delivered => crate::DeliveryResolution::Delivered,
            Self::RetryScheduled(retry_at) => crate::DeliveryResolution::RetryScheduled { retry_at },
            Self::Failed => crate::DeliveryResolution::Failed,
            Self::OutcomeUnknown => crate::DeliveryResolution::OutcomeUnknown,
        }
    }
}
impl ActivityOutcome {
    fn from_domain(value: crate::ActivitySettlementOutcome) -> Result<Self, StoreFault> {
        use crate::ActivitySettlementOutcome as O;
        Ok(match value {
            O::RetryScheduled => Self::RetryScheduled,
            O::Failed => Self::Failed,
            O::OutcomeUnknown => Self::OutcomeUnknown,
            _ => return Err(StoreFault::InvalidFacts),
        })
    }
    fn into_domain(self) -> crate::ActivitySettlementOutcome {
        use crate::ActivitySettlementOutcome as O;
        match self {
            Self::RetryScheduled => O::RetryScheduled,
            Self::Failed => O::Failed,
            Self::OutcomeUnknown => O::OutcomeUnknown,
        }
    }
}
impl SettlementProof {
    fn from_domain(value: &crate::run::activity::SettlementProof) -> Result<Self, StoreFault> {
        Ok(Self {
            claim: Claim {
                id: value.claim.activity_id().as_str().to_owned(),
                attempt: value.claim.attempt(),
                generation: value.claim.generation(),
                claimed_at: value.claim.claimed_at(),
            },
            receipt: super::delivery::Receipt::from_domain(&value.receipt),
            settlement: value.settlement.as_ref()
                .map(Settlement::from_domain).transpose()?,
            delivery_outcome: DeliveryOutcome::from_domain(value.delivery_outcome),
            activity_outcome: value.activity_outcome
                .map(ActivityOutcome::from_domain).transpose()?,
        })
    }
    fn into_domain(self) -> Result<crate::run::activity::SettlementProof, StoreFault> {
        Ok(crate::run::activity::SettlementProof {
            claim: crate::ActivityClaim::restore(
                valid(ActivityId::new(self.claim.id))?,
                self.claim.attempt,
                self.claim.generation,
                self.claim.claimed_at,
            ),
            receipt: self.receipt.into_domain()?,
            settlement: self.settlement.map(Settlement::into_domain),
            delivery_outcome: self.delivery_outcome.into_domain(),
            activity_outcome: self.activity_outcome.map(ActivityOutcome::into_domain),
        })
    }
}
#[derive(Serialize, Deserialize)]
enum Kind {
    Agent {
        task: String,
        role: String,
        session: String,
        prompt: Body,
    },
    Control {
        action: Body,
    },
}
#[derive(Serialize, Deserialize)]
struct Claim {
    id: String,
    attempt: u32,
    generation: u64,
    claimed_at: u64,
}
impl Claim {
    fn from_domain(value: &ActivityClaimSnapshot) -> Self {
        Self {
            id: value.activity_id().as_str().to_owned(),
            attempt: value.attempt(),
            generation: value.generation(),
            claimed_at: value.claimed_at(),
        }
    }
    fn into_domain(self) -> Result<ActivityClaimSnapshot, StoreFault> {
        Ok(ActivityClaimSnapshot::new(
            valid(ActivityId::new(self.id))?,
            self.attempt,
            self.generation,
            self.claimed_at,
        ))
    }
}
#[derive(Serialize, Deserialize)]
enum Failure {
    Rejected,
    Unavailable,
    TimedOut,
}
impl Failure {
    fn from_domain(value: ActivityFailure) -> Self {
        match value {
            ActivityFailure::Rejected => Self::Rejected,
            ActivityFailure::Unavailable => Self::Unavailable,
            ActivityFailure::TimedOut => Self::TimedOut,
        }
    }
    fn into_domain(self) -> ActivityFailure {
        match self {
            Self::Rejected => ActivityFailure::Rejected,
            Self::Unavailable => ActivityFailure::Unavailable,
            Self::TimedOut => ActivityFailure::TimedOut,
        }
    }
}
#[derive(Serialize, Deserialize)]
enum Phase {
    Pending,
    Claimed(Claim),
    Dispatched { claim: Claim, dispatched_at: u64 },
    RetryScheduled { retry_at: u64, failure: Failure },
    TerminalObserved(u64),
    Completed(u64),
    Failed { failed_at: u64, failure: Failure },
    OutcomeUnknown(u64),
    Cancelled(u64),
}

pub(super) fn encode(value: &Activity, bodies: &Bodies<'_>) -> Result<Vec<u8>, StoreFault> {
    let snapshot = value.snapshot();
    let facts = snapshot.facts();
    use ActivityPhaseSnapshot as P;
    let phase = match snapshot.phase() {
        P::Pending => Phase::Pending,
        P::Claimed(claim) => Phase::Claimed(Claim::from_domain(claim)),
        P::Dispatched(dispatch) => Phase::Dispatched {
            claim: Claim::from_domain(dispatch.claim()),
            dispatched_at: dispatch.dispatched_at(),
        },
        P::RetryScheduled { retry_at, failure } => Phase::RetryScheduled {
            retry_at: *retry_at,
            failure: Failure::from_domain(*failure),
        },
        P::TerminalObserved { observed_at } => Phase::TerminalObserved(*observed_at),
        P::Completed { completed_at } => Phase::Completed(*completed_at),
        P::Failed { failed_at, failure } => Phase::Failed {
            failed_at: *failed_at,
            failure: Failure::from_domain(*failure),
        },
        P::OutcomeUnknown { observed_at } => Phase::OutcomeUnknown(*observed_at),
        P::Cancelled { cancelled_at } => Phase::Cancelled(*cancelled_at),
    };
    let kind = match &facts.activity_kind {
        ActivityKind::AgentTask {
            task_id,
            role_id,
            session_ref,
            prompt,
        } => Kind::Agent {
            task: task_id.clone(),
            role: role_id.clone(),
            session: session_ref.clone(),
            prompt: bodies.put(prompt)?,
        },
        ActivityKind::Control { action } => Kind::Control {
            action: bodies.put(action)?,
        },
    };
    serialize(&Row {
        id: facts.activity_id.as_str().to_owned(),
        run: facts.run_id.as_str().to_owned(),
        node: facts.node_id.as_str().to_owned(),
        execution: facts.node_execution_id.as_str().to_owned(),
        fence: Fence::from_domain(&facts.fence),
        kind,
        target: facts.target.as_str().to_owned(),
        idempotency: facts.idempotency_key.clone(),
        created_at: facts.created_at,
        max_attempts: facts.max_attempts,
        phase,
        completed_attempts: snapshot.completed_attempts(),
        next_generation: snapshot.next_claim_generation(),
        settlement: snapshot.settlement_proof.as_ref()
            .map(SettlementProof::from_domain).transpose()?,
        native_terminal_claim: snapshot.native_terminal_claim.as_ref().map(Claim::from_domain),
    })
}

pub(super) fn decode(bytes: &[u8], bodies: &Bodies<'_>) -> Result<Activity, StoreFault> {
    let row: Row = deserialize(bytes)?;
    let kind = match row.kind {
        Kind::Agent {
            task,
            role,
            session,
            prompt,
        } => ActivityKind::AgentTask {
            task_id: task,
            role_id: role,
            session_ref: session,
            prompt: bodies.read(prompt)?,
        },
        Kind::Control { action } => ActivityKind::Control {
            action: bodies.read(action)?,
        },
    };
    let facts = ActivityRequest {
        activity_id: valid(ActivityId::new(row.id))?,
        run_id: GraphRunId::new(row.run),
        node_id: NodeId::new(row.node),
        node_execution_id: NodeExecutionId::from_durable(row.execution),
        fence: row.fence.into_domain(),
        activity_kind: kind,
        target: valid(ActivityTarget::new(row.target))?,
        idempotency_key: row.idempotency,
        created_at: row.created_at,
        max_attempts: row.max_attempts,
    };
    use ActivityPhaseSnapshot as P;
    let phase = match row.phase {
        Phase::Pending => P::Pending,
        Phase::Claimed(claim) => P::Claimed(claim.into_domain()?),
        Phase::Dispatched {
            claim,
            dispatched_at,
        } => P::Dispatched(ActivityDispatchSnapshot::new(
            claim.into_domain()?,
            dispatched_at,
        )),
        Phase::RetryScheduled { retry_at, failure } => P::RetryScheduled {
            retry_at,
            failure: failure.into_domain(),
        },
        Phase::TerminalObserved(observed_at) => P::TerminalObserved { observed_at },
        Phase::Completed(completed_at) => P::Completed { completed_at },
        Phase::Failed { failed_at, failure } => P::Failed {
            failed_at,
            failure: failure.into_domain(),
        },
        Phase::OutcomeUnknown(observed_at) => P::OutcomeUnknown { observed_at },
        Phase::Cancelled(cancelled_at) => P::Cancelled { cancelled_at },
    };
    let mut snapshot = ActivitySnapshot::new(
        facts,
        phase,
        row.completed_attempts,
        row.next_generation,
    );
    snapshot.settlement_proof = row.settlement.map(SettlementProof::into_domain).transpose()?;
    snapshot.native_terminal_claim = row.native_terminal_claim.map(Claim::into_domain).transpose()?;
    valid(Activity::restore(snapshot))
}
