use std::fmt;

use crate::session::model::{Sequence, SessionId};

/// A session-bound app-server replay cursor.
///
/// The cursor uses the app-server's per-session event `seq`; it is neither a
/// run identity nor a transcript offset.
#[derive(Clone, Eq, PartialEq)]
pub struct EventRecoveryCursor {
    session_id: SessionId,
    sequence: Sequence,
}

impl EventRecoveryCursor {
    pub fn new(session_id: SessionId) -> Self {
        Self::resume_after(
            session_id,
            Sequence::try_new(0).expect("zero is a valid replay cursor"),
        )
    }

    pub fn resume_after(session_id: SessionId, sequence: Sequence) -> Self {
        Self {
            session_id,
            sequence,
        }
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub fn sequence(&self) -> Sequence {
        self.sequence
    }

    pub(super) fn advanced_to(&self, sequence: Sequence) -> Self {
        Self::resume_after(self.session_id.clone(), sequence)
    }
}

impl fmt::Debug for EventRecoveryCursor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EventRecoveryCursor")
            .field("sequence", &self.sequence)
            .finish_non_exhaustive()
    }
}

/// The safe result of recovering app-server events from a bound cursor.
#[derive(Clone, Eq, PartialEq)]
pub struct EventRecovery {
    cursor: EventRecoveryCursor,
    event_count: usize,
}

impl EventRecovery {
    pub(super) fn new(cursor: EventRecoveryCursor, event_count: usize) -> Self {
        Self {
            cursor,
            event_count,
        }
    }

    pub fn cursor(&self) -> &EventRecoveryCursor {
        &self.cursor
    }

    pub fn event_count(&self) -> usize {
        self.event_count
    }
}

impl fmt::Debug for EventRecovery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EventRecovery")
            .field("cursor", &self.cursor)
            .field("event_count", &self.event_count)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_cursor_binds_sequence_to_its_session_without_debug_leaks() {
        let cursor = EventRecoveryCursor::resume_after(
            SessionId::try_new("recovery-session-canary").unwrap(),
            Sequence::try_new(7).unwrap(),
        );
        let recovery =
            EventRecovery::new(cursor.clone().advanced_to(Sequence::try_new(9).unwrap()), 2);

        assert_eq!(cursor.session_id().as_str(), "recovery-session-canary");
        assert_eq!(cursor.sequence().get(), 7);
        assert_eq!(recovery.cursor().sequence().get(), 9);
        assert_eq!(recovery.event_count(), 2);
        for debug in [format!("{cursor:?}"), format!("{recovery:?}")] {
            assert!(!debug.contains("recovery-session-canary"));
        }
    }
}
