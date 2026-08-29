use std::fmt;

use serde_json::Value;

use crate::{
    gateway::ingress::GatewayEpoch,
    session_window::{self, HistoryError, PageRequest, SessionWindow},
};

use super::protocol::{
    ChatState, MessageId, NativeSessionId, RunId, SessionEventEnvelope, SessionEventKind,
    SessionKey, SessionKind, SessionSummary,
};

const MAX_SAFE_GATEWAY_SEQUENCE: u64 = 9_007_199_254_740_991;

/// Describes how much of one native fact family is available.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeFactStatus {
    Complete,
    Incomplete,
    Unavailable,
    Unknown,
}

/// A bounded, typed read result for native facts.
///
/// `Incomplete` retains the facts that were actually observed and names the
/// missing guarantee. It never upgrades an event or a bounded page into a
/// complete session snapshot.
#[derive(Clone, PartialEq)]
pub enum NativeFactRead<T> {
    Complete(T),
    Incomplete { facts: T, gaps: Vec<NativeFactGap> },
    Unavailable,
    Unknown,
}

impl<T> NativeFactRead<T> {
    pub const fn status(&self) -> NativeFactStatus {
        match self {
            Self::Complete(_) => NativeFactStatus::Complete,
            Self::Incomplete { .. } => NativeFactStatus::Incomplete,
            Self::Unavailable => NativeFactStatus::Unavailable,
            Self::Unknown => NativeFactStatus::Unknown,
        }
    }

    pub fn facts(&self) -> Option<&T> {
        match self {
            Self::Complete(facts) | Self::Incomplete { facts, .. } => Some(facts),
            Self::Unavailable | Self::Unknown => None,
        }
    }

    pub fn gaps(&self) -> Option<&[NativeFactGap]> {
        match self {
            Self::Incomplete { gaps, .. } => Some(gaps),
            Self::Complete(_) | Self::Unavailable | Self::Unknown => None,
        }
    }
}

impl<T: fmt::Debug> fmt::Debug for NativeFactRead<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Complete(facts) => formatter
                .debug_struct("Complete")
                .field("facts", facts)
                .finish(),
            Self::Incomplete { facts, gaps } => formatter
                .debug_struct("Incomplete")
                .field("facts", facts)
                .field("gaps", gaps)
                .finish(),
            Self::Unavailable => formatter.write_str("Unavailable"),
            Self::Unknown => formatter.write_str("Unknown"),
        }
    }
}

/// A guarantee that the native source does not provide for this fact read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeFactGap {
    BoundedHistory,
    MissingSessionIdentity,
    PartialRuntime,
    EventOnly,
    MissingGatewayEpoch,
    MissingGatewaySequence,
    ToolFacts,
    ApprovalFacts,
    MediaFacts,
    Snapshot,
}

/// Cursor facts supplied by the OpenClaw Gateway ingress.
///
/// The epoch belongs to the Gateway connection and is deliberately separate
/// from the Host session epoch. A missing value stays `None`; no local cursor
/// or epoch is synthesized from an event.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct NativeCursor {
    source_epoch: Option<GatewayEpoch>,
    gateway_sequence: Option<u64>,
    chat_sequence: Option<u64>,
}

impl NativeCursor {
    pub const fn unknown() -> Self {
        Self {
            source_epoch: None,
            gateway_sequence: None,
            chat_sequence: None,
        }
    }

    pub(crate) fn from_event(
        event: &SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,
    ) -> Self {
        Self {
            source_epoch,
            gateway_sequence: event
                .gateway_sequence
                .filter(|sequence| *sequence <= MAX_SAFE_GATEWAY_SEQUENCE),
            chat_sequence: event.chat.as_ref().map(|chat| chat.sequence),
        }
    }

    pub const fn source_epoch(self) -> Option<u64> {
        match self.source_epoch {
            Some(epoch) => Some(epoch.as_u64()),
            None => None,
        }
    }

    pub(crate) const fn gateway_epoch(self) -> Option<GatewayEpoch> {
        self.source_epoch
    }

    pub const fn gateway_sequence(self) -> Option<u64> {
        self.gateway_sequence
    }

    pub const fn chat_sequence(self) -> Option<u64> {
        self.chat_sequence
    }

