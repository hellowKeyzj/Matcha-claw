pub mod decision;
pub(crate) mod design;
pub(crate) mod design_prompt;
pub mod projection;
pub mod review;
pub mod start_gate_control;
pub mod task_board;
pub(crate) mod team_mcp;
pub mod team_message;
pub mod team_runtime;
pub mod team_runtime_control;

pub use decision::{
    TeamDecisionCompositionError, TeamDecisionFacade, TeamDecisionReceiptProjection,
    TeamDecisionRequest,
};
pub use team_runtime::{
    ManualTeamProvision, TeamGraphPatchDraft, TeamNodeEventCommandOutcome, TeamRuntimeCommand,
    TeamRuntimeCommandOutcome, TeamRuntimeCreateSource, TeamRuntimeDecodeError, TeamRuntimeStatus,
    decode_team_runtime_command,
};
pub use team_runtime_control::{
    TEAM_PUBLIC_PLACEHOLDER_PATH, TeamRuntimeCapabilityRequest, TeamRuntimeControlOutcome,
    decode_team_runtime_capability_request, execute_team_runtime_capability_request,
    is_team_runtime_facade_scope, project_team_runtime_outcome,
    summarize_team_runtime_control_outcome, team_public_unavailable_section_name,
};
