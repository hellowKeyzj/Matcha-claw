use std::fmt;

use crate::session::approval::ApprovalRecord;
use crate::session::catalog::SessionCatalogFacts;
use crate::session::{
    client::{EventRecoveryCursor, EventReplayPayload},
    events::{EventActivity, EventRejection, project_native_activity},
    hydration::HydrationSnapshot,
    model::{
        EventId, RunId, RunRecord, Sequence, SessionId, SessionRecord, SessionSnapshot,
        UsageSummary,
    },
    protocol_event::EventEnvelope,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeEventSource {
    Snapshot,
    Replay,
}

/// The source-backed activity family retained for one native event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeEventKind {
    Run,
    Message,
    Tool,
    Approval,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeReplayBoundary {
    observed_first: Option<Sequence>,
    observed_last: Option<Sequence>,
    reported_last: Sequence,
    reported_event_count: usize,
}

impl NativeReplayBoundary {
    pub fn observed_first(self) -> Option<Sequence> {
        self.observed_first
    }

    pub fn observed_last(self) -> Option<Sequence> {
        self.observed_last
    }

    pub fn reported_last(self) -> Sequence {
        self.reported_last
    }

    pub fn reported_event_count(self) -> usize {
        self.reported_event_count
    }

    /// True only when the native replay response reported the session boundary.
    /// It does not claim that the bounded event vector is a full transcript.
    pub fn reached_reported_last(self) -> bool {
        self.observed_last == Some(self.reported_last)
            || (self.reported_event_count == 0 && self.reported_last.get() == 0)
    }
}

#[derive(Clone, PartialEq)]
pub struct NativeEventFact {
    source: NativeEventSource,
    event_id: EventId,
    sequence: Sequence,
    run_id: Option<RunId>,
    activity: EventActivity,
}

impl NativeEventFact {
    fn new(source: NativeEventSource, envelope: &EventEnvelope, activity: EventActivity) -> Self {
        Self {
            source,
            event_id: envelope.event_id.clone(),
            sequence: envelope.seq,
            run_id: envelope.run_id.clone(),
            activity,
        }
    }

    pub fn source(&self) -> NativeEventSource {
        self.source
    }

    pub fn event_id(&self) -> &EventId {
        &self.event_id
    }

    pub fn sequence(&self) -> Sequence {
        self.sequence
    }

    pub fn run_id(&self) -> Option<&RunId> {
        self.run_id.as_ref()
    }

    pub fn activity(&self) -> &EventActivity {
        &self.activity
    }

    pub fn kind(&self) -> NativeEventKind {
        match self.activity {
            EventActivity::Run(_) | EventActivity::RunFailed { .. } => NativeEventKind::Run,
            EventActivity::Message(_) => NativeEventKind::Message,
            EventActivity::Tool(_) => NativeEventKind::Tool,
            EventActivity::Approval(_) => NativeEventKind::Approval,
            EventActivity::Ignored => unreachable!("ignored events are not retained"),
        }
    }

    pub fn has_terminal_provenance(&self) -> bool {
        matches!(
            self.activity,
            EventActivity::Run(
                crate::session::events::RunLifecycle::Cancelled
                    | crate::session::events::RunLifecycle::Completed
                    | crate::session::events::RunLifecycle::Interrupted
            ) | EventActivity::RunFailed { .. }
        )
    }
}

impl fmt::Debug for NativeEventFact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeEventFact")
            .field("source", &self.source)
            .field("sequence", &self.sequence)
            .field("activity", &self.activity)
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub struct NativeSessionFacts {
    session: SessionRecord,
    snapshot_version: u64,
    snapshot_updated_at: String,
    runs: Vec<RunRecord>,
    transcript: HydrationSnapshot,
    snapshot_events: Vec<NativeEventFact>,
    replay_events: Vec<NativeEventFact>,
    replay_boundary: NativeReplayBoundary,
    pending_approvals: Vec<ApprovalRecord>,
    usage: Option<UsageSummary>,
    replay_cursor: EventRecoveryCursor,
}

impl NativeSessionFacts {
    pub(crate) fn from_native(
        loaded: SessionRecord,
        snapshot: SessionSnapshot,
        transcript: HydrationSnapshot,
        replay: EventReplayPayload,
    ) -> Result<Self, NativeFactsError> {
        let SessionSnapshot {
            session,
            version,
            updated_at,
            runs,
            messages,
            pending_approvals,
            usage,
        } = snapshot;

        if loaded.session_id != session.session_id {
            return Err(NativeFactsError::SessionIdentityMismatch);
        }
        let session_id = session.session_id.clone();
        if replay.cursor().get() != session.last_seq.get() {
            return Err(NativeFactsError::ReplayCursorMismatch);
        }
        let replay_event_count = replay.event_count();
        validate_envelope_order(&messages)?;
        validate_envelope_order(replay.events())?;

        let snapshot_events = project_events(&session_id, NativeEventSource::Snapshot, &messages)?;
        let replay_events =
            project_events(&session_id, NativeEventSource::Replay, replay.events())?;
        validate_event_order(&snapshot_events)?;
        validate_event_order(&replay_events)?;
        let replay_boundary = replay_boundary(replay.cursor(), replay_event_count, replay.events());
        if replay_boundary.reported_last() != session.last_seq {
            return Err(NativeFactsError::ReplayCursorMismatch);
        }

        Ok(Self {
            session,
            snapshot_version: version,
            snapshot_updated_at: updated_at,
            runs,
            transcript,
            snapshot_events,
            replay_events,
            replay_boundary,
            pending_approvals,
            usage,
            replay_cursor: EventRecoveryCursor::resume_after(session_id, replay.cursor()),
        })
    }

    pub fn session(&self) -> &SessionRecord {
        &self.session
    }

    pub fn catalog(&self) -> SessionCatalogFacts<'_> {
        SessionCatalogFacts::from_native(&self.session)
    }

    pub fn transcript(&self) -> &HydrationSnapshot {
        &self.transcript
    }

    pub fn snapshot_version(&self) -> u64 {
        self.snapshot_version
    }

    pub fn snapshot_updated_at(&self) -> &str {
        &self.snapshot_updated_at
    }

    pub fn runs(&self) -> &[RunRecord] {
        &self.runs
    }

    pub fn snapshot_events(&self) -> &[NativeEventFact] {
        &self.snapshot_events
    }

    pub fn replay_events(&self) -> &[NativeEventFact] {
        &self.replay_events
    }

    pub fn replay_event_count(&self) -> usize {
        self.replay_boundary.reported_event_count()
    }

    pub fn replay_boundary(&self) -> NativeReplayBoundary {
        self.replay_boundary
    }

    pub fn has_complete_replay_boundary(&self) -> bool {
        self.replay_boundary.reached_reported_last()
    }

    pub fn pending_approvals(&self) -> &[ApprovalRecord] {
        &self.pending_approvals
    }

    pub fn usage(&self) -> Option<UsageSummary> {
        self.usage
    }

    pub fn replay_cursor(&self) -> &EventRecoveryCursor {
        &self.replay_cursor
    }
}

