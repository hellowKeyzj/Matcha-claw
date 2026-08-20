use std::{fmt, io};

use super::FleetFactsError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StoreFault {
    Facts(FleetFactsError),
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
    CorruptRecord,
    UnsupportedSchemaVersion(u8),
}

impl fmt::Display for StoreFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Facts(_) => formatter.write_str("Fleet durable facts violate domain invariants"),
            Self::WriterBusy => formatter.write_str("Fleet durable facts writer is busy"),
            Self::Lock(_) => {
                formatter.write_str("Fleet durable facts writer lock could not be acquired")
            }
            Self::Read(_) => formatter.write_str("Fleet durable facts could not be read"),
            Self::Recovery(_) => {
                formatter.write_str("Fleet durable facts recovery could not complete")
            }
            Self::Commit(_) => formatter.write_str("Fleet durable facts could not be committed"),
            Self::CommitOutcomeUnknown(_) => formatter
                .write_str("Fleet durable facts commit outcome is unknown; reopen before retrying"),
            Self::RecoveryRequired => {
                formatter.write_str("Fleet durable facts require reopening before another mutation")
            }
            Self::RecordTooLarge => {
                formatter.write_str("Fleet durable facts record exceeds the durable limit")
            }
            Self::LogFull => {
                formatter.write_str("Fleet durable facts log reached its durable limit")
            }
            Self::EpochOverflow => {
                formatter.write_str("Fleet durable facts log cannot advance its commit epoch")
            }
            Self::CorruptRecord => formatter.write_str("Fleet durable facts record is corrupt"),
            Self::UnsupportedSchemaVersion(_) => {
                formatter.write_str("Fleet durable facts schema requires an explicit upgrade")
            }
        }
    }
}

impl std::error::Error for StoreFault {}

impl From<FleetFactsError> for StoreFault {
    fn from(value: FleetFactsError) -> Self {
        Self::Facts(value)
    }
}
