use std::fmt;

use super::{
    events::{SessionEventProvenance, TerminalOutcome},
    facts::{
        BoundedHistoryFacts, LiveSessionFacts, NativeCursor, NativeFactGap, NativeFactRead,
        SessionIdentityFacts, SessionRuntimeFacts,
    },
    protocol::{
        ChatState, MessageActivityLifecycle, MessageId, RunId, SessionActivityKind,
        SessionErrorKind, SessionEventEnvelope, SessionEventKind, SessionKey, SessionSummary,
        ToolActivityPhase, ToolId,
    },
};

#[derive(Clone, Eq, PartialEq)]
pub enum CanonicalIngressResult {
    Produced(CanonicalSessionDelta),
    Unknown { provenance: SessionEventProvenance },
}

impl fmt::Debug for CanonicalIngressResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Produced(delta) => formatter.debug_tuple("Produced").field(delta).finish(),
            Self::Unknown { provenance } => formatter
                .debug_struct("Unknown")
                .field("provenance", provenance)
                .finish(),
        }
    }
}

/// A source-backed live delta draft. It is not the Host `SessionDelta` DTO:
/// source epoch/cursor stay optional and no Host sequence is synthesized.
#[derive(Clone, Eq, PartialEq)]
pub struct CanonicalSessionDelta {
    session_key: SessionKey,
    route_key: Option<String>,
    source_epoch: Option<u64>,
    source_cursor: Option<u64>,
    run_id: Option<RunId>,
    provenance: SessionEventProvenance,
    changes: Vec<CanonicalSessionChange>,
}

impl CanonicalSessionDelta {
    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn route_key(&self) -> Option<&str> {
        self.route_key.as_deref()
    }

    pub const fn source_epoch(&self) -> Option<u64> {
        self.source_epoch
    }

    pub const fn source_cursor(&self) -> Option<u64> {
        self.source_cursor
    }

    pub fn run_id(&self) -> Option<&RunId> {
        self.run_id.as_ref()
    }

    pub fn provenance(&self) -> &SessionEventProvenance {
        &self.provenance
    }

    pub fn changes(&self) -> &[CanonicalSessionChange] {
        &self.changes
    }
}

impl fmt::Debug for CanonicalSessionDelta {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalSessionDelta")
            .field("source_epoch", &self.source_epoch)
            .field("source_cursor", &self.source_cursor)
            .field("has_run_id", &self.run_id.is_some())
            .field("change_count", &self.changes.len())
            .field("provenance", &self.provenance)
            .finish()
    }
}

/// Typed changes that OpenClaw actually emitted. No change is a Renderer item
/// snapshot or a transcript accumulator.
#[derive(Clone, Eq, PartialEq)]
pub enum CanonicalSessionChange {
    RunDelta {
        run_id: RunId,
        message_id: Option<MessageId>,
        text: String,
        replace: bool,
    },
    MessageActivity {
        run_id: RunId,
        message_id: MessageId,
        lifecycle: MessageActivityLifecycle,
        text: Option<String>,
    },
    ToolActivity {
        run_id: RunId,
        tool_id: ToolId,
        tool_name: Option<String>,
        phase: ToolActivityPhase,
        summary: Option<String>,
    },
    Terminal {
        run_id: RunId,
        outcome: TerminalOutcome,
        message_id: Option<MessageId>,
        message_text: Option<String>,
        error_kind: Option<SessionErrorKind>,
        stop_reason: Option<String>,
    },
    RecoveryRequired {
        reason: CanonicalRecoveryReason,
    },
}

