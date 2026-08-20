use std::fmt;

use crate::command::CommandId;

const MAX_PHASE_KEY_BYTES: usize = 128;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PhaseKey(String);

impl PhaseKey {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidPhaseKey> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidPhaseKey::Empty);
        }
        if value.as_bytes().contains(&0) {
            return Err(InvalidPhaseKey::ContainsNul);
        }
        if value.len() > MAX_PHASE_KEY_BYTES {
            return Err(InvalidPhaseKey::TooLong);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidPhaseKey {
    Empty,
    ContainsNul,
    TooLong,
}

impl fmt::Display for InvalidPhaseKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("phase key must not be empty"),
            Self::ContainsNul => formatter.write_str("phase key must not contain NUL"),
            Self::TooLong => formatter.write_str("phase key exceeds the maximum length"),
        }
    }
}

impl std::error::Error for InvalidPhaseKey {}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct EffectIdentity {
    operation_id: CommandId,
    phase_key: PhaseKey,
}

impl EffectIdentity {
    pub fn new(operation_id: CommandId, phase_key: PhaseKey) -> Self {
        Self {
            operation_id,
            phase_key,
        }
    }

    pub fn operation_id(&self) -> &CommandId {
        &self.operation_id
    }

    pub fn phase_key(&self) -> &PhaseKey {
        &self.phase_key
    }

    pub(crate) fn restore(operation_id: CommandId, phase_key: PhaseKey) -> Self {
        Self {
            operation_id,
            phase_key,
        }
    }
}
