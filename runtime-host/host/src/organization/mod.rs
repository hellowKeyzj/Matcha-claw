#[allow(dead_code)]
mod actor;
#[allow(dead_code)]
mod command;
mod coordinator;
#[allow(dead_code)]
mod decision;
#[allow(dead_code)]
mod handle;
mod projection;
#[allow(dead_code)]
mod query;
mod receipt_router;
#[allow(dead_code)]
mod review;
mod run_actor;
mod run_scheduler;
pub(crate) mod session_terminal;
mod start_gate_control;
mod start_gate_send_hook;
mod supervisor;
pub(crate) mod task_board;
#[allow(dead_code)]
pub(crate) mod team_message;
#[allow(dead_code)]
pub(crate) mod team_run;
#[allow(dead_code)]
pub(crate) mod team_run_mcp;
mod team_runtime;

pub(crate) use actor::{OrganizationOwner, OrganizationOwnerInput};
pub(crate) use command::OrganizationCommand;
pub(crate) use coordinator::{
    TeamRunCoordinator, TeamRunCoordinatorHandle, TeamRunCoordinatorInput,
};
pub use decision::{
    TeamDecisionCompositionError, TeamDecisionFacade, TeamDecisionReceiptProjection,
    TeamDecisionRequest,
};
pub(crate) use handle::OrganizationHandle;
pub(crate) use query::OrganizationQuery;
pub(crate) use start_gate_send_hook::{StartGateRegistry, StartGateSendHook};
pub(crate) use team_run::{
    ArmedTrigger, ManualTeamCreateOutcome, RuntimeReceiptOutcome, TeamDeleteOutcome,
    TeamMaterializationCommandOutcome, TeamNodeTerminalResolution, TeamNodeTerminalResult,
    TeamRunCommandOutcome, TeamRunTriggerOutcome, TeamTrigger,
};
pub use team_run_mcp::{
    TeamGraphContextOutcome, TeamGraphContextRequest, TeamGraphContextRequestView,
    TeamGraphPatchCommand, TeamNodeEventCommand, TeamNodeEventCommandKind, TeamNodeEventOutcome,
    TeamRunMcpError, TeamRunMcpFacade,
};
pub(crate) use team_runtime::{
    ManualTeamProvision, TeamGraphPatchDraft, TeamNodeEventCommandOutcome, TeamRuntimeCommand,
    TeamRuntimeCommandOutcome, TeamRuntimeCreateSource, TeamRuntimeStatus,
};

const ORGANIZATION_FACTS_FILE: &str = "organization-facts.log";

/// Opens a process-local handle on the canonical Organization durable facts log.
pub fn open_organization_store(
    state_dir: &std::path::Path,
) -> Result<organization::OrganizationStore, organization::StoreFault> {
    organization::OrganizationStore::open(state_dir.join(ORGANIZATION_FACTS_FILE))
}