impl fmt::Debug for CanonicalSessionChange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RunDelta { replace, text, .. } => formatter
                .debug_struct("RunDelta")
                .field("replace", replace)
                .field("text_bytes", &text.len())
                .finish(),
            Self::MessageActivity {
                lifecycle, text, ..
            } => formatter
                .debug_struct("MessageActivity")
                .field("lifecycle", lifecycle)
                .field("has_text", &text.is_some())
                .finish(),
            Self::ToolActivity {
                phase,
                tool_name,
                summary,
                ..
            } => formatter
                .debug_struct("ToolActivity")
                .field("phase", phase)
                .field("has_tool_name", &tool_name.is_some())
                .field("has_summary", &summary.is_some())
                .finish(),
            Self::Terminal {
                outcome,
                message_id,
                error_kind,
                stop_reason,
                ..
            } => formatter
                .debug_struct("Terminal")
                .field("outcome", outcome)
                .field("has_message_id", &message_id.is_some())
                .field("error_kind", error_kind)
                .field("has_stop_reason", &stop_reason.is_some())
                .finish(),
            Self::RecoveryRequired { reason } => formatter
                .debug_struct("RecoveryRequired")
                .field("reason", reason)
                .finish(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CanonicalRecoveryReason {
    CursorGap,
    CursorStale,
    EpochChanged,
    EventOverflow,
    NativeUnavailable,
    NativeUnknown,
}

impl CanonicalRecoveryReason {
    pub(crate) const fn from_ingress_error(error: crate::gateway::ingress::IngressError) -> Self {
        match error {
            crate::gateway::ingress::IngressError::EpochNotActive => Self::EpochChanged,
            crate::gateway::ingress::IngressError::StaleEpoch
            | crate::gateway::ingress::IngressError::NonMonotonicSequence => Self::CursorStale,
            crate::gateway::ingress::IngressError::Backpressure => Self::EventOverflow,
            crate::gateway::ingress::IngressError::Closed => Self::NativeUnavailable,
        }
    }
}

/// Minimal stateless producer seam. Gateway ingress owns ordering; this seam
/// only maps one verified native event or an explicit recovery fact.
pub struct CanonicalSessionDeltaProducer;

impl CanonicalSessionDeltaProducer {
    pub fn from_facts(
        facts: &LiveSessionFacts,
        route_key: Option<String>,
    ) -> Option<CanonicalSessionDelta> {
        let cursor = facts.cursor();
        Self::from_native_event(facts.event(), cursor.gateway_epoch(), route_key)
    }

    pub(crate) fn from_ingress_error(
        session_key: SessionKey,
        route_key: Option<String>,
        source_epoch: Option<crate::gateway::ingress::GatewayEpoch>,
        error: crate::gateway::ingress::IngressError,
    ) -> CanonicalSessionDelta {
        Self::recovery(
            session_key,
            route_key,
            source_epoch,
            CanonicalRecoveryReason::from_ingress_error(error),
        )
    }

    pub(crate) fn from_native_event(
        event: &SessionEventEnvelope,
        source_epoch: Option<crate::gateway::ingress::GatewayEpoch>,
        route_key: Option<String>,
    ) -> Option<CanonicalSessionDelta> {
        let run_id = event.run_id.clone();
        let change = match event.kind {
            SessionEventKind::Chat => {
                let chat = event.chat.as_ref()?;
                if event.session_key != chat.session_key || run_id.as_ref() != Some(&chat.run_id) {
                    return None;
                }
                match chat.state {
                    ChatState::Delta => CanonicalSessionChange::RunDelta {
                        run_id: chat.run_id.clone(),
                        message_id: event.message_id.clone(),
                        text: chat.delta_text.clone()?,
                        replace: chat.replace,
                    },
                    state => CanonicalSessionChange::Terminal {
                        run_id: chat.run_id.clone(),
                        outcome: terminal_outcome(state)?,
                        message_id: event.message_id.clone(),
                        message_text: chat.message_text.clone(),
                        error_kind: chat.error_kind,
                        stop_reason: chat.stop_reason.clone(),
                    },
                }
            }
            SessionEventKind::Message | SessionEventKind::Tool => {
                let activity = event.activity.as_ref()?;
                if event.session_key != activity.session_key
                    || run_id.as_ref() != Some(&activity.run_id)
                {
                    return None;
                }
                match activity.kind() {
                    SessionActivityKind::Message {
                        message_id,
                        lifecycle,
                        text,
                    } => CanonicalSessionChange::MessageActivity {
                        run_id: activity.run_id.clone(),
                        message_id: message_id.clone(),
                        lifecycle: *lifecycle,
                        text: text.clone(),
                    },
                    SessionActivityKind::Tool {
                        tool_id,
                        tool_name,
                        phase,
                        summary,
                    } => CanonicalSessionChange::ToolActivity {
                        run_id: activity.run_id.clone(),
                        tool_id: tool_id.clone(),
                        tool_name: tool_name.clone(),
                        phase: *phase,
                        summary: summary.clone(),
                    },
                }
            }
            SessionEventKind::Changed => return None,
        };
        let provenance = SessionEventProvenance::from_native_event(
            event,
            source_epoch.map(crate::gateway::ingress::GatewayEpoch::as_u64),
            route_key.clone(),
        );
        Some(CanonicalSessionDelta {
            session_key: event.session_key.clone(),
            route_key,
            source_epoch: provenance.source_epoch(),
            source_cursor: provenance.source_cursor(),
            run_id,
            provenance,
            changes: vec![change],
        })
    }

    pub(crate) fn recovery(
        session_key: SessionKey,
        route_key: Option<String>,
        source_epoch: Option<crate::gateway::ingress::GatewayEpoch>,
        reason: CanonicalRecoveryReason,
    ) -> CanonicalSessionDelta {
        let provenance = SessionEventProvenance::recovery(
            session_key.clone(),
            route_key.clone(),
            source_epoch.map(crate::gateway::ingress::GatewayEpoch::as_u64),
        );
        CanonicalSessionDelta {
            session_key,
            route_key,
            source_epoch: provenance.source_epoch(),
            source_cursor: None,
            run_id: None,
            provenance,
            changes: vec![CanonicalSessionChange::RecoveryRequired { reason }],
        }
    }
}

fn terminal_outcome(state: ChatState) -> Option<TerminalOutcome> {
    match state {
        ChatState::Final => Some(TerminalOutcome::Completed),
        ChatState::Aborted => Some(TerminalOutcome::Aborted),
        ChatState::Error => Some(TerminalOutcome::Error),
        ChatState::Delta => None,
    }
}

/// A field needed by the public Renderer snapshot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SnapshotField {
    Catalog,
    Runtime,
    Usage,
    Window,
    Items,
    Tools,
    Approvals,
    Media,
    ReplayComplete,
    Snapshot,
}

