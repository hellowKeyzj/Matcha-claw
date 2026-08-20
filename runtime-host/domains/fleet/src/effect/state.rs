use std::{fmt, time::SystemTime};

use crate::command::CommandAttempt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectState {
    Pending,
    InFlight,
    Delivered,
    OutcomeUnknown,
    Rejected,
}

impl EffectState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Delivered | Self::Rejected)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectTransition {
    Began { attempt: CommandAttempt },
    Delivered,
    Rejected,
    OutcomeUnknown,
    ReplayAuthorized,
    Idempotent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectTransitionError {
    InvalidTransition,
    MissingAttempt,
    StaleAttempt,
    AttemptOverflow,
    DeadlineOutOfRange,
    DeadlineNotReached,
    InvalidRecord,
}

impl fmt::Display for EffectTransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTransition => {
                formatter.write_str("effect transition is not allowed from its current state")
            }
            Self::MissingAttempt => formatter.write_str("effect state requires a current attempt"),
            Self::StaleAttempt => formatter.write_str("effect receipt belongs to a stale attempt"),
            Self::AttemptOverflow => formatter.write_str("effect attempt sequence overflowed"),
            Self::DeadlineOutOfRange => {
                formatter.write_str("effect deadline is outside the supported time range")
            }
            Self::DeadlineNotReached => formatter.write_str("effect deadline has not been reached"),
            Self::InvalidRecord => formatter.write_str("effect durable record is invalid"),
        }
    }
}

impl std::error::Error for EffectTransitionError {}

pub(crate) fn checked_deadline(
    now: SystemTime,
    timeout: std::time::Duration,
) -> Result<SystemTime, EffectTransitionError> {
    now.checked_add(timeout)
        .ok_or(EffectTransitionError::DeadlineOutOfRange)
}
