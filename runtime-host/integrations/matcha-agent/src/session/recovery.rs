use super::{
    client::{EventRecoveryCursor, RawEvent},
    events::SessionEventObservation,
    facts::NativeReplayBoundary,
    hydration::HydrationIncomplete,
    model::{Sequence, SessionId},
};

/// The native boundary that prevents a session event stream from being
/// projected as a complete live sequence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryReason {
    CursorGap {
        expected: Sequence,
        received: Sequence,
    },
    CursorStale {
        cursor: Sequence,
        received: Sequence,
    },
    EventOverflow,
    ConnectionClosed {
        cursor: Sequence,
    },
    BroadcastLagged {
        skipped: u64,
    },
    Restart,
    ReplayBoundary {
        observed_last: Option<Sequence>,
        reported_last: Sequence,
        reported_event_count: usize,
    },
    ProjectionRejected {
        sequence: Sequence,
        reason: ProjectionRecoveryReason,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionRecoveryReason {
    Malformed,
    OutOfSession,
}

/// An integration-local recovery result.
///
/// This is deliberately not a Host `SessionDelta`: the only cursor retained is
/// the native app-server cursor. Recovery never carries a terminal event or a
/// synthesized Host sequence/cursor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionRecovery {
    RecoveryRequired {
        reason: RecoveryReason,
        native_cursor: Option<EventRecoveryCursor>,
        source_epoch: Option<u64>,
    },
    Incomplete {
        reason: HydrationIncomplete,
        boundary: RecoveryReason,
        native_cursor: Option<EventRecoveryCursor>,
        source_epoch: Option<u64>,
    },
}

impl SessionRecovery {
    /// Converts an ingress observation into a typed recovery boundary.
    pub fn from_observation(
        session_id: SessionId,
        observation: SessionEventObservation,
    ) -> Option<Self> {
        match observation {
            SessionEventObservation::Gap { expected, received } => Some(Self::RecoveryRequired {
                reason: RecoveryReason::CursorGap { expected, received },
                source_epoch: None,
                native_cursor: Some(cursor_before(session_id, expected)),
            }),
            SessionEventObservation::Stale { cursor, received } => Some(Self::RecoveryRequired {
                reason: RecoveryReason::CursorStale { cursor, received },
                source_epoch: None,
                native_cursor: Some(EventRecoveryCursor::resume_after(session_id, cursor)),
            }),
            SessionEventObservation::Closed { cursor } => Some(Self::Incomplete {
                reason: HydrationIncomplete::ConnectionInterrupted,
                boundary: RecoveryReason::ConnectionClosed { cursor },
                source_epoch: None,
                native_cursor: Some(EventRecoveryCursor::resume_after(session_id, cursor)),
            }),
            SessionEventObservation::Accepted { .. }
            | SessionEventObservation::Duplicate { .. }
            | SessionEventObservation::OutOfSession { .. } => None,
        }
    }

    /// Converts the bounded ingress boundary without retaining its event.
    pub(crate) fn from_raw_event(
        session_id: SessionId,
        native_cursor: Sequence,
        event: &RawEvent,
    ) -> Option<Self> {
        match event {
            RawEvent::Overflow => Some(Self::RecoveryRequired {
                reason: RecoveryReason::EventOverflow,
                source_epoch: None,
                native_cursor: Some(EventRecoveryCursor::resume_after(session_id, native_cursor)),
            }),
            RawEvent::Closed => Some(Self::Incomplete {
                reason: HydrationIncomplete::ConnectionInterrupted,
                boundary: RecoveryReason::ConnectionClosed {
                    cursor: native_cursor,
                },
                source_epoch: None,
                native_cursor: Some(EventRecoveryCursor::resume_after(session_id, native_cursor)),
            }),
            RawEvent::Envelope(_) => None,
        }
    }

    /// A broadcast lag means that native events were dropped and replay is
    /// required; it is never treated as a terminal observation.
    pub fn from_broadcast_lagged(
        session_id: SessionId,
        native_cursor: Sequence,
        skipped: u64,
    ) -> Self {
        Self::RecoveryRequired {
            reason: RecoveryReason::BroadcastLagged { skipped },
            source_epoch: None,
            native_cursor: Some(EventRecoveryCursor::resume_after(session_id, native_cursor)),
        }
    }

    /// Converts a native projection rejection into an incomplete boundary.
    ///
    /// The rejected event has already advanced the native projector cursor, so
    /// that sequence remains the only cursor this result carries.
    pub fn from_projection_rejection(
        session_id: SessionId,
        sequence: Sequence,
        native_cursor: Sequence,
        reason: ProjectionRecoveryReason,
    ) -> Self {
        Self::Incomplete {
            reason: HydrationIncomplete::ProtocolRejected,
            boundary: RecoveryReason::ProjectionRejected { sequence, reason },
            source_epoch: None,
            native_cursor: Some(EventRecoveryCursor::resume_after(session_id, native_cursor)),
        }
    }