    pub const fn has_gateway_position(self) -> bool {
        self.source_epoch.is_some() && self.gateway_sequence.is_some()
    }
}

impl fmt::Debug for NativeCursor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeCursor")
            .field("source_epoch", &self.source_epoch)
            .field("gateway_sequence", &self.gateway_sequence)
            .field("chat_sequence", &self.chat_sequence)
            .finish()
    }
}

/// Native identity facts from one `sessions.list` entry.
#[derive(Clone, PartialEq)]
pub struct SessionIdentityFacts {
    session_key: SessionKey,
    kind: SessionKind,
    label: Option<String>,
    display_name: Option<String>,
    derived_title: Option<String>,
    updated_at: Option<u64>,
}

impl SessionIdentityFacts {
    pub fn from_native(summary: &SessionSummary) -> NativeFactRead<Self> {
        NativeFactRead::Complete(Self {
            session_key: summary.key.clone(),
            kind: summary.kind,
            label: summary.label.clone(),
            display_name: summary.display_name.clone(),
            derived_title: summary.derived_title.clone(),
            updated_at: summary.updated_at,
        })
    }

    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub const fn kind(&self) -> SessionKind {
        self.kind
    }

    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    pub fn display_name(&self) -> Option<&str> {
        self.display_name.as_deref()
    }

    pub fn derived_title(&self) -> Option<&str> {
        self.derived_title.as_deref()
    }

    pub const fn updated_at(&self) -> Option<u64> {
        self.updated_at
    }
}

impl fmt::Debug for SessionIdentityFacts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionIdentityFacts")
            .field("kind", &self.kind)
            .field("has_label", &self.label.is_some())
            .field("has_display_name", &self.display_name.is_some())
            .field("has_derived_title", &self.derived_title.is_some())
            .field("has_updated_at", &self.updated_at.is_some())
            .finish_non_exhaustive()
    }
}

/// Runtime facts exposed by a native session summary.
///
/// The optional fields remain optional. No run, message, or sequence identity
/// is inferred from them.
#[derive(Clone, PartialEq)]
pub struct SessionRuntimeFacts {
    session_key: SessionKey,
    status: Option<String>,
    has_active_run: Option<bool>,
    model: Option<String>,
}

impl SessionRuntimeFacts {
    pub fn from_native(summary: &SessionSummary) -> NativeFactRead<Self> {
        let facts = Self {
            session_key: summary.key.clone(),
            status: summary.status.clone(),
            has_active_run: summary.has_active_run,
            model: summary.model.clone(),
        };
        let complete =
            facts.status.is_some() && facts.has_active_run.is_some() && facts.model.is_some();
        if complete {
            NativeFactRead::Complete(facts)
        } else {
            NativeFactRead::Incomplete {
                facts,
                gaps: vec![NativeFactGap::PartialRuntime],
            }
        }
    }

    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }

    pub const fn has_active_run(&self) -> Option<bool> {
        self.has_active_run
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }
}

impl fmt::Debug for SessionRuntimeFacts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionRuntimeFacts")
            .field("has_status", &self.status.is_some())
            .field("has_active_run", &self.has_active_run)
            .field("has_model", &self.model.is_some())
            .finish_non_exhaustive()
    }
}

/// A bounded native history page and only the identity fields present in its
/// response envelope. It is never represented as a complete transcript.
#[derive(Clone, PartialEq)]
pub struct BoundedHistoryFacts {
    session_key: Option<SessionKey>,
    native_session_id: Option<NativeSessionId>,
    window: SessionWindow,
}

impl BoundedHistoryFacts {
    pub fn decode(
        payload: Value,
        request: PageRequest,
    ) -> Result<NativeFactRead<Self>, HistoryError> {
        let window = session_window::decode_window(payload.clone(), request)?;
        let envelope = payload.as_object().ok_or(HistoryError::malformed())?;
        let session_key = optional_session_key(envelope.get("sessionKey"))?;
        let native_session_id = optional_native_session_id(envelope.get("sessionId"))?;
        let facts = Self {
            session_key,
            native_session_id,
            window,
        };
        let mut gaps = vec![NativeFactGap::BoundedHistory];
        if facts.session_key.is_none() {
            gaps.push(NativeFactGap::MissingSessionIdentity);
        }
        Ok(NativeFactRead::Incomplete { facts, gaps })
    }

