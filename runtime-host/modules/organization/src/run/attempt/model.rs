use crate::run::graph::AttemptStatus;

use super::AttemptIdentity;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttemptPhase {
    Graph(AttemptStatus),
    OutcomeUnknown,
}

impl AttemptPhase {
    pub(super) fn accepts_outcome(self) -> bool {
        match self {
            Self::Graph(status) => status.accepts_outcome(),
            Self::OutcomeUnknown => true,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttemptOutcome {
    Completed,
    Failed,
    Cancelled,
}

impl AttemptOutcome {
    pub(super) const fn status(self) -> AttemptStatus {
        match self {
            Self::Completed => AttemptStatus::Completed,
            Self::Failed => AttemptStatus::Failed,
            Self::Cancelled => AttemptStatus::Cancelled,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttemptReceipt {
    identity: AttemptIdentity,
    outcome: AttemptOutcome,
}

impl AttemptReceipt {
    pub fn new(identity: AttemptIdentity, outcome: AttemptOutcome) -> Self {
        Self { identity, outcome }
    }

    pub fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }

    pub const fn outcome(&self) -> AttemptOutcome {
        self.outcome
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attempt {
    pub(super) identity: AttemptIdentity,
    pub(super) phase: AttemptPhase,
}

impl Attempt {
    pub fn ready(identity: AttemptIdentity) -> Self {
        Self::from_graph(identity, AttemptStatus::Ready)
    }

    pub fn from_graph(identity: AttemptIdentity, status: AttemptStatus) -> Self {
        Self {
            identity,
            phase: AttemptPhase::Graph(status),
        }
    }

    pub fn restore(identity: AttemptIdentity, phase: AttemptPhase) -> Self {
        Self { identity, phase }
    }

    pub fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }

    pub const fn phase(&self) -> AttemptPhase {
        self.phase
    }
}
