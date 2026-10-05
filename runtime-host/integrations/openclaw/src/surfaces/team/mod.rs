pub(crate) mod adapters;
mod agent;
mod buddy;
mod config;
mod member_profiles;
mod native_effects;
mod provider;
mod recovery;
mod workspace;
pub use native_effects::OpenClawTeamNativeEffects;
pub(crate) use provider::TeamProvider;
#[cfg(test)]
pub(crate) use recovery::{TeamRecoveryOutcome, TeamRecoveryRequest, TeamRecoveryRole};
#[cfg(test)]
pub(crate) use workspace::ResolvedWorkspace;

use crate::agents::{AgentWaitResult, AgentWaitStatus, AgentsWaitOutcome};
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeRunSettled {
    status: NativeRunStatus,
    hard_timeout: bool,
    final_assistant_text: Option<String>,
}

impl NativeRunSettled {
    pub const fn status(&self) -> NativeRunStatus {
        self.status
    }

    pub const fn is_hard_timeout(&self) -> bool {
        self.hard_timeout
    }

    pub fn final_assistant_text(&self) -> Option<&str> {
        self.final_assistant_text.as_deref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeRunStatus {
    Completed,
    Failed,
    Timeout,
    Pending,
}

impl From<AgentWaitStatus> for NativeRunStatus {
    fn from(value: AgentWaitStatus) -> Self {
        match value {
            AgentWaitStatus::Completed => Self::Completed,
            AgentWaitStatus::Failed => Self::Failed,
            AgentWaitStatus::Timeout => Self::Timeout,
            AgentWaitStatus::Pending => Self::Pending,
        }
    }
}

impl From<AgentWaitResult> for NativeRunSettled {
    fn from(value: AgentWaitResult) -> Self {
        Self {
            status: value.status.into(),
            hard_timeout: value.is_hard_timeout(),
            final_assistant_text: value.final_assistant_text,
        }
    }
}

impl From<AgentsWaitOutcome> for NativeRunSettledOutcome {
    fn from(value: AgentsWaitOutcome) -> Self {
        match value {
            AgentsWaitOutcome::Observed(result) => Self::Observed(result.into()),
            AgentsWaitOutcome::Rejected => Self::Rejected,
            AgentsWaitOutcome::OutcomeUnknown => Self::OutcomeUnknown,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeRunSettledOutcome {
    Observed(NativeRunSettled),
    Rejected,
    OutcomeUnknown,
}