/// The native producer required for a Renderer snapshot field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SnapshotProducer {
    SessionsListSummary,
    SessionSummaryRuntime,
    SessionSummaryUsage,
    ChatHistory,
    SessionEvent,
    RendererItemAssembler,
    SessionSnapshotProducer,
}

/// Why a source-backed native fact cannot satisfy a Renderer snapshot field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionGapReason {
    SourceUnavailable,
    SourceUnknown,
    Native(NativeFactGap),
    NotProduced,
}

/// A typed, explicit gap in the OpenClaw-to-Renderer projection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProjectionGap {
    field: SnapshotField,
    producer: SnapshotProducer,
    reason: ProjectionGapReason,
}

impl ProjectionGap {
    const fn new(
        field: SnapshotField,
        producer: SnapshotProducer,
        reason: ProjectionGapReason,
    ) -> Self {
        Self {
            field,
            producer,
            reason,
        }
    }

    pub const fn field(self) -> SnapshotField {
        self.field
    }

    pub const fn producer(self) -> SnapshotProducer {
        self.producer
    }

    pub const fn reason(self) -> ProjectionGapReason {
        self.reason
    }
}

const RENDERER_SNAPSHOT_GAPS: &[ProjectionGap] = &[
    ProjectionGap::new(
        SnapshotField::Usage,
        SnapshotProducer::SessionSummaryUsage,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Window,
        SnapshotProducer::RendererItemAssembler,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Items,
        SnapshotProducer::RendererItemAssembler,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Tools,
        SnapshotProducer::SessionEvent,
        ProjectionGapReason::Native(NativeFactGap::ToolFacts),
    ),
    ProjectionGap::new(
        SnapshotField::Approvals,
        SnapshotProducer::SessionEvent,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Media,
        SnapshotProducer::RendererItemAssembler,
        ProjectionGapReason::Native(NativeFactGap::MediaFacts),
    ),
    ProjectionGap::new(
        SnapshotField::ReplayComplete,
        SnapshotProducer::SessionSnapshotProducer,
        ProjectionGapReason::NotProduced,
    ),
    ProjectionGap::new(
        SnapshotField::Snapshot,
        SnapshotProducer::SessionSnapshotProducer,
        ProjectionGapReason::NotProduced,
    ),
];

