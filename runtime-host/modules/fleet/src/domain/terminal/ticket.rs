use std::{
    fmt,
    time::{Duration, SystemTime},
};

use getrandom::fill;
use sha2::{Digest, Sha256};

use super::Generation;

pub const TICKET_TTL: Duration = Duration::from_secs(30);
const TICKET_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TicketDigest([u8; 32]);

impl TicketDigest {
    fn from_material(material: &[u8; TICKET_BYTES]) -> Self {
        Self(Sha256::digest(material).into())
    }

    fn matches(&self, material: &[u8]) -> bool {
        let candidate: [u8; 32] = Sha256::digest(material).into();
        self.0
            .iter()
            .zip(candidate)
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct TicketRecord {
    generation: Generation,
    digest: TicketDigest,
    expires_at: SystemTime,
    consumed: bool,
}

impl TicketRecord {
    pub(super) fn issue(
        generation: Generation,
        now: SystemTime,
    ) -> Result<(Self, TicketMaterial), TicketError> {
        let expires_at = now
            .checked_add(TICKET_TTL)
            .ok_or(TicketError::TimeOutOfRange)?;
        let mut material = [0u8; TICKET_BYTES];
        fill(&mut material).map_err(|_| TicketError::EntropyUnavailable)?;
        Ok((
            Self {
                generation,
                digest: TicketDigest::from_material(&material),
                expires_at,
                consumed: false,
            },
            TicketMaterial(material),
        ))
    }

    pub(super) fn matches(&self, generation: Generation, ticket: &[u8], now: SystemTime) -> bool {
        !self.consumed
            && self.generation == generation
            && self.expires_at > now
            && self.digest.matches(ticket)
    }

    pub(super) fn consume(
        &mut self,
        generation: Generation,
        ticket: &[u8],
        now: SystemTime,
    ) -> Result<(), TicketError> {
        if self.consumed
            || self.generation != generation
            || self.expires_at <= now
            || !self.digest.matches(ticket)
        {
            return Err(TicketError::Invalid);
        }
        self.consumed = true;
        Ok(())
    }
}

#[derive(Debug)]
pub struct TicketMaterial([u8; TICKET_BYTES]);

impl TicketMaterial {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for TicketMaterial {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TicketError {
    EntropyUnavailable,
    TimeOutOfRange,
    Invalid,
}

impl fmt::Display for TicketError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::EntropyUnavailable => "terminal ticket could not be generated",
            Self::TimeOutOfRange => "terminal ticket expiry exceeds the supported time range",
            Self::Invalid => "terminal ticket is invalid or expired",
        })
    }
}
impl std::error::Error for TicketError {}
