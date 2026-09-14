mod admission;
mod events;
mod host;
mod matcha;
mod openclaw;
mod openclaw_channel;
mod openclaw_plugin;
mod openclaw_skill;
mod owner;
mod peer;
mod review;
mod session;
pub(crate) mod team;
mod team_decision;
pub(crate) mod team_run;
pub mod team_run_mcp;
mod team_trigger;
pub(crate) mod team_trigger_cron;

pub(crate) use admission::HostAdmission;
pub use admission::{
    HostPhase, HostState as AdmissionState, HostTransitionError, RequestAdmission,
    RequestAdmissionClosed,
};
pub use events::{HostEvent, HostEvents};
pub use host::{
    ConstructionError, Host, HostInput, HostShutdownError, OwnerShutdownFailure,
    RuntimeLifecycleFailure, RuntimeStartFailure, ShutdownFailures, ShutdownReport,
    WorkspaceBinaryError, WorkspaceListError, WorkspaceMediaError, WorkspaceReadError,
    WorkspaceStatError, WorkspaceWriteError,
};
pub use matcha::{ConstructionError as MatchaConstructionError, MatchaAgentInput};
pub use openclaw::{ConstructionError as OpenClawConstructionError, OpenClawInput};
pub(crate) use openclaw::{
    ControlLease, OpenClawGatewayHealthObservation, OpenClawGatewayStatusObservation,
    OpenClawInstance, OpenClawLogSnapshot,
};
pub(crate) use peer::{
    PeerHandle, RestartMatchaError, RestartOpenClawError, StartMatchaError, StartOpenClawError,
    StopMatchaError, StopOpenClawError,
};
pub use session::{RuntimeSessionError, SessionShutdownFailure};
pub(crate) use team::{
    ManualTeamCreateOutcome, ManualTeamMaterializationInput, RuntimeReceiptOutcome,
    TeamDeleteOutcome, confirm_runtime_receipt_native,
};
pub use team_decision::{
    TeamDecisionCompositionError, TeamDecisionFacade, TeamDecisionReceiptProjection,
    TeamDecisionRequest,
};

use crate::transport::mcp_stdio;
use std::{
    io::{BufRead, Write},
    path::Path,
};

use organization::{OrganizationStore, StoreFault};

const ORGANIZATION_FACTS_FILE: &str = "organization-facts.log";

/// Opens a process-local handle on the canonical Organization durable facts log.
///
/// Host composition and the standalone TeamRun MCP stdio process open this same log
/// independently; the log remains the single durable facts authority, not an in-memory store.
pub fn open_organization_store(state_dir: &Path) -> Result<OrganizationStore, StoreFault> {
    OrganizationStore::open(state_dir.join(ORGANIZATION_FACTS_FILE))
}

pub fn run_team_run_mcp<R: BufRead, W: Write>(
    state_dir: &Path,
    input: R,
    output: W,
) -> Result<(), TeamRunMcpConstructionError> {
    let facade = compose_team_run_mcp(state_dir)?;
    mcp_stdio::run(facade, input, output).map_err(|_| TeamRunMcpConstructionError)
}

fn compose_team_run_mcp(
    state_dir: &Path,
) -> Result<team_run_mcp::TeamRunMcpFacade, TeamRunMcpConstructionError> {
    let store = open_organization_store(state_dir).map_err(|_| TeamRunMcpConstructionError)?;
    Ok(team_run_mcp::TeamRunMcpFacade::from_canonical_store(store))
}

#[derive(Clone, Copy, Debug)]
pub struct TeamRunMcpConstructionError;

pub(crate) use team_run::{
    MatchaTerminalObservationError, MatchaTerminalObservationOutcome, TeamNodePromptSettledResult,
    TeamNodeTerminalResult, TeamRunActivityError, TeamRunActivityOutcome, TeamRunActivityStart,
    TeamRunActivityTarget, TeamRunCommandOutcome, TeamRunTriggerOutcome,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamMaterializationCommandOutcome {
    Materialized {
        team_id: organization::TeamId,
        managed_agent_count: usize,
    },
    OutcomeUnknown,
    Rejected,
    Unavailable,
}
pub(crate) use team_trigger::{ArmedTrigger, TeamTriggerFireResolution, Trigger as TeamTrigger};