    /// A peer restart interrupts the native stream. Reconnect alone does not
    /// assert that replay happened.
    pub fn from_restart(session_id: SessionId, native_cursor: Sequence) -> Self {
        Self::Incomplete {
            reason: HydrationIncomplete::ConnectionInterrupted,
            boundary: RecoveryReason::Restart,
            source_epoch: None,
            native_cursor: Some(EventRecoveryCursor::resume_after(session_id, native_cursor)),
        }
    }

    /// Reports an incomplete native replay boundary without promoting it to a
    /// complete snapshot. A boundary that reached the peer's reported cursor
    /// does not produce recovery by itself.
    pub fn from_replay_boundary(
        session_id: SessionId,
        boundary: NativeReplayBoundary,
    ) -> Option<Self> {
        if boundary.reached_reported_last() {
            return None;
        }
        let native_cursor = boundary.observed_last().unwrap_or_else(zero_sequence);
        Some(Self::Incomplete {
            reason: HydrationIncomplete::ReplayIncomplete,
            boundary: RecoveryReason::ReplayBoundary {
                observed_last: boundary.observed_last(),
                reported_last: boundary.reported_last(),
                reported_event_count: boundary.reported_event_count(),
            },
            source_epoch: None,
            native_cursor: Some(EventRecoveryCursor::resume_after(session_id, native_cursor)),
        })
    }

    pub fn reason(&self) -> &RecoveryReason {
        match self {
            Self::RecoveryRequired { reason, .. } => reason,
            Self::Incomplete { boundary, .. } => boundary,
        }
    }

    pub fn projection_rejection(&self) -> Option<(Sequence, ProjectionRecoveryReason)> {
        match self.reason() {
            RecoveryReason::ProjectionRejected { sequence, reason } => Some((*sequence, *reason)),
            _ => None,
        }
    }

    pub fn native_cursor(&self) -> Option<&EventRecoveryCursor> {
        match self {
            Self::RecoveryRequired { native_cursor, .. }
            | Self::Incomplete { native_cursor, .. } => native_cursor.as_ref(),
        }
    }

    pub fn with_source_epoch(mut self, epoch: u64) -> Self {
        match &mut self {
            Self::RecoveryRequired { source_epoch, .. } | Self::Incomplete { source_epoch, .. } => {
                *source_epoch = Some(epoch)
            }
        }
        self
    }

    pub const fn source_epoch(&self) -> Option<u64> {
        match self {
            Self::RecoveryRequired { source_epoch, .. } | Self::Incomplete { source_epoch, .. } => {
                *source_epoch
            }
        }
    }

    pub const fn hydration_reason(&self) -> HydrationIncomplete {
        match self {
            Self::RecoveryRequired { .. } => HydrationIncomplete::ReplayRecoveryRequired,
            Self::Incomplete { reason, .. } => *reason,
        }
    }
}

fn cursor_before(session_id: SessionId, expected: Sequence) -> EventRecoveryCursor {
    EventRecoveryCursor::resume_after(
        session_id,
        Sequence::try_new(expected.get().saturating_sub(1))
            .expect("a valid expected sequence has a valid preceding cursor"),
    )
}

