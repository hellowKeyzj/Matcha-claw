use std::{fmt, time::Duration};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LeaseId(String);

impl LeaseId {
    /// Creates an identity for one endpoint-capacity lease.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidLeaseId`] when `value` is empty or whitespace.
    pub fn try_new(value: impl Into<String>) -> Result<Self, InvalidLeaseId> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidLeaseId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidLeaseId;

impl fmt::Display for InvalidLeaseId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("lease ID must not be empty")
    }
}

impl std::error::Error for InvalidLeaseId {}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum LeaseOwnerKind {
    ManualOperation,
    RuntimeStart,
    Session,
    TeamRun,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LeaseOwner {
    kind: LeaseOwnerKind,
    id: String,
}

impl LeaseOwner {
    /// Creates the owner that holds a capacity lease.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidLeaseOwner`] when `id` is empty or whitespace.
    pub fn try_new(kind: LeaseOwnerKind, id: impl Into<String>) -> Result<Self, InvalidLeaseOwner> {
        let id = id.into();
        if id.trim().is_empty() {
            return Err(InvalidLeaseOwner);
        }
        Ok(Self { kind, id })
    }

    pub fn kind(&self) -> LeaseOwnerKind {
        self.kind
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidLeaseOwner;

impl fmt::Display for InvalidLeaseOwner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("lease owner ID must not be empty")
    }
}

impl std::error::Error for InvalidLeaseOwner {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LeaseDuration(Duration);

impl LeaseDuration {
    /// Creates a non-zero duration for an endpoint-capacity lease.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidLeaseDuration`] when `duration` is zero.
    pub fn try_new(duration: Duration) -> Result<Self, InvalidLeaseDuration> {
        if duration.is_zero() {
            return Err(InvalidLeaseDuration);
        }
        Ok(Self(duration))
    }

    pub const fn duration(self) -> Duration {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidLeaseDuration;

impl fmt::Display for InvalidLeaseDuration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("lease duration must be greater than zero")
    }
}

impl std::error::Error for InvalidLeaseDuration {}
