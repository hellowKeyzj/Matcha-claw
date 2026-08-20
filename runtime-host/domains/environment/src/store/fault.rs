use std::{fmt, io};

use crate::definition::EnvironmentRevision;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DesiredWriteFault {
    UnknownEnvironment,
    InitialRevisionRequired,
    RevisionConflict {
        revision: EnvironmentRevision,
    },
    StaleRevision {
        current: EnvironmentRevision,
        received: EnvironmentRevision,
    },
    RevisionMustFollowCurrent {
        current: EnvironmentRevision,
        received: EnvironmentRevision,
    },
}

impl fmt::Display for DesiredWriteFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownEnvironment => {
                formatter.write_str("environment desired configuration is unknown")
            }
            Self::InitialRevisionRequired => {
                formatter.write_str("initial desired revision must be one")
            }
            Self::RevisionConflict { .. } => {
                formatter.write_str("desired revision is already assigned to different facts")
            }
            Self::StaleRevision { .. } => {
                formatter.write_str("desired revision must advance monotonically")
            }
            Self::RevisionMustFollowCurrent { .. } => {
                formatter.write_str("desired revision must immediately follow current facts")
            }
        }
    }
}

impl std::error::Error for DesiredWriteFault {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplyEvidenceFault {
    UnknownEnvironment,
    RevisionMismatch {
        desired: EnvironmentRevision,
        received: EnvironmentRevision,
    },
    IncompleteVerification,
}

impl fmt::Display for ApplyEvidenceFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownEnvironment => {
                formatter.write_str("apply evidence requires accepted desired facts")
            }
            Self::RevisionMismatch { .. } => formatter
                .write_str("apply evidence must match the current desired revision exactly"),
            Self::IncompleteVerification => formatter.write_str(
                "apply evidence requires verified readback of every required projection plane",
            ),
        }
    }
}

impl std::error::Error for ApplyEvidenceFault {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_evidence_faults_do_not_expose_projection_inputs() {
        let revision = EnvironmentRevision::try_new(7).unwrap();
        let faults = [
            ApplyEvidenceFault::UnknownEnvironment.to_string(),
            ApplyEvidenceFault::RevisionMismatch {
                desired: revision,
                received: revision,
            }
            .to_string(),
            ApplyEvidenceFault::IncompleteVerification.to_string(),
        ];

        for fault in faults {
            assert!(!fault.contains("credential:v1:anthropic"));
            assert!(!fault.contains("secret-value-must-not-appear"));
            assert!(!fault.contains("C:\\\\"));
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeFault {
    CorruptRecord,
    InvalidFacts,
}

impl fmt::Display for DecodeFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CorruptRecord => formatter.write_str("environment facts record is corrupt"),
            Self::InvalidFacts => {
                formatter.write_str("environment facts record violates domain invariants")
            }
        }
    }
}

impl std::error::Error for DecodeFault {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpgradeFault {
    UnsupportedSchemaVersion(u8),
}

impl fmt::Display for UpgradeFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment facts schema requires an explicit upgrade")
    }
}

impl std::error::Error for UpgradeFault {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreFault {
    Desired(DesiredWriteFault),
    ApplyEvidence(ApplyEvidenceFault),
    WriterBusy,
    Lock(io::ErrorKind),
    Read(io::ErrorKind),
    Recovery(io::ErrorKind),
    Commit(io::ErrorKind),
    CommitOutcomeUnknown(io::ErrorKind),
    RecoveryRequired,
    RecordTooLarge,
    LogFull,
    EpochOverflow,
    Decode(DecodeFault),
    Upgrade(UpgradeFault),
}

impl fmt::Display for StoreFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Desired(error) => error.fmt(formatter),
            Self::ApplyEvidence(error) => error.fmt(formatter),
            Self::WriterBusy => formatter.write_str("environment facts writer is busy"),
            Self::Lock(_) => {
                formatter.write_str("environment facts writer lock could not be acquired")
            }
            Self::Read(_) => formatter.write_str("environment facts could not be read"),
            Self::Recovery(_) => {
                formatter.write_str("environment facts recovery could not complete")
            }
            Self::Commit(_) => formatter.write_str("environment facts could not be committed"),
            Self::CommitOutcomeUnknown(_) => formatter
                .write_str("environment facts commit outcome is unknown; reopen before retrying"),
            Self::RecoveryRequired => {
                formatter.write_str("environment facts require reopening before another mutation")
            }
            Self::RecordTooLarge => {
                formatter.write_str("environment facts record exceeds the durable limit")
            }
            Self::LogFull => formatter.write_str("environment facts log reached its durable limit"),
            Self::EpochOverflow => {
                formatter.write_str("environment facts log cannot advance its commit epoch")
            }
            Self::Decode(error) => error.fmt(formatter),
            Self::Upgrade(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for StoreFault {}

impl From<DesiredWriteFault> for StoreFault {
    fn from(value: DesiredWriteFault) -> Self {
        Self::Desired(value)
    }
}

impl From<ApplyEvidenceFault> for StoreFault {
    fn from(value: ApplyEvidenceFault) -> Self {
        Self::ApplyEvidence(value)
    }
}

impl From<DecodeFault> for StoreFault {
    fn from(value: DecodeFault) -> Self {
        Self::Decode(value)
    }
}

impl From<UpgradeFault> for StoreFault {
    fn from(value: UpgradeFault) -> Self {
        Self::Upgrade(value)
    }
}