impl fmt::Debug for NativeSessionFacts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeSessionFacts")
            .field("snapshot_version", &self.snapshot_version)
            .field("snapshot_event_count", &self.snapshot_events.len())
            .field("replay_event_count", &self.replay_event_count())
            .field(
                "replay_boundary_complete",
                &self.has_complete_replay_boundary(),
            )
            .field("run_count", &self.runs.len())
            .field("pending_approval_count", &self.pending_approvals.len())
            .field("has_usage", &self.usage.is_some())
            .field("replay_cursor", &self.replay_cursor)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeFactsError {
    SessionIdentityMismatch,
    ReplayCursorMismatch,
    EventSequenceInvalid,
    EventRejected,
}

fn replay_boundary(
    reported_last: Sequence,
    reported_event_count: usize,
    events: &[EventEnvelope],
) -> NativeReplayBoundary {
    NativeReplayBoundary {
        observed_first: events.first().map(|event| event.seq),
        observed_last: events.last().map(|event| event.seq),
        reported_last,
        reported_event_count,
    }
}

fn validate_envelope_order(events: &[EventEnvelope]) -> Result<(), NativeFactsError> {
    for event in events {
        if event.seq.get() == 0 {
            return Err(NativeFactsError::EventSequenceInvalid);
        }
    }
    for pair in events.windows(2) {
        if pair[0].seq.get() >= pair[1].seq.get() {
            return Err(NativeFactsError::EventSequenceInvalid);
        }
    }
    Ok(())
}

fn validate_event_order(events: &[NativeEventFact]) -> Result<(), NativeFactsError> {
    for pair in events.windows(2) {
        if pair[0].sequence().get() >= pair[1].sequence().get() {
            return Err(NativeFactsError::EventSequenceInvalid);
        }
    }
    Ok(())
}

