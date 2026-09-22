mod identity;
mod record;
mod state;
mod ticket;

use std::{collections::BTreeMap, fmt, time::SystemTime};

pub use identity::{
    Dimensions, Generation, InvalidDimensions, InvalidIdentity, ProviderId, SessionId,
    SessionIdAllocator, TargetId,
};
pub use record::SessionSummary;
pub use state::SessionStatus;
pub use ticket::{TICKET_TTL, TicketError, TicketMaterial};

use record::SessionSummary as Record;
use ticket::{TicketError as TicketFailure, TicketRecord};

#[derive(Default)]
pub struct TerminalSessionOwner {
    sessions: BTreeMap<SessionId, SessionEntry>,
    session_ids: SessionIdAllocator,
}

struct SessionEntry {
    summary: Record,
    ticket: Option<TicketRecord>,
}

pub struct OpenedSession {
    pub session: SessionSummary,
    pub ticket: TicketMaterial,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalSessionError {
    NotFound,
    InvalidState,
    InvalidTicket,
    GenerationExhausted,
    TimeOutOfRange,
    EntropyUnavailable,
}

impl fmt::Display for TerminalSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NotFound => "terminal session was not found",
            Self::InvalidState => "terminal session lifecycle transition is not allowed",
            Self::InvalidTicket => "terminal ticket is invalid or expired",
            Self::GenerationExhausted => "terminal session generation is exhausted",
            Self::TimeOutOfRange => "terminal session expiry exceeds the supported time range",
            Self::EntropyUnavailable => "terminal ticket could not be generated",
        })
    }
}
impl std::error::Error for TerminalSessionError {}

impl From<TicketFailure> for TerminalSessionError {
    fn from(error: TicketFailure) -> Self {
        match error {
            TicketFailure::Invalid => Self::InvalidTicket,
            TicketFailure::TimeOutOfRange => Self::TimeOutOfRange,
            TicketFailure::EntropyUnavailable => Self::EntropyUnavailable,
        }
    }
}

impl TerminalSessionOwner {
    pub fn allocate_session_id(&mut self) -> Result<SessionId, TerminalSessionError> {
        loop {
            let session = self
                .session_ids
                .next()
                .ok_or(TerminalSessionError::GenerationExhausted)?;
            if !self.sessions.contains_key(&session) {
                return Ok(session);
            }
        }
    }

    pub fn open_allocated(
        &mut self,
        target: TargetId,
        provider: ProviderId,
        dimensions: Dimensions,
        now: SystemTime,
    ) -> Result<OpenedSession, TerminalSessionError> {
        let session = self.allocate_session_id()?;
        self.open(session, target, provider, dimensions, now)
    }

    pub fn open(
        &mut self,
        session: SessionId,
        target: TargetId,
        provider: ProviderId,
        dimensions: Dimensions,
        now: SystemTime,
    ) -> Result<OpenedSession, TerminalSessionError> {
        if self.sessions.contains_key(&session) {
            return Err(TerminalSessionError::InvalidState);
        }
        let expires_at = now
            .checked_add(TICKET_TTL)
            .ok_or(TerminalSessionError::TimeOutOfRange)?;
        let summary = Record::opening(
            session.clone(),
            target,
            provider,
            dimensions,
            now,
            expires_at,
        );
        let (ticket, material) = TicketRecord::issue(summary.generation(), now)?;
        let output = OpenedSession {
            session: summary.clone(),
            ticket: material,
        };
        self.sessions.insert(
            session,
            SessionEntry {
                summary,
                ticket: Some(ticket),
            },
        );
        Ok(output)
    }

    pub fn list(&self) -> Vec<SessionSummary> {
        self.sessions
            .values()
            .map(|entry| entry.summary.clone())
            .collect()
    }

    pub fn consume_ticket(
        &mut self,
        session: SessionId,
        generation: Generation,
        ticket: &[u8],
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        let entry = self
            .sessions
            .get_mut(&session)
            .ok_or(TerminalSessionError::NotFound)?;
        if entry.summary.generation() != generation
            || !matches!(entry.summary.status(), SessionStatus::Opening)
        {
            return Err(TerminalSessionError::InvalidState);
        }
        let ticket_record = entry
            .ticket
            .as_mut()
            .ok_or(TerminalSessionError::InvalidTicket)?;
        ticket_record.consume(generation, ticket, now)?;
        entry.ticket = None;
        entry.summary.set_status(SessionStatus::Connected, now);
        Ok(entry.summary.clone())
    }

