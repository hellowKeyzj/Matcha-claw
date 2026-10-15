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
#[cfg(test)]
pub(crate) use facts::{ApprovalResolutionOutcome, TeamRunFactsRestoreInput, TeamTombstoneOutcome};
pub use facts::OrganizationFactsError;
pub(crate) use facts::{
    GraphRunFacts, OrganizationFacts,
    PendingWorkflowPlanAdmission, RunStartGate, TeamFacts,
    WorkflowTemplateFacts,
};
pub use fault::{DesignError, RuntimeGraphError, StoreFault};
pub(crate) use terminal_observation::{NativeTerminalReceiptTarget, NativeTerminalSettlement};

#[cfg(test)]
mod tests;