    pub fn session_key(&self) -> Option<&SessionKey> {
        self.session_key.as_ref()
    }

    pub fn native_session_id(&self) -> Option<&NativeSessionId> {
        self.native_session_id.as_ref()
    }

    pub fn window(&self) -> &SessionWindow {
        &self.window
    }
}

impl fmt::Debug for BoundedHistoryFacts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoundedHistoryFacts")
            .field("has_session_key", &self.session_key.is_some())
            .field("has_native_session_id", &self.native_session_id.is_some())
            .field("message_count", &self.window.messages().len())
            .field("range", &self.window.range())
            .finish()
    }
}

fn optional_session_key(value: Option<&Value>) -> Result<Option<SessionKey>, HistoryError> {
    match value {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => SessionKey::try_new(value.clone())
            .map(Some)
            .map_err(|_| HistoryError::malformed()),
        Some(Value::String(_)) => Ok(None),
        Some(_) => Err(HistoryError::malformed()),
    }
}

fn optional_native_session_id(
    value: Option<&Value>,
) -> Result<Option<NativeSessionId>, HistoryError> {
    match value {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => NativeSessionId::try_new(value.clone())
            .map(Some)
            .map_err(|_| HistoryError::malformed()),
        Some(Value::String(_)) => Ok(None),
        Some(_) => Err(HistoryError::malformed()),
    }
}

/// The native event categories relevant to a session projection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveFactKind {
    Update,
    Terminal,
    Runtime,
}

/// A typed native event. It deliberately retains one native envelope instead
/// of building a transcript or a run/message/sequence crosswalk.
#[derive(Clone, PartialEq)]
pub enum LiveSessionFacts {
    Update {
        event: SessionEventEnvelope,
        cursor: NativeCursor,
    },
    Terminal {
        event: SessionEventEnvelope,
        cursor: NativeCursor,
    },
    Runtime {
        event: SessionEventEnvelope,
        cursor: NativeCursor,
    },
}

impl LiveSessionFacts {
    pub fn from_native(event: SessionEventEnvelope) -> NativeFactRead<Self> {
        Self::from_native_at_epoch(event, None)
    }

    /// Reads one event with the Gateway connection epoch supplied by ingress.
    /// `None` is intentionally preserved as an unknown source epoch.
    pub(crate) fn from_native_at_epoch(
        mut event: SessionEventEnvelope,
        source_epoch: Option<GatewayEpoch>,
    ) -> NativeFactRead<Self> {
        if event.message_id.is_none() {
            event.message_id = event.embedded_message_id.clone();
        }
        let kind = match event.kind {
            SessionEventKind::Chat => match event.chat.as_ref() {
                Some(chat) if chat.state == ChatState::Delta => LiveFactKind::Update,
                Some(_) => LiveFactKind::Terminal,
                None => LiveFactKind::Runtime,
            },
            SessionEventKind::Message | SessionEventKind::Tool if event.activity.is_some() => {
                LiveFactKind::Update
            }
            SessionEventKind::Message | SessionEventKind::Tool | SessionEventKind::Changed => {
                LiveFactKind::Runtime
            }
        };
        let cursor = NativeCursor::from_event(&event, source_epoch);
        let is_tool = event.kind == SessionEventKind::Tool;
        let facts = match kind {
            LiveFactKind::Update => Self::Update { event, cursor },
            LiveFactKind::Terminal => Self::Terminal { event, cursor },
            LiveFactKind::Runtime => Self::Runtime { event, cursor },
        };
        let mut gaps = Vec::new();
        if kind == LiveFactKind::Runtime {
            gaps.push(NativeFactGap::EventOnly);
        }
        if source_epoch.is_none() {
            gaps.push(NativeFactGap::MissingGatewayEpoch);
        }
        if cursor.gateway_sequence().is_none() {
            gaps.push(NativeFactGap::MissingGatewaySequence);
        }
        if is_tool {
            gaps.push(NativeFactGap::ToolFacts);
        }
        if gaps.is_empty() {
            NativeFactRead::Complete(facts)
        } else {
            NativeFactRead::Incomplete { facts, gaps }
        }
    }