fn zero_sequence() -> Sequence {
    Sequence::try_new(0).expect("zero is a valid native replay cursor")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        client::{EventReplay, EventReplayPayload},
        events::SessionEventObservation,
        facts::NativeSessionFacts,
        hydration::{HydrationSnapshot, HydrationWindow},
        model::{
            EventId, RuntimeKind, Sequence, SessionRecord, SessionSnapshot, WorkerRuntimeState,
        },
        protocol_event::{Event, EventEnvelope},
    };

    fn session_id() -> SessionId {
        SessionId::try_new("recovery-session").unwrap()
    }

    fn sequence(value: u64) -> Sequence {
        Sequence::try_new(value).unwrap()
    }

    fn native_session(last_seq: u64) -> SessionRecord {
        SessionRecord {
            session_id: session_id(),
            created_at: "created".into(),
            updated_at: "updated".into(),
            title: None,
            runtime: RuntimeKind::MatchaAgent,
            transcript_ref: None,
            has_conversation: Some(true),
            last_seq: sequence(last_seq),
            last_snapshot_version: 1,
            model: None,
            permission_mode: None,
            worker_state: WorkerRuntimeState::Unloaded {
                reason: crate::session::model::UnloadedReason::NotStarted,
            },
        }
    }

    fn replay_event(sequence: Sequence) -> EventEnvelope {
        EventEnvelope {
            event_id: EventId::try_new(format!("event-{}", sequence.get())).unwrap(),
            session_id: session_id(),
            seq: sequence,
            run_id: None,
            worker_id: None,
            created_at: "now".into(),
            event: Event::try_new(serde_json::json!({
                "type": "message.delta",
                "messageId": "message-native",
                "delta": "payload"
            }))
            .unwrap(),
        }
    }

    fn boundary(
        observed_last: Option<u64>,
        reported_last: u64,
        reported_event_count: usize,
    ) -> NativeReplayBoundary {
        let events = observed_last
            .map(sequence)
            .map(replay_event)
            .into_iter()
            .collect();
        let last_seq = native_session(reported_last);
        let snapshot = SessionSnapshot {
            session: last_seq.clone(),
            version: 1,
            updated_at: "snapshot".into(),
            runs: Vec::new(),
            messages: Vec::new(),
            pending_approvals: Vec::new(),
            usage: None,
        };
        NativeSessionFacts::from_native(
            last_seq,
            snapshot,
            HydrationSnapshot::new(Vec::new(), HydrationWindow::new(0, 0, 0)),
            EventReplayPayload::new(
                EventReplay::new(reported_event_count, sequence(reported_last)),
                events,
            ),
        )
        .expect("test replay facts should be valid")
        .replay_boundary()
    }

    #[test]
    fn gap_is_recovery_required_with_only_native_cursor() {
        let result = SessionRecovery::from_observation(
            session_id(),
            SessionEventObservation::Gap {
                expected: sequence(5),
                received: sequence(7),
            },
        )
        .expect("gap must require recovery");

        assert!(matches!(
            result,
            SessionRecovery::RecoveryRequired {
                reason: RecoveryReason::CursorGap { expected, received },
                ..
            } if expected == sequence(5) && received == sequence(7)
        ));
        assert_eq!(result.native_cursor().unwrap().sequence(), sequence(4));
        assert_eq!(result.source_epoch(), None);
        assert_eq!(
            result.hydration_reason(),
            HydrationIncomplete::ReplayRecoveryRequired
        );
    }

    #[test]
    fn projection_rejection_preserves_native_provenance_without_host_cursor() {
        let recovery = SessionRecovery::from_projection_rejection(
            session_id(),
            sequence(11),
            sequence(10),
            ProjectionRecoveryReason::Malformed,
        );

        assert_eq!(
            recovery.projection_rejection(),
            Some((sequence(11), ProjectionRecoveryReason::Malformed))
        );
        assert_eq!(recovery.native_cursor().unwrap().sequence(), sequence(10));
        assert_eq!(recovery.source_epoch(), None);
        assert_eq!(
            recovery.hydration_reason(),
            HydrationIncomplete::ProtocolRejected
        );
    }

    #[test]
    fn overflow_closed_and_lagged_are_not_terminals() {
        let overflow =
            SessionRecovery::from_raw_event(session_id(), sequence(8), &RawEvent::Overflow)
                .expect("overflow must require recovery");
        assert!(matches!(
            overflow,
            SessionRecovery::RecoveryRequired {
                reason: RecoveryReason::EventOverflow,
                ..
            }
        ));

        let closed = SessionRecovery::from_raw_event(session_id(), sequence(8), &RawEvent::Closed)
            .expect("close must remain incomplete");
        assert!(matches!(
            closed,
            SessionRecovery::Incomplete {
                reason: HydrationIncomplete::ConnectionInterrupted,
                boundary: RecoveryReason::ConnectionClosed { cursor },
                ..
            } if cursor == sequence(8)
        ));

        let lagged = SessionRecovery::from_broadcast_lagged(session_id(), sequence(8), 3);
        assert!(matches!(
            lagged,
            SessionRecovery::RecoveryRequired {
                reason: RecoveryReason::BroadcastLagged { skipped: 3 },
                ..
            }
        ));
    }

    #[test]
    fn restart_is_incomplete_and_does_not_claim_replay() {
        let result = SessionRecovery::from_restart(session_id(), sequence(9));
        assert!(matches!(
            result,
            SessionRecovery::Incomplete {
                reason: HydrationIncomplete::ConnectionInterrupted,
                boundary: RecoveryReason::Restart,
                ..
            }
        ));
        assert_eq!(result.native_cursor().unwrap().sequence(), sequence(9));
    }

    #[test]
    fn incomplete_replay_boundary_preserves_native_report_without_completion() {
        let result = SessionRecovery::from_replay_boundary(session_id(), boundary(Some(4), 6, 3))
            .expect("short replay must remain incomplete");
        assert!(matches!(
            result,
            SessionRecovery::Incomplete {
                reason: HydrationIncomplete::ReplayIncomplete,
                boundary: RecoveryReason::ReplayBoundary {
                    observed_last: Some(observed),
                    reported_last,
                    reported_event_count: 3,
                },
                ..
            } if observed == sequence(4) && reported_last == sequence(6)
        ));
        assert_eq!(result.native_cursor().unwrap().sequence(), sequence(4));
        assert_eq!(
            SessionRecovery::from_replay_boundary(session_id(), boundary(Some(6), 6, 3)),
            None
        );
        assert_eq!(
            SessionRecovery::from_replay_boundary(session_id(), boundary(None, 0, 0)),
            None
        );
    }

    #[test]
    fn ordinary_observations_do_not_create_recovery() {
        assert_eq!(
            SessionRecovery::from_observation(
                session_id(),
                SessionEventObservation::Accepted {
                    sequence: sequence(1),
                },
            ),
            None
        );
        assert_eq!(
            SessionRecovery::from_observation(
                session_id(),
                SessionEventObservation::Duplicate {
                    sequence: sequence(1),
                },
            ),
            None
        );
        assert_eq!(
            SessionRecovery::from_observation(
                session_id(),
                SessionEventObservation::OutOfSession {
                    sequence: sequence(1),
                },
            ),
            None
        );
    }
}
