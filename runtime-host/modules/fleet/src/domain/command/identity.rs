use std::fmt;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CommandId(String);

impl CommandId {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidCommandId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidCommandId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCommandId;

impl fmt::Display for InvalidCommandId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("command ID must not be empty")
    }
}

impl std::error::Error for InvalidCommandId {}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidIdempotencyKey> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidIdempotencyKey);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidIdempotencyKey;

impl fmt::Display for InvalidIdempotencyKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("idempotency key must not be empty")
    }
}

impl std::error::Error for InvalidIdempotencyKey {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandAttempt {
    sequence: u64,
}

impl CommandAttempt {
    pub fn try_new(sequence: u64) -> Result<Self, InvalidCommandAttempt> {
        if sequence == 0 {
            return Err(InvalidCommandAttempt);
        }
        Ok(Self { sequence })
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub(crate) const fn first() -> Self {
        Self { sequence: 1 }
    }

    pub(crate) fn next(&self) -> Option<Self> {
        self.sequence
            .checked_add(1)
            .map(|sequence| Self { sequence })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCommandAttempt;

impl fmt::Display for InvalidCommandAttempt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("command attempt sequence must be positive")
    }
}

impl std::error::Error for InvalidCommandAttempt {}
