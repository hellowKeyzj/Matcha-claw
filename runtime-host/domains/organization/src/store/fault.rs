use std::{fmt, io};

use crate::{
    AgentNodeEventResolutionError, AuthorizedGraphResolutionError, ControlNodeResolutionError,
    DeliveryReceiptError, DeliveryRequestError, TerminalObservationError, TriggerFireError,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StoreFault {
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
    InvalidFacts,
    RuntimeReceipt(crate::OrganizationFactsError),
    Evidence(crate::OrganizationFactsError),
    DeliveryRequest(DeliveryRequestError),
    DeliveryReceipt(Box<DeliveryReceiptError>),
    TriggerFire(TriggerFireError),
    TerminalObservation(TerminalObservationError),
    AuthorizedGraphResolution(AuthorizedGraphResolutionError),
    AgentNodeEventResolution(AgentNodeEventResolutionError),
    GraphPatch(crate::GraphPatchError),
    EventLedger(crate::RecordCommandError),
    ControlNodeResolution(ControlNodeResolutionError),
}

impl fmt::Display for StoreFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WriterBusy => formatter.write_str("organization durable facts writer is busy"),
            Self::Lock(_) => {
                formatter.write_str("organization durable facts writer lock could not be acquired")
            }
            Self::Read(_) => formatter.write_str("organization durable facts could not be read"),
            Self::Recovery(_) => {
                formatter.write_str("organization durable facts recovery could not complete")
            }
            Self::Commit(_) => {
                formatter.write_str("organization durable facts could not be committed")
            }
            Self::CommitOutcomeUnknown(_) => formatter.write_str(
                "organization durable facts commit outcome is unknown; reopen before retrying",
            ),
            Self::RecoveryRequired => formatter
                .write_str("organization durable facts require reopening before another mutation"),
            Self::RecordTooLarge => {
                formatter.write_str("organization durable facts record exceeds the durable limit")
            }
            Self::LogFull => {
                formatter.write_str("organization durable facts log reached its durable limit")
            }
            Self::EpochOverflow => formatter
                .write_str("organization durable facts log cannot advance its commit epoch"),
            Self::CorruptRecord => {
                formatter.write_str("organization durable facts record is corrupt")
            }
            Self::UnsupportedSchemaVersion(_) => formatter
                .write_str("organization durable facts schema requires an explicit upgrade"),
            Self::InvalidFacts => {
                formatter.write_str("organization durable facts violate domain invariants")
            }
            Self::RuntimeReceipt(_) => formatter
                .write_str("organization runtime receipt violates TeamRun durable invariants"),
            Self::Evidence(_) => {
                formatter.write_str("organization evidence violates TeamRun durable invariants")
            }
            Self::DeliveryRequest(_) => {
                formatter.write_str("organization delivery request violates durable invariants")
            }
            Self::DeliveryReceipt(_) => formatter
                .write_str("organization delivery receipt violates durable claim invariants"),
            Self::TriggerFire(_) => {
                formatter.write_str("organization trigger fire violates TeamRun durable invariants")
            }
            Self::TerminalObservation(_) => formatter
                .write_str("organization terminal observation violates TeamRun durable invariants"),
            Self::AuthorizedGraphResolution(_) => formatter.write_str(
                "organization authorized graph resolution violates TeamRun durable invariants",
            ),
            Self::AgentNodeEventResolution(_) => formatter.write_str(
                "organization agent node event resolution violates TeamRun durable invariants",
            ),
            Self::GraphPatch(_) => {
                formatter.write_str("organization graph patch violates TeamRun durable invariants")
            }
            Self::EventLedger(_) => {
                formatter.write_str("organization TeamRun command violates durable identity fences")
            }
            Self::ControlNodeResolution(_) => formatter.write_str(
                "organization control node resolution violates TeamRun durable invariants",
            ),
        }
    }
}

impl std::error::Error for StoreFault {}