/// A conflicting native session key was supplied while composing a view.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionError {
    ConflictingSessionIdentity,
}

impl fmt::Display for ProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenClaw session facts have conflicting session identities")
    }
}

impl std::error::Error for ProjectionError {}

/// A typed view over the Gateway fact families that are currently available.
///
/// This is deliberately not `SessionStateSnapshot`: OpenClaw exposes a session
/// summary, bounded history, and live events, but no complete snapshot producer.
/// The view preserves each source's status and never creates run/message/event
/// identity that the Gateway did not send.
#[derive(Clone, PartialEq)]
pub struct NativeSessionProjection {
    identity: NativeFactRead<SessionIdentityFacts>,
    runtime: NativeFactRead<SessionRuntimeFacts>,
    history: NativeFactRead<BoundedHistoryFacts>,
    live_event: NativeFactRead<LiveSessionFacts>,
    gaps: Vec<ProjectionGap>,
}

impl NativeSessionProjection {
    /// Composes independently read native facts after checking their session key.
    ///
    /// A missing key in a bounded history page is retained as a gap; it is never
    /// filled from another fact family.
    pub fn from_reads(
        identity: NativeFactRead<SessionIdentityFacts>,
        runtime: NativeFactRead<SessionRuntimeFacts>,
        history: NativeFactRead<BoundedHistoryFacts>,
        live_event: NativeFactRead<LiveSessionFacts>,
    ) -> Result<Self, ProjectionError> {
        let projection = Self {
            identity,
            runtime,
            history,
            live_event,
            gaps: Vec::new(),
        };
        projection.validate_session_identity()?;
        let gaps = projection.collect_gaps();
        Ok(Self { gaps, ..projection })
    }

    /// Builds the available summary projection. History and event facts remain
    /// unavailable until the corresponding Gateway operation/event is read.
    pub fn from_summary(summary: &SessionSummary) -> Self {
        Self::from_reads(
            SessionIdentityFacts::from_native(summary),
            SessionRuntimeFacts::from_native(summary),
            NativeFactRead::Unavailable,
            NativeFactRead::Unavailable,
        )
        .expect("identity and runtime facts from one summary have one session key")
    }

    pub fn identity(&self) -> &NativeFactRead<SessionIdentityFacts> {
        &self.identity
    }

    pub fn runtime(&self) -> &NativeFactRead<SessionRuntimeFacts> {
        &self.runtime
    }

    pub fn history(&self) -> &NativeFactRead<BoundedHistoryFacts> {
        &self.history
    }

    pub fn live_event(&self) -> &NativeFactRead<LiveSessionFacts> {
        &self.live_event
    }

    /// Returns cursor facts only when the native event supplied them.
    /// Host epoch/seq/cursor values must not be inferred from this value.
    pub fn native_cursor(&self) -> NativeFactRead<NativeCursor> {
        match &self.live_event {
            NativeFactRead::Complete(facts) => NativeFactRead::Complete(facts.cursor()),
            NativeFactRead::Incomplete { facts, gaps } => NativeFactRead::Incomplete {
                facts: facts.cursor(),
                gaps: gaps.clone(),
            },
            NativeFactRead::Unavailable => NativeFactRead::Unavailable,
            NativeFactRead::Unknown => NativeFactRead::Unknown,
        }
    }

    /// Returns only a session key explicitly supplied by one native fact.
    pub fn session_key(&self) -> Option<&SessionKey> {
        self.identity
            .facts()
            .map(SessionIdentityFacts::session_key)
            .or_else(|| self.runtime.facts().map(SessionRuntimeFacts::session_key))
            .or_else(|| {
                self.history
                    .facts()
                    .and_then(BoundedHistoryFacts::session_key)
            })
            .or_else(|| self.live_event.facts().map(LiveSessionFacts::session_key))
    }

    pub fn gaps(&self) -> &[ProjectionGap] {
        &self.gaps
    }

    pub const fn can_build_renderer_snapshot() -> bool {
        false
    }