    /// Atomically consumes a one-time ticket without requiring the transport to
    /// know the session id. The actor owns the map, so no two connections can
    /// redeem the same ticket or race a reconnect.
    pub fn consume_ticket_any(
        &mut self,
        ticket: &[u8],
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        let session = self
            .sessions
            .iter()
            .find_map(|(session, entry)| {
                if !matches!(entry.summary.status(), SessionStatus::Opening) {
                    return None;
                }
                entry.ticket.as_ref().and_then(|record| {
                    record
                        .matches(entry.summary.generation(), ticket, now)
                        .then(|| session.clone())
                })
            })
            .ok_or(TerminalSessionError::InvalidTicket)?;
        let generation = self
            .sessions
            .get(&session)
            .map(|entry| entry.summary.generation())
            .ok_or(TerminalSessionError::NotFound)?;
        self.consume_ticket(session, generation, ticket, now)
    }

    pub fn reconnect(
        &mut self,
        session: SessionId,
        now: SystemTime,
    ) -> Result<OpenedSession, TerminalSessionError> {
        let entry = self
            .sessions
            .get_mut(&session)
            .ok_or(TerminalSessionError::NotFound)?;
        let expires_at = now
            .checked_add(TICKET_TTL)
            .ok_or(TerminalSessionError::TimeOutOfRange)?;
        let generation = entry
            .summary
            .reconnect(now, expires_at)
            .ok_or(TerminalSessionError::InvalidState)?;
        let (ticket, material) = TicketRecord::issue(generation, now)?;
        entry.ticket = Some(ticket);
        Ok(OpenedSession {
            session: entry.summary.clone(),
            ticket: material,
        })
    }

    pub fn begin_close(
        &mut self,
        session: &SessionId,
        expected_generation: Generation,
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        let entry = self
            .sessions
            .get_mut(session)
            .ok_or(TerminalSessionError::NotFound)?;
        if entry.summary.generation() != expected_generation {
            return Err(TerminalSessionError::InvalidState);
        }
        match entry.summary.status() {
            SessionStatus::Closed | SessionStatus::Closing => Ok(entry.summary.clone()),
            SessionStatus::Opening | SessionStatus::Connected => {
                entry.ticket = None;
                entry.summary.set_status(SessionStatus::Closing, now);
                Ok(entry.summary.clone())
            }
            _ => Err(TerminalSessionError::InvalidState),
        }
    }

    pub fn finish_close(
        &mut self,
        session: &SessionId,
        expected_generation: Generation,
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        let entry = self
            .sessions
            .get_mut(session)
            .ok_or(TerminalSessionError::NotFound)?;
        if entry.summary.generation() != expected_generation {
            return Err(TerminalSessionError::InvalidState);
        }
        match entry.summary.status() {
            SessionStatus::Closed => Ok(entry.summary.clone()),
            SessionStatus::Closing => {
                entry.ticket = None;
                entry.summary.set_status(SessionStatus::Closed, now);
                Ok(entry.summary.clone())
            }
            _ => Err(TerminalSessionError::InvalidState),
        }
    }

    pub fn close(
        &mut self,
        session: &SessionId,
        expected_generation: Generation,
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        self.begin_close(session, expected_generation, now)?;
        self.finish_close(session, expected_generation, now)
    }

    pub fn fail(
        &mut self,
        session: &SessionId,
        expected_generation: Generation,
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        let entry = self
            .sessions
            .get_mut(session)
            .ok_or(TerminalSessionError::NotFound)?;
        if entry.summary.generation() != expected_generation {
            return Err(TerminalSessionError::InvalidState);
        }
        match entry.summary.status() {
            SessionStatus::Opening | SessionStatus::Connected | SessionStatus::Closing => {
                entry.ticket = None;
                entry.summary.set_status(SessionStatus::Failed, now);
                Ok(entry.summary.clone())
            }
            SessionStatus::Failed => {
                entry.ticket = None;
                Ok(entry.summary.clone())
            }
            SessionStatus::Closed | SessionStatus::Expired => {
                Err(TerminalSessionError::InvalidState)
            }
        }
    }

    pub fn expire(
        &mut self,
        session: &SessionId,
        now: SystemTime,
    ) -> Result<SessionSummary, TerminalSessionError> {
        let entry = self
            .sessions
            .get_mut(session)
            .ok_or(TerminalSessionError::NotFound)?;
        if entry.summary.expired(now) {
            entry.ticket = None;
            Ok(entry.summary.clone())
        } else {
            Err(TerminalSessionError::InvalidState)
        }
    }
}

#[cfg(test)]
mod tests;