fn project_events(
    expected_session_id: &SessionId,
    source: NativeEventSource,
    envelopes: &[EventEnvelope],
) -> Result<Vec<NativeEventFact>, NativeFactsError> {
    let mut projected = Vec::with_capacity(envelopes.len());
    for envelope in envelopes {
        if envelope.session_id != *expected_session_id {
            return Err(NativeFactsError::SessionIdentityMismatch);
        }
        let Some(activity) = project_native_activity(&envelope)
            .map_err(|_: EventRejection| NativeFactsError::EventRejected)?
        else {
            continue;
        };
        projected.push(NativeEventFact::new(source, &envelope, activity));
    }
    Ok(projected)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::session::{
        client::EventReplayPayload,
        events::{EventActivity, MessageLifecycle},
        model::{EventId, RuntimeKind, WorkerRuntimeState},
        protocol_event::Event,
    };

    fn session(id: &str, last_seq: u64) -> SessionRecord {
        SessionRecord {
            session_id: SessionId::try_new(id).unwrap(),
            created_at: "created".into(),
            updated_at: "updated".into(),
            title: None,
            runtime: RuntimeKind::MatchaAgent,
            transcript_ref: None,
            has_conversation: Some(true),
            last_seq: Sequence::try_new(last_seq).unwrap(),
            last_snapshot_version: 3,
            model: None,
            model_selection_id: None,
            provider_fingerprint: None,
            permission_mode: None,
            worker_state: WorkerRuntimeState::Unloaded {
                reason: crate::session::model::UnloadedReason::NotStarted,
            },
        }
    }

    fn envelope(seq: u64, event: serde_json::Value) -> EventEnvelope {
        EventEnvelope {
            event_id: EventId::try_new(format!("event-{seq}")).unwrap(),
            session_id: SessionId::try_new("session-1").unwrap(),
            seq: Sequence::try_new(seq).unwrap(),
            run_id: Some(RunId::try_new("run-1").unwrap()),
            worker_id: None,
            created_at: "now".into(),
            event: Event::try_new(event).unwrap(),
        }
    }

    fn metadata_envelope(seq: u64, event: serde_json::Value) -> EventEnvelope {
        let mut envelope = envelope(seq, event);
        envelope.run_id = None;
        envelope
    }

    fn payload(cursor: u64, events: Vec<EventEnvelope>) -> EventReplayPayload {
        EventReplayPayload::new(
            super::super::client::EventReplay::new(
                events.len(),
                Sequence::try_new(cursor).unwrap(),
            ),
            events,
        )
    }

    #[test]
    fn facts_preserve_native_identity_and_distinct_event_message_identity() {
        let snapshot = SessionSnapshot {
            session: session("session-1", 2),
            version: 4,
            updated_at: "snapshot-updated".into(),
            runs: vec![],
            messages: vec![],
            pending_approvals: vec![],
            usage: None,
        };
        let replay = payload(
            2,
            vec![
                envelope(
                    1,
                    json!({
                        "type": "message.delta",
                        "messageId": "message-native",
                        "delta": "payload"
                    }),
                ),
                envelope(
                    2,
                    json!({"type": "message.completed", "messageId": "message-native"}),
                ),
            ],
        );
        let transcript = HydrationSnapshot::new(
            Vec::new(),
            crate::session::hydration::HydrationWindow::new(0, 0, 0),
        );
        let facts =
            NativeSessionFacts::from_native(session("session-1", 2), snapshot, transcript, replay)
                .expect("native facts should project");

        assert_eq!(facts.session().session_id.as_str(), "session-1");
        assert_eq!(facts.snapshot_version(), 4);
        assert_eq!(facts.replay_cursor().sequence().get(), 2);
        assert_eq!(facts.replay_event_count(), 2);
        assert_eq!(facts.replay_boundary().observed_first().unwrap().get(), 1);
        assert_eq!(facts.replay_boundary().observed_last().unwrap().get(), 2);
        assert_eq!(facts.replay_boundary().reported_last().get(), 2);
        assert!(facts.has_complete_replay_boundary());
        assert_eq!(facts.replay_events()[0].event_id().as_str(), "event-1");
        assert_eq!(facts.replay_events()[0].sequence().get(), 1);
        assert!(matches!(
            facts.replay_events()[0].activity(),
            EventActivity::Message(message)
                if message.message_id().as_str() == "message-native"
                    && message.lifecycle() == MessageLifecycle::Delta
        ));
        assert_ne!(
            facts.replay_events()[0].event_id().as_str(),
            "message-native"
        );
        assert!(!format!("{facts:?}").contains("payload"));
    }

    #[test]
    fn facts_ignore_native_metadata_events_without_run_identity() {
        let session = session("session-1", 2);
        let snapshot = SessionSnapshot {
            session: session.clone(),
            version: 2,
            updated_at: "snapshot-updated".into(),
            runs: vec![],
            messages: vec![],
            pending_approvals: vec![],
            usage: None,
        };
        let replay = payload(
            2,
            vec![
                metadata_envelope(
                    1,
                    json!({
                        "type": "session.loaded",
                        "session": {
                            "sessionId": "session-1",
                            "workspaceRoot": "workspace",
                            "createdAt": "created",
                            "updatedAt": "updated",
                            "runtime": "matcha-agent",
                            "lastSeq": 1,
                            "lastSnapshotVersion": 1,
                            "workerState": {"state":"unloaded","reason":"notStarted"}
                        }
                    }),
                ),
                metadata_envelope(
                    2,
                    json!({"type": "worker.ready", "workerId": "worker-1", "pid": 7}),
                ),
            ],
        );
        let facts = NativeSessionFacts::from_native(
            session,
            snapshot,
            HydrationSnapshot::new(
                Vec::new(),
                crate::session::hydration::HydrationWindow::new(0, 0, 0),
            ),
            replay,
        )
        .expect("metadata events should not poison canonical reads");

        assert_eq!(facts.replay_cursor().sequence().get(), 2);
        assert_eq!(facts.replay_event_count(), 2);
        assert!(facts.replay_events().is_empty());
        assert!(facts.has_complete_replay_boundary());
    }

    #[test]
    fn facts_rejects_out_of_order_native_envelopes_before_projection() {
        let snapshot = SessionSnapshot {
            session: session("session-1", 2),
            version: 1,
            updated_at: "now".into(),
            runs: vec![],
            messages: vec![],
            pending_approvals: vec![],
            usage: None,
        };
        let replay = payload(
            2,
            vec![
                envelope(2, json!({"type": "run.trace", "runId": "run-1"})),
                envelope(1, json!({"type": "run.trace", "runId": "run-1"})),
            ],
        );
        let result = NativeSessionFacts::from_native(
            session("session-1", 2),
            snapshot,
            HydrationSnapshot::new(
                Vec::new(),
                crate::session::hydration::HydrationWindow::new(0, 0, 0),
            ),
            replay,
        );
        assert_eq!(result, Err(NativeFactsError::EventSequenceInvalid));
    }

    #[test]
    fn facts_rejects_zero_sequence_native_envelopes() {
        let snapshot = SessionSnapshot {
            session: session("session-1", 0),
            version: 1,
            updated_at: "now".into(),
            runs: vec![],
            messages: vec![],
            pending_approvals: vec![],
            usage: None,
        };
        let replay = payload(
            0,
            vec![envelope(0, json!({"type": "run.trace", "runId": "run-1"}))],
        );
        let result = NativeSessionFacts::from_native(
            session("session-1", 0),
            snapshot,
            HydrationSnapshot::new(
                Vec::new(),
                crate::session::hydration::HydrationWindow::new(0, 0, 0),
            ),
            replay,
        );
        assert_eq!(result, Err(NativeFactsError::EventSequenceInvalid));
    }

    #[test]
    fn facts_reject_session_or_replay_cursor_mismatch_without_synthesizing_identity() {
        let snapshot = SessionSnapshot {
            session: session("session-1", 1),
            version: 1,
            updated_at: "now".into(),
            runs: vec![],
            messages: vec![],
            pending_approvals: vec![],
            usage: None,
        };
        assert_eq!(
            NativeSessionFacts::from_native(
                session("other", 1),
                snapshot.clone(),
                HydrationSnapshot::new(
                    Vec::new(),
                    crate::session::hydration::HydrationWindow::new(0, 0, 0)
                ),
                payload(1, vec![])
            ),
            Err(NativeFactsError::SessionIdentityMismatch)
        );
        assert_eq!(
            NativeSessionFacts::from_native(
                session("session-1", 1),
                snapshot,
                HydrationSnapshot::new(
                    Vec::new(),
                    crate::session::hydration::HydrationWindow::new(0, 0, 0)
                ),
                payload(0, vec![]),
            ),
            Err(NativeFactsError::ReplayCursorMismatch)
        );
    }
}