    pub const fn kind(&self) -> LiveFactKind {
        match self {
            Self::Update { .. } => LiveFactKind::Update,
            Self::Terminal { .. } => LiveFactKind::Terminal,
            Self::Runtime { .. } => LiveFactKind::Runtime,
        }
    }

    pub fn event(&self) -> &SessionEventEnvelope {
        match self {
            Self::Update { event, .. }
            | Self::Terminal { event, .. }
            | Self::Runtime { event, .. } => event,
        }
    }

    pub const fn cursor(&self) -> NativeCursor {
        match self {
            Self::Update { cursor, .. }
            | Self::Terminal { cursor, .. }
            | Self::Runtime { cursor, .. } => *cursor,
        }
    }

    pub fn session_key(&self) -> &SessionKey {
        &self.event().session_key
    }

    pub fn run_id(&self) -> Option<&RunId> {
        self.event().run_id.as_ref()
    }

    pub fn message_id(&self) -> Option<&MessageId> {
        self.event().message_id.as_ref()
    }

    pub fn gateway_sequence(&self) -> Option<u64> {
        self.event().gateway_sequence
    }

    pub fn chat_state(&self) -> Option<ChatState> {
        self.event().chat.as_ref().map(|chat| chat.state)
    }
}

impl fmt::Debug for LiveSessionFacts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LiveSessionFacts")
            .field("kind", &self.kind())
            .field("has_run_id", &self.run_id().is_some())
            .field("has_message_id", &self.message_id().is_some())
            .field("has_gateway_sequence", &self.gateway_sequence().is_some())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::gateway::wire::GatewayEvent;
    use crate::session::protocol::{SessionEventKind, SessionSummary};

    fn summary() -> SessionSummary {
        SessionSummary {
            key: SessionKey::try_new("agent:main:session-1").unwrap(),
            kind: SessionKind::Direct,
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

    fn page_request() -> PageRequest {
        PageRequest::latest()
    }

    fn event(name: &str, payload: Value) -> SessionEventEnvelope {
        super::super::protocol::decode_session_event(GatewayEvent {
            name: name.into(),
            payload: Some(payload),
            sequence: Some(8),
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    #[test]
    fn identity_and_runtime_facts_preserve_optional_native_fields() {
        let summary = summary();
        let NativeFactRead::Complete(identity) = SessionIdentityFacts::from_native(&summary) else {
            panic!("native identity is structurally complete");
        };
        assert_eq!(identity.session_key().as_str(), "agent:main:session-1");
        assert_eq!(identity.kind(), SessionKind::Direct);
        assert_eq!(identity.derived_title(), Some("Native title"));

        let NativeFactRead::Complete(runtime) = SessionRuntimeFacts::from_native(&summary) else {
            panic!("runtime fixture has all native runtime fields");
        };
        assert_eq!(runtime.status(), Some("idle"));
        assert_eq!(runtime.has_active_run(), Some(false));
        assert_eq!(runtime.model(), Some("provider/model"));

        let debug = format!("{identity:?} {runtime:?}");
        assert!(!debug.contains("agent:main:session-1"));
        assert!(!debug.contains("provider/model"));
    }

    #[test]
    fn missing_runtime_fields_are_incomplete_without_inference() {
        let mut summary = summary();
        summary.model = None;
        let result = SessionRuntimeFacts::from_native(&summary);
        assert_eq!(result.status(), NativeFactStatus::Incomplete);
        assert_eq!(result.gaps(), Some(&[NativeFactGap::PartialRuntime][..]));
        assert_eq!(result.facts().unwrap().model(), None);
    }

    #[test]
    fn bounded_history_retains_only_native_envelope_identity_and_window() {
        let result = BoundedHistoryFacts::decode(
            json!({
                "sessionKey": "agent:main:session-1",
                "sessionId": "opaque-native-id",
                "messages": [
                    {"role":"user", "messageId":"message-1", "content":"hello", "runId":"run-1", "seq":7}
                ]
            }),
            page_request(),
        )
        .unwrap();
        let NativeFactRead::Incomplete { facts, gaps } = result else {
            panic!("bounded history must not claim a complete transcript");
        };
        assert_eq!(
            facts.session_key().unwrap().as_str(),
            "agent:main:session-1"
        );
        assert_eq!(
            facts.native_session_id().unwrap().as_str(),
            "opaque-native-id"
        );
        assert_eq!(facts.window().messages().len(), 1);
        assert_eq!(facts.window().messages()[0].message_id(), Some("message-1"));
        assert_eq!(facts.window().messages()[0].run_id(), Some("run-1"));
        assert_eq!(facts.window().messages()[0].sequence(), Some(7));
        assert_eq!(gaps, [NativeFactGap::BoundedHistory]);
    }

    #[test]
    fn bounded_history_without_native_identity_is_explicitly_partial() {
        let result = BoundedHistoryFacts::decode(
            json!({"messages": [{"role":"assistant", "content":"reply"}]}),
            page_request(),
        )
        .unwrap();
        let NativeFactRead::Incomplete { facts, gaps } = result else {
            panic!("bounded history is incomplete");
        };
        assert!(facts.session_key().is_none());
        assert_eq!(
            gaps,
            [
                NativeFactGap::BoundedHistory,
                NativeFactGap::MissingSessionIdentity
            ]
        );
    }

    #[test]
    fn live_chat_update_and_terminal_remain_native_events() {
        let update = LiveSessionFacts::from_native_at_epoch(
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
        assert_eq!(update.status(), NativeFactStatus::Complete);
        assert_eq!(update.facts().unwrap().kind(), LiveFactKind::Update);
        assert_eq!(update.facts().unwrap().chat_state(), Some(ChatState::Delta));

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
            Some(GatewayEpoch::try_new(1).unwrap()),
        );
        assert_eq!(terminal.status(), NativeFactStatus::Complete);
        assert_eq!(terminal.facts().unwrap().kind(), LiveFactKind::Terminal);
        assert_eq!(
            terminal.facts().unwrap().chat_state(),
            Some(ChatState::Final)
        );
        assert_eq!(
            terminal.facts().unwrap().cursor(),
            NativeCursor {
                source_epoch: Some(GatewayEpoch::try_new(1).unwrap()),
                gateway_sequence: Some(8),
                chat_sequence: Some(8),
            }
        );
    }

    #[test]
    fn missing_epoch_or_sequence_stays_incomplete() {
        let result = LiveSessionFacts::from_native(
            super::super::protocol::decode_session_event(GatewayEvent {
                name: "sessions.changed".into(),
                payload: Some(json!({"sessionKey":"agent:main:session-1"})),
                sequence: None,
                state_version: None,
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(result.status(), NativeFactStatus::Incomplete);
        assert_eq!(
            result.gaps(),
            Some(
                &[
                    NativeFactGap::EventOnly,
                    NativeFactGap::MissingGatewayEpoch,
                    NativeFactGap::MissingGatewaySequence,
                ][..]
            )
        );
        assert_eq!(result.facts().unwrap().cursor(), NativeCursor::unknown());
    }

    #[test]
    fn changed_event_is_runtime_event_only_not_a_snapshot() {
        let result = LiveSessionFacts::from_native(event(
            "sessions.changed",
            json!({
                "sessionKey":"agent:main:session-1",
                "sessionId":"private-id",
                "transcript":"private transcript"
            }),
        ));
        assert_eq!(result.status(), NativeFactStatus::Incomplete);
        assert_eq!(
            result.gaps(),
            Some(&[NativeFactGap::EventOnly, NativeFactGap::MissingGatewayEpoch,][..])
        );
        let facts = result.facts().unwrap();
        assert_eq!(facts.kind(), LiveFactKind::Runtime);
        assert_eq!(facts.session_key().as_str(), "agent:main:session-1");
        let debug = format!("{facts:?}");
        assert!(!debug.contains("private-id"));
        assert!(!debug.contains("private transcript"));
        assert_eq!(facts.event().kind, SessionEventKind::Changed);
    }

    #[test]
    fn read_statuses_are_explicit_for_transport_ambiguity() {
        let unavailable: NativeFactRead<()> = NativeFactRead::Unavailable;
        let unknown: NativeFactRead<()> = NativeFactRead::Unknown;
        assert_eq!(unavailable.status(), NativeFactStatus::Unavailable);
        assert_eq!(unknown.status(), NativeFactStatus::Unknown);
        assert!(unavailable.facts().is_none());
        assert!(unknown.gaps().is_none());
    }
}
