pub(crate) mod codec;
mod content;
mod design;
mod durable;
mod facts;
mod fault;
mod prompts;
mod records;
mod rework_control;
mod rework_migration;
mod runtime_graph;
mod schema;
mod sqlite;
mod terminal_observation;

pub use runtime_graph::TeamRunExecutionScope;
pub(crate) use runtime_graph::{NodePromptPatch, RuntimePromptPatch};

pub use durable::OrganizationStore;
pub use facts::OrganizationFactsError;
#[cfg(test)]
pub(crate) use facts::{ApprovalResolutionOutcome, TeamRunFactsRestoreInput, TeamTombstoneOutcome};
pub(crate) use facts::{
    GraphRunFacts, OrganizationFacts, PendingWorkflowPlanAdmission, RoleSessionIntent, RoleSessionPhase,
    RunStartGate, TeamFacts, WorkflowTemplateFacts,
};
pub use fault::{DesignError, RuntimeGraphError, StoreFault};
pub use prompts::TeamPromptSettingsError;
pub use rework_migration::{
    ReworkLimitOverride, ReworkMigrationError, ReworkMigrationLimits, ReworkMigrationPreview,
    ReworkMigrationReport, ReworkNodeMigration, migrate_rework_budgets, preview_rework_migration,
};
pub(crate) use terminal_observation::{NativeTerminalReceiptTarget, NativeTerminalSettlement};

#[cfg(test)]
mod tests;
