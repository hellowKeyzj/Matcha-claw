mod decision;
mod store;

use std::{fmt, io};

pub use decision::EnvironmentAuthorizationAuthority;

use crate::EnvironmentAuthorization;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PolicyVersion(u64);

impl PolicyVersion {
    pub fn try_new(value: u64) -> Result<Self, InvalidPolicyVersion> {
        (value != 0)
            .then_some(Self(value))
            .ok_or(InvalidPolicyVersion)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidPolicyVersion;

impl fmt::Display for InvalidPolicyVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment authorization policy version is invalid")
    }
}

impl std::error::Error for InvalidPolicyVersion {}

#[derive(Clone)]
pub struct EnvironmentGrant {
    authorization: EnvironmentAuthorization,
}

impl EnvironmentGrant {
    pub fn grant_id(&self) -> &str {
        self.authorization.grant_id()
    }

    pub fn authorization(&self) -> &EnvironmentAuthorization {
        &self.authorization
    }
}

impl fmt::Debug for EnvironmentGrant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EnvironmentGrant(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorityStoreFault {
    WriterBusy,
    Lock(io::ErrorKind),
    Read(io::ErrorKind),
    Commit(io::ErrorKind),
    RandomUnavailable,
    InvalidRecord,
    UnsupportedSchema,
    RecordTooLarge,
    PolicyVersionConflict,
    UnknownGrant,
}

impl fmt::Display for AuthorityStoreFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::WriterBusy => "environment authorization authority is busy",
            Self::Lock(_) => "environment authorization authority lock could not be acquired",
            Self::Read(_) => "environment authorization authority could not be read",
            Self::Commit(_) => "environment authorization authority could not be committed",
            Self::RandomUnavailable => "environment authorization authority cannot issue a grant",
            Self::InvalidRecord => "environment authorization authority record is invalid",
            Self::UnsupportedSchema => {
                "environment authorization authority requires an explicit upgrade"
            }
            Self::RecordTooLarge => {
                "environment authorization authority record exceeds the durable limit"
            }
            Self::PolicyVersionConflict => "environment authorization policy version conflicts",
            Self::UnknownGrant => "environment authorization grant is unknown",
        })
    }
}

impl std::error::Error for AuthorityStoreFault {}

#[cfg(test)]
mod tests;
