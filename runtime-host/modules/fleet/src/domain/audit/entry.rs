use std::fmt;

use super::FleetAuditEvent;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FleetAuditEntry {
    sequence: u64,
    event: FleetAuditEvent,
}

impl FleetAuditEntry {
    pub fn try_new(sequence: u64, event: FleetAuditEvent) -> Result<Self, FleetAuditEntryError> {
        if sequence == 0 {
            return Err(FleetAuditEntryError::InvalidSequence);
        }

        Ok(Self { sequence, event })
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn event(&self) -> &FleetAuditEvent {
        &self.event
    }

    pub fn redacted_for_commit(&self) -> Self {
        Self {
            sequence: self.sequence,
            event: self.event.redacted_for_commit(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetAuditEntryError {
    InvalidSequence,
}

impl fmt::Display for FleetAuditEntryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Fleet audit entry sequence must be positive")
    }
}

impl std::error::Error for FleetAuditEntryError {}
