mod ledger;
mod model;

pub use ledger::{
    CommandReceipt, EventLedger, EventLedgerSnapshot, RecordCommandError, RestoreEventLedgerError,
};
pub(crate) use model::TeamEventDurableInput;
pub use model::{
    ApprovalAction, ApprovalCommand, CommandPayload, CommandRecord, CommandRejection,
    CommandStatus, CommandType, GraphEdgeAction, GraphNodeKind, GraphPatch, GraphPatchOperation,
    InvalidEventInput, MetadataValue, NodeEventKind, NodeProgressCommand, OpaqueId, RunCommand,
    TeamEvent, TeamEventPayload, TeamEventType,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamRunWake {
    reason: TeamRunWakeReason,
    run_id: Option<organization::GraphRunId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TeamRunWakeReason {
    GraphChanged,
    StartGateChanged,
    TerminalSettled,
    RepairRejected,
    NativeRunSettled,
    TriggerFired,
    RunStarted,
    RunCancelled,
    NodeEventRecorded,
    ApprovalResolved,
    DecisionSubmitted,
    SchedulerObservationChanged,
}

impl TeamRunWake {
    pub fn new(reason: TeamRunWakeReason, run_id: Option<organization::GraphRunId>) -> Self {
        Self { reason, run_id }
    }

    pub fn reason(&self) -> TeamRunWakeReason {
        self.reason
    }

    pub fn run_id(&self) -> Option<&organization::GraphRunId> {
        self.run_id.as_ref()
    }
}

#[cfg(test)]
mod tests;
