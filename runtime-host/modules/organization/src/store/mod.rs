pub(crate) mod codec;
mod content;
mod migration;
mod records;
mod schema;
mod sqlite;
mod design;
mod durable;
mod facts;
mod fault;
mod terminal_observation;
mod runtime_graph;

pub use runtime_graph::TeamRunExecutionScope;
pub(crate) use runtime_graph::{NodePromptPatch, RuntimePromptPatch};

pub use durable::OrganizationStore;
pub use migration::{MigrationError, MigrationReport, migrate_legacy_log};
pub use facts::TeamRunFactsRestoreInput;
pub use facts::{
    ApprovalResolutionInput, ApprovalResolutionOutcome,
    GraphRunFacts, OrganizationFacts, OrganizationFactsError,
    PendingWorkflowPlanAdmission, RunStartGate, TeamFacts,
    TeamTombstoneOutcome, WorkflowPlanAdmissionOutcome, WorkflowPlanSubmitOutcome,
    WorkflowTemplateFacts,
};
pub use fault::{DesignError, RuntimeGraphError, StoreFault};
pub use terminal_observation::NativeTerminalReceiptTarget;

#[cfg(test)]
mod tests;