    pub const fn renderer_snapshot_gaps() -> &'static [ProjectionGap] {
        RENDERER_SNAPSHOT_GAPS
    }

    fn validate_session_identity(&self) -> Result<(), ProjectionError> {
        let mut expected = None;
        for key in [
            self.identity.facts().map(SessionIdentityFacts::session_key),
            self.runtime.facts().map(SessionRuntimeFacts::session_key),
            self.history
                .facts()
                .and_then(BoundedHistoryFacts::session_key),
            self.live_event.facts().map(LiveSessionFacts::session_key),
        ] {
            let Some(key) = key else {
                continue;
            };
            if expected.is_some_and(|expected: &SessionKey| expected != key) {
                return Err(ProjectionError::ConflictingSessionIdentity);
            }
            expected = Some(key);
        }
        Ok(())
    }

    fn collect_gaps(&self) -> Vec<ProjectionGap> {
        let mut gaps = Vec::with_capacity(RENDERER_SNAPSHOT_GAPS.len() + 4);
        append_read_gaps(
            &self.identity,
            SnapshotField::Catalog,
            SnapshotProducer::SessionsListSummary,
            &mut gaps,
        );
        append_read_gaps(
            &self.runtime,
            SnapshotField::Runtime,
            SnapshotProducer::SessionSummaryRuntime,
            &mut gaps,
        );
        append_read_gaps(
            &self.history,
            SnapshotField::Window,
            SnapshotProducer::ChatHistory,
            &mut gaps,
        );
        append_read_gaps(
            &self.live_event,
            SnapshotField::Runtime,
            SnapshotProducer::SessionEvent,
            &mut gaps,
        );
        gaps.extend_from_slice(RENDERER_SNAPSHOT_GAPS);
        gaps
    }
}

fn append_read_gaps<T>(
    read: &NativeFactRead<T>,
    field: SnapshotField,
    producer: SnapshotProducer,
    gaps: &mut Vec<ProjectionGap>,
) {
    match read {
        NativeFactRead::Complete(_) => {}
        NativeFactRead::Incomplete { gaps: native, .. } => {
            gaps.extend(native.iter().copied().map(|reason| {
                ProjectionGap::new(field, producer, ProjectionGapReason::Native(reason))
            }))
        }
        NativeFactRead::Unavailable => gaps.push(ProjectionGap::new(
            field,
            producer,
            ProjectionGapReason::SourceUnavailable,
        )),
        NativeFactRead::Unknown => gaps.push(ProjectionGap::new(
            field,
            producer,
            ProjectionGapReason::SourceUnknown,
        )),
    }
}

impl fmt::Debug for NativeSessionProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeSessionProjection")
            .field("identity_status", &self.identity.status())
            .field("runtime_status", &self.runtime.status())
            .field("history_status", &self.history.status())
            .field("live_event_status", &self.live_event.status())
            .field("gap_count", &self.gaps.len())
            .finish()
    }
}

/// The result of attempting to assemble a public Renderer snapshot.
///
/// There is intentionally no complete variant until OpenClaw supplies a real
/// snapshot producer and a renderer-item assembler.
#[derive(Clone, PartialEq)]
pub enum SnapshotAssembly {
    Incomplete {
        projection: NativeSessionProjection,
        gaps: Vec<ProjectionGap>,
    },
}

impl SnapshotAssembly {
    pub fn projection(&self) -> &NativeSessionProjection {
        match self {
            Self::Incomplete { projection, .. } => projection,
        }
    }

    pub fn gaps(&self) -> &[ProjectionGap] {
        match self {
            Self::Incomplete { gaps, .. } => gaps,
        }
    }

    pub const fn is_incomplete(&self) -> bool {
        true
    }
}

impl fmt::Debug for SnapshotAssembly {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SnapshotAssembly::Incomplete")
            .field("gap_count", &self.gaps().len())
            .field("projection", self.projection())
            .finish()
    }
}

/// Keeps the incomplete boundary explicit for callers that need a snapshot seam.
#[derive(Clone, Copy, Debug, Default)]
pub struct SnapshotAssembler;

impl SnapshotAssembler {
    pub const fn new() -> Self {
        Self
    }

