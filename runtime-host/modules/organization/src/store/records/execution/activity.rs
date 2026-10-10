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
    valid(Activity::restore(ActivitySnapshot::new(
        facts,
        phase,
        row.completed_attempts,
        row.next_generation,
    )))
}
