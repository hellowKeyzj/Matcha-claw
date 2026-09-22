use crate::run::graph::AttemptStatus;

use super::{Attempt, AttemptOutcome, AttemptPhase, AttemptReceipt};

impl Attempt {
    pub fn start(&mut self) -> StartOutcome {
        match self.phase {
            AttemptPhase::Graph(AttemptStatus::Ready) => {
                self.phase = AttemptPhase::Graph(AttemptStatus::Running);
                StartOutcome::Started
            }
            AttemptPhase::Graph(AttemptStatus::Running) => StartOutcome::AlreadyRunning,
            AttemptPhase::Graph(status) if status.is_terminal() => StartOutcome::Terminal(status),
            AttemptPhase::Graph(status) => StartOutcome::NotReady(status),
            AttemptPhase::OutcomeUnknown => StartOutcome::OutcomeUnknown,
        }
    }

    pub fn wait(&mut self) -> WaitOutcome {
        match self.phase {
            AttemptPhase::Graph(status) if status.accepts_outcome() => {
                self.phase = AttemptPhase::Graph(AttemptStatus::Waiting);
                WaitOutcome::Waiting
            }
            phase => WaitOutcome::NotAwaitingOutcome(phase),
        }
    }

    pub fn settle(&mut self, receipt: AttemptReceipt) -> SettleOutcome {
        if receipt.identity() != &self.identity {
            return SettleOutcome::StaleReceipt;
        }
        if !self.phase.accepts_outcome() {
            return SettleOutcome::NotAwaitingOutcome(self.phase);
        }

        let outcome = receipt.outcome();
        self.phase = AttemptPhase::Graph(outcome.status());
        SettleOutcome::Settled(outcome)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartOutcome {
    Started,
    AlreadyRunning,
    NotReady(AttemptStatus),
    OutcomeUnknown,
    Terminal(AttemptStatus),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WaitOutcome {
    Waiting,
    NotAwaitingOutcome(AttemptPhase),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettleOutcome {
    Settled(AttemptOutcome),
    StaleReceipt,
    NotAwaitingOutcome(AttemptPhase),
}
