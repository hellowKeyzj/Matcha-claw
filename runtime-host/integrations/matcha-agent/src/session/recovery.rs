use super::model::Sequence;

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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeCursor(Sequence);
impl NativeCursor {
    pub const fn sequence(&self) -> Sequence {
        self.0
    }
}

/// A receive-resource failure is not a run terminal or a Host cursor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRecovery {
    reason: RecoveryReason,
    native_cursor: Option<NativeCursor>,
    source_epoch: Option<u64>,
}
impl SessionRecovery {
    pub fn new(
        reason: RecoveryReason,
        cursor: Option<Sequence>,
        source_epoch: Option<u64>,
    ) -> Self {
        Self {
            reason,
            native_cursor: cursor.map(NativeCursor),
            source_epoch,
        }
    }
    pub const fn reason(&self) -> &RecoveryReason {
        &self.reason
    }
    pub fn native_cursor(&self) -> Option<&NativeCursor> {
        self.native_cursor.as_ref()
    }
    pub const fn source_epoch(&self) -> Option<u64> {
        self.source_epoch
    }
}
