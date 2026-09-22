use super::{
    TriggerFireRequest, TriggerFireRequestError, TriggerRegistration, fire::is_opaque_identifier,
};
use crate::TeamId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamTriggerFireRequest {
    pub team_id: TeamId,
    pub trigger: TriggerFireRequest,
}

impl TeamTriggerFireRequest {
    pub fn try_new(
        team_id: TeamId,
        trigger: TriggerFireRequest,
    ) -> Result<Self, TeamTriggerFireRequestError> {
        let request = Self { team_id, trigger };
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<(), TeamTriggerFireRequestError> {
        if !is_opaque_identifier(self.team_id.as_str()) {
            return Err(TeamTriggerFireRequestError::InvalidTeamId);
        }
        self.trigger
            .validate()
            .map_err(TeamTriggerFireRequestError::InvalidTrigger)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeamTriggerFireRequestError {
    InvalidTeamId,
    InvalidTrigger(TriggerFireRequestError),
}

impl std::fmt::Display for TeamTriggerFireRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidTeamId => "team trigger fire team id is invalid",
            Self::InvalidTrigger(_) => "team trigger fire request is invalid",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for TeamTriggerFireRequestError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeamTriggerFireOutcome {
    Recorded(TeamTriggerFireRequest),
    Replayed(TeamTriggerFireRequest),
    Conflicting { idempotency_key: String },
    NotFound,
    Unknown,
    Rejected,
}

impl TeamTriggerFireOutcome {
    pub fn from_registration(
        request: TeamTriggerFireRequest,
        registration: TriggerRegistration,
    ) -> Self {
        match registration {
            TriggerRegistration::Recorded(_) => Self::Recorded(request),
            TriggerRegistration::Replayed(_) => Self::Replayed(request),
            TriggerRegistration::ConflictingIdempotencyKey { idempotency_key } => {
                Self::Conflicting { idempotency_key }
            }
        }
    }
}
