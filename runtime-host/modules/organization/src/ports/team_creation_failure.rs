use std::fmt;

use foundation::pipeline::PipelineError;
use serde::Serialize;

/// Safe failure fact, independent of progress, native outcome and durable commit.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamCreationFailure {
    pub stage: TeamCreationStage,
    pub reason: TeamCreationFailureReason,
    /// Zero-based non-leader input order; omitted for leader or whole-team failures.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<TeamCreationFile>,
}

impl TeamCreationFailure {
    pub const fn new(stage: TeamCreationStage, reason: TeamCreationFailureReason) -> Self {
        Self {
            stage,
            reason,
            member_index: None,
            file: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamCreationStage {
    Submitting,
    ReadingProfiles,
    GeneratingIntroductions,
    ConfiguringTeam,
    VerifyingTeam,
    SavingTeam,
    InitializingSessions,
    LoadingTeam,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamCreationFailureReason {
    InvalidInput,
    Rejected,
    Unavailable,
    Unsupported,
    InvalidResponse,
    OutcomeUnknown,
    ObservationInterrupted,
    RpcUnavailable,
    RpcRejected,
    RpcProtocol,
    RpcDeadline,
    RpcAuthentication,
    AgentMissing,
    AgentDuplicate,
    WorkspaceMissing,
    InvalidConfig,
    InvalidDescription,
    InvalidContent,
    #[serde(rename = "invalid_teamrun_blocks")]
    InvalidTeamRunBlocks,
    CredentialMissing,
    CredentialUnavailable,
    InvalidOutput,
    Cancelled,
    NativeReadFailed,
    NativeWriteFailed,
    NativeReadbackMismatch,
    StoreReadFailed,
    StoreWriteFailed,
    StoreConflict,
    StoreInvalid,
    TeamMissing,
    TeamDeleted,
    RunMissing,
    RunDeleted,
    RunTeamMismatch,
    AuthorizationInvalid,
    PermissionDenied,
    RateLimited,
    ModelAuthentication,
    ModelPermissionDenied,
    ModelRateLimited,
    ModelDeadline,
    ModelInvalidResponse,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum TeamCreationFile {
    #[serde(rename = "description")]
    Description,
    #[serde(rename = "AGENTS.md")]
    AgentsMarkdown,
    #[serde(rename = "SOUL.md")]
    SoulMarkdown,
}

impl fmt::Display for TeamCreationFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "team creation {:?}: {:?}",
            self.stage, self.reason
        )
    }
}

impl std::error::Error for TeamCreationFailure {}

/// The profile-reading step uses this error; generation keeps MemberIntroductionError.
impl From<PipelineError> for TeamCreationFailure {
    fn from(error: PipelineError) -> Self {
        Self::new(
            TeamCreationStage::ReadingProfiles,
            match error {
                PipelineError::Cancelled => TeamCreationFailureReason::Cancelled,
                _ => TeamCreationFailureReason::Unavailable,
            },
        )
    }
}