    pub const fn renderer_snapshot_gaps() -> &'static [ProjectionGap] {
        RENDERER_SNAPSHOT_GAPS
    }

    pub const fn can_build_renderer_snapshot() -> bool {
        false
    }

    pub fn assemble(projection: NativeSessionProjection) -> SnapshotAssembly {
        SnapshotAssembly::Incomplete {
            gaps: projection.gaps.clone(),
            projection,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        gateway::{ingress::GatewayEpoch, wire::GatewayEvent},
        session::{
            facts::{BoundedHistoryFacts, LiveSessionFacts, NativeFactStatus},
            protocol::{ChatState, SessionEventKind, decode_session_event},
        },
        session_window::PageRequest,
    };

    fn summary() -> SessionSummary {
        SessionSummary {
            key: SessionKey::try_new("agent:main:session-1").unwrap(),
            kind: super::super::protocol::SessionKind::Direct,
            agent_id: None,
            label: Some("review".into()),
            display_name: Some("Review".into()),
            derived_title: Some("Native title".into()),
            updated_at: Some(42),
            status: Some("idle".into()),
            has_active_run: Some(false),
            model: Some("provider/model".into()),
        }
    }

    fn event(
        name: &str,
        payload: serde_json::Value,
    ) -> super::super::protocol::SessionEventEnvelope {
        decode_session_event(GatewayEvent {
            name: name.into(),
            payload: Some(payload),
            sequence: Some(8),
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    #[test]
    fn summary_projection_preserves_native_facts_and_marks_missing_producers() {
        let projection = NativeSessionProjection::from_summary(&summary());
        assert_eq!(
            projection.session_key().unwrap().as_str(),
            "agent:main:session-1"
        );
        assert_eq!(projection.identity().status(), NativeFactStatus::Complete);
        assert_eq!(projection.runtime().status(), NativeFactStatus::Complete);
        assert_eq!(projection.history().status(), NativeFactStatus::Unavailable);
        assert_eq!(
            projection.live_event().status(),
            NativeFactStatus::Unavailable
        );
        assert!(!NativeSessionProjection::can_build_renderer_snapshot());
        assert!(projection.gaps().iter().any(|gap| {
            gap.field() == SnapshotField::Usage
                && gap.producer() == SnapshotProducer::SessionSummaryUsage
                && gap.reason() == ProjectionGapReason::NotProduced
        }));
        assert!(projection.gaps().iter().any(|gap| {
            gap.field() == SnapshotField::Items && gap.reason() == ProjectionGapReason::NotProduced
        }));
        assert!(
            projection
                .gaps()
                .iter()
                .any(|gap| { gap.field() == SnapshotField::Window })
        );
    }

    #[test]
    fn history_and_live_facts_remain_source_backed_and_identity_checked() {
        let history = BoundedHistoryFacts::decode(
            json!({
                "sessionKey":"agent:main:session-1",
                "messages":[
                    {"role":"user","messageId":"message-1","runId":"run-1","seq":7,"content":"hello"}
                ]
            }),
            PageRequest::latest(),
        )
        .unwrap();
        let live = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":7,
                    "state":"delta",
                    "deltaText":"partial"
                }),
            ),
            Some(GatewayEpoch::try_new(1).unwrap()),
        );
        let projection = NativeSessionProjection::from_reads(
            SessionIdentityFacts::from_native(&summary()),
            SessionRuntimeFacts::from_native(&summary()),
            history,
            live,
        )
        .unwrap();
        assert_eq!(
            projection
                .history()
                .facts()
                .unwrap()
                .window()
                .messages()
                .len(),
            1
        );
        assert_eq!(
            projection.live_event().facts().unwrap().chat_state(),
            Some(ChatState::Delta)
        );
        assert_eq!(
            projection.live_event().facts().unwrap().event().kind,
            SessionEventKind::Chat
        );
        assert_eq!(
            projection
                .live_event()
                .facts()
                .unwrap()
                .run_id()
                .unwrap()
                .as_str(),
            "run-1"
        );
        assert_eq!(
            projection.live_event().facts().unwrap().gateway_sequence(),
            Some(8)
        );
    }

    #[test]
    fn conflicting_native_session_keys_fail_without_crosswalk() {
        let mut other = summary();
        other.key = SessionKey::try_new("agent:main:other-session").unwrap();
        let result = NativeSessionProjection::from_reads(
            SessionIdentityFacts::from_native(&summary()),
            SessionRuntimeFacts::from_native(&other),
            NativeFactRead::Unavailable,
            NativeFactRead::Unavailable,
        );
        assert_eq!(result, Err(ProjectionError::ConflictingSessionIdentity));
    }

    #[test]
    fn canonical_delta_preserves_native_chat_cursor_and_provenance() {
        let read = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":7,
                    "state":"delta",
                    "deltaText":"private delta"
                }),
            ),
            Some(GatewayEpoch::try_new(4).unwrap()),
        );
        let delta =
            CanonicalSessionDeltaProducer::from_facts(read.facts().unwrap(), Some("route".into()))
                .expect("native chat delta has a typed change");
        assert_eq!(delta.source_epoch(), Some(4));
        assert_eq!(delta.source_cursor(), Some(8));
        assert_eq!(delta.run_id().unwrap().as_str(), "run-1");
        assert_eq!(delta.provenance().source_epoch(), Some(4));
        assert_eq!(delta.provenance().source_cursor(), Some(8));
        assert!(matches!(
            delta.changes(),
            [CanonicalSessionChange::RunDelta {
                run_id,
                message_id: None,
                text,
                replace: false
            }] if run_id.as_str() == "run-1" && text == "private delta"
        ));
        let debug = format!("{delta:?}");
        for private_value in ["agent:main:session-1", "run-1", "private delta"] {
            assert!(!debug.contains(private_value));
        }
    }

    #[test]
    fn canonical_delta_projects_real_message_tool_and_terminal_facts() {
        let message = LiveSessionFacts::from_native_at_epoch(
            event(
                "session.message",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "messageId":"message-1",
                    "lifecycle":"delta",
                    "message":{"content":"message text"}
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let message_delta =
            CanonicalSessionDeltaProducer::from_facts(message.facts().unwrap(), None)
                .expect("native message activity has a typed change");
        assert!(matches!(
            message_delta.changes(),
            [CanonicalSessionChange::MessageActivity {
                run_id,
                message_id,
                lifecycle: MessageActivityLifecycle::Delta,
                text: Some(text)
            }] if run_id.as_str() == "run-1"
                && message_id.as_str() == "message-1"
                && text == "message text"
        ));
        assert_eq!(message_delta.source_epoch(), Some(5));
        assert_eq!(message_delta.source_cursor(), Some(8));

        let tool = LiveSessionFacts::from_native_at_epoch(
            event(
                "session.tool",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "phase":"failed",
                    "toolCallId":"tool-1",
                    "toolName":"read",
                    "summary":"tool summary"
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let tool_delta = CanonicalSessionDeltaProducer::from_facts(tool.facts().unwrap(), None)
            .expect("native tool activity has a typed change");
        assert!(matches!(
            tool_delta.changes(),
            [CanonicalSessionChange::ToolActivity {
                run_id,
                tool_id,
                tool_name: Some(tool_name),
                phase: ToolActivityPhase::Failed,
                summary: Some(summary)
            }] if run_id.as_str() == "run-1"
                && tool_id.as_str() == "tool-1"
                && tool_name == "read"
                && summary == "tool summary"
        ));

        let terminal = LiveSessionFacts::from_native_at_epoch(
            event(
                "chat",
                json!({
                    "sessionKey":"agent:main:session-1",
                    "runId":"run-1",
                    "seq":8,
                    "state":"final"
                }),
            ),
            Some(GatewayEpoch::try_new(5).unwrap()),
        );
        let terminal_delta =
            CanonicalSessionDeltaProducer::from_facts(terminal.facts().unwrap(), None)
                .expect("native terminal has a typed change");
        assert!(matches!(
            terminal_delta.changes(),
            [CanonicalSessionChange::Terminal {
                run_id,
                outcome: TerminalOutcome::Completed,
                message_id: None,
                message_text: None,
                error_kind: None,
                stop_reason: None
            }] if run_id.as_str() == "run-1"
        ));
    }

    #[test]
    fn canonical_delta_keeps_missing_gateway_position_unknown() {
        let event = decode_session_event(GatewayEvent {
            name: "chat".into(),
            payload: Some(json!({
                "sessionKey":"agent:main:session-1",
                "runId":"run-1",
                "seq":7,
                "state":"delta",
                "deltaText":"delta"
            })),
            sequence: None,
            state_version: None,
        })
        .unwrap()
        .unwrap();
        let delta = CanonicalSessionDeltaProducer::from_native_event(&event, None, None)
            .expect("chat sequence is enough for the typed chat change");
        assert_eq!(delta.source_epoch(), None);
        assert_eq!(delta.source_cursor(), None);
        assert_eq!(delta.provenance().source_epoch(), None);
        assert_eq!(delta.provenance().source_cursor(), None);
    }

    #[test]
    fn changed_event_is_not_promoted_and_recovery_is_explicit() {
        let changed = event(
            "sessions.changed",
            json!({"sessionKey":"agent:main:session-1"}),
        );
        assert!(
            CanonicalSessionDeltaProducer::from_native_event(
                &changed,
                Some(crate::gateway::ingress::GatewayEpoch::try_new(2).unwrap()),
                None,
            )
            .is_none()
        );

        for reason in [
            CanonicalRecoveryReason::CursorGap,
            CanonicalRecoveryReason::CursorStale,
            CanonicalRecoveryReason::EpochChanged,
            CanonicalRecoveryReason::EventOverflow,
            CanonicalRecoveryReason::NativeUnavailable,
            CanonicalRecoveryReason::NativeUnknown,
        ] {
            let recovery = CanonicalSessionDeltaProducer::recovery(
                SessionKey::try_new("agent:main:session-1").unwrap(),
                Some("route".into()),
                Some(crate::gateway::ingress::GatewayEpoch::try_new(3).unwrap()),
                reason,
            );
            assert_eq!(recovery.source_epoch(), Some(3));
            assert_eq!(recovery.source_cursor(), None);
            assert_eq!(recovery.run_id(), None);
            assert!(matches!(
                recovery.changes(),
                [CanonicalSessionChange::RecoveryRequired { reason: actual }] if *actual == reason
            ));
        }
    }

    #[test]
    fn ingress_faults_become_source_backed_recovery_deltas() {
        for (error, reason) in [
            (
                crate::gateway::ingress::IngressError::EpochNotActive,
                CanonicalRecoveryReason::EpochChanged,
            ),
            (
                crate::gateway::ingress::IngressError::StaleEpoch,
                CanonicalRecoveryReason::CursorStale,
            ),
            (
                crate::gateway::ingress::IngressError::NonMonotonicSequence,
                CanonicalRecoveryReason::CursorStale,
            ),
            (
                crate::gateway::ingress::IngressError::Backpressure,
                CanonicalRecoveryReason::EventOverflow,
            ),
            (
                crate::gateway::ingress::IngressError::Closed,
                CanonicalRecoveryReason::NativeUnavailable,
            ),
        ] {
            let recovery = CanonicalSessionDeltaProducer::from_ingress_error(
                SessionKey::try_new("agent:main:session-1").unwrap(),
                Some("route".into()),
                Some(GatewayEpoch::try_new(9).unwrap()),
                error,
            );
            assert_eq!(recovery.source_epoch(), Some(9));
            assert_eq!(recovery.source_cursor(), None);
            assert_eq!(recovery.run_id(), None);
            assert!(matches!(
                recovery.changes(),
                [CanonicalSessionChange::RecoveryRequired { reason: actual }] if *actual == reason
            ));
        }
    }

    #[test]
    fn incomplete_snapshot_is_the_only_assembly_result() {
        let assembly =
            SnapshotAssembler::assemble(NativeSessionProjection::from_summary(&summary()));
        assert!(assembly.is_incomplete());
        assert!(!SnapshotAssembler::can_build_renderer_snapshot());
        assert!(assembly.gaps().iter().any(|gap| {
            gap.field() == SnapshotField::Snapshot
                && gap.producer() == SnapshotProducer::SessionSnapshotProducer
        }));
        let debug = format!("{assembly:?}");
        assert!(!debug.contains("agent:main:session-1"));
        assert!(!debug.contains("provider/model"));
    }
}
