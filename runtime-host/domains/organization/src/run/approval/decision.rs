use std::fmt;

use crate::{GraphRunId, run::event::OpaqueId};

use super::ApprovalDecision;

const MAX_DECISION_NOTE_BYTES: usize = 256;

/// A human decision addressing one already-requested TeamRun approval.
///
/// The approval remains the durable correlation fact. The command deliberately carries neither a
/// graph node nor a terminal event: both are derived from that correlation by the Organization
/// store before it asks the graph owner to resolve the pinned control-node attempt.
#[derive(Clone, Eq, PartialEq)]
pub struct HumanDecisionCommand {
    run_id: GraphRunId,
    approval_id: OpaqueId,
    decision: ApprovalDecision,
    note: Option<String>,
    idempotency_key: OpaqueId,
    resolved_at: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HumanDecisionCommandError {
    InvalidNote,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HumanDecisionOutcome {
    Recorded,
    Replayed,
}

impl HumanDecisionCommand {
    pub fn new(
        run_id: GraphRunId,
        approval_id: OpaqueId,
        decision: ApprovalDecision,
        note: Option<String>,
        idempotency_key: OpaqueId,
        resolved_at: u64,
    ) -> Result<Self, HumanDecisionCommandError> {
        if note.as_ref().is_some_and(|note| !is_note(note)) {
            return Err(HumanDecisionCommandError::InvalidNote);
        }
        Ok(Self {
            run_id,
            approval_id,
            decision,
            note,
            idempotency_key,
            resolved_at,
        })
    }

    pub fn run_id(&self) -> &GraphRunId {
        &self.run_id
    }

    pub fn approval_id(&self) -> &str {
        self.approval_id.as_str()
    }

    pub const fn decision(&self) -> ApprovalDecision {
        self.decision
    }

    pub fn note(&self) -> Option<&str> {
        self.note.as_deref()
    }

    pub fn idempotency_key(&self) -> &str {
        self.idempotency_key.as_str()
    }

    pub const fn resolved_at(&self) -> u64 {
        self.resolved_at
    }
}

impl fmt::Debug for HumanDecisionCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HumanDecisionCommand")
            .field("run_id", &self.run_id)
            .field("approval_id", &self.approval_id)
            .field("decision", &self.decision)
            .field("has_note", &self.note.is_some())
            .field("idempotency_key", &self.idempotency_key)
            .field("resolved_at", &self.resolved_at)
            .finish()
    }
}

fn is_note(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_DECISION_NOTE_BYTES
}
