use std::fmt;

use tokio::sync::mpsc;

use crate::gateway::ingress::GatewayEpoch;

use super::protocol::{
    ChatEvent, ChatState, MessageId, RunId, SessionActivity, SessionErrorKind,
    SessionEventEnvelope, SessionEventKind as ProtocolSessionEventKind, SessionKey,
};

const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

fn native_message_id(event: &SessionEventEnvelope) -> Option<&MessageId> {
    event
        .message_id
        .as_ref()
        .or(event.embedded_message_id.as_ref())
}

#[derive(Clone, Eq, PartialEq)]
pub struct SessionEventProvenance {
    session_key: SessionKey,
    run_id: Option<RunId>,
    source_epoch: Option<u64>,
    source_cursor: Option<u64>,
    route_key: Option<String>,
    message_id: Option<MessageId>,
}

impl SessionEventProvenance {
    pub fn session_key(&self) -> &SessionKey {
        &self.session_key
    }

    pub fn run_id(&self) -> Option<&RunId> {
        self.run_id.as_ref()
    }

    pub const fn source_epoch(&self) -> Option<u64> {
        self.source_epoch
    }

    pub const fn source_cursor(&self) -> Option<u64> {
        self.source_cursor
    }

    pub fn route_key(&self) -> Option<&str> {
        self.route_key.as_deref()
    }

    pub fn message_id(&self) -> Option<&MessageId> {
        self.message_id.as_ref()
    }

    pub(crate) fn from_event(
        event: &SessionEventEnvelope,
        epoch: Option<GatewayEpoch>,
        route_key: Option<String>,
    ) -> Self {
        Self::from_native_event(event, epoch.map(GatewayEpoch::as_u64), route_key)
    }

    pub(crate) fn from_native_event(
        event: &SessionEventEnvelope,
        source_epoch: Option<u64>,
        route_key: Option<String>,
    ) -> Self {
        Self {
            session_key: event.session_key.clone(),
            run_id: event.run_id.clone(),
            source_epoch: source_epoch.filter(|epoch| *epoch > 0),
            source_cursor: event
                .gateway_sequence
                .filter(|sequence| *sequence <= MAX_SAFE_SEQUENCE),
            route_key,
            message_id: native_message_id(event).cloned(),
        }
    }

    pub(crate) fn recovery(
        session_key: SessionKey,
        route_key: Option<String>,
        source_epoch: Option<u64>,
    ) -> Self {
        Self {
            session_key,
            run_id: None,
            source_epoch: source_epoch.filter(|epoch| *epoch > 0),
            source_cursor: None,
            route_key,
            message_id: None,
        }
    }

    fn local(session_key: SessionKey, run_id: Option<RunId>, route_key: Option<String>) -> Self {
        Self {
            session_key,
            run_id,
            source_epoch: None,
            source_cursor: None,
            route_key,
            message_id: None,
        }
    }
}

impl fmt::Debug for SessionEventProvenance {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEventProvenance")
            .field("has_session_key", &true)
            .field("has_run_id", &self.run_id.is_some())
            .field("source_epoch", &self.source_epoch)
            .field("source_cursor", &self.source_cursor)
            .field("has_route_key", &self.route_key.is_some())
            .field("has_message_id", &self.message_id.is_some())
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum SessionEvent {
    Lifecycle(LifecycleEvent),
    SessionUpdate(SessionUpdate),
    Activity {
        route_key: String,
        activity: SessionActivity,
        provenance: Option<SessionEventProvenance>,
    },
}

impl fmt::Debug for SessionEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Lifecycle(event) => formatter.debug_tuple("Lifecycle").field(event).finish(),
            Self::SessionUpdate(event) => {
                formatter.debug_tuple("SessionUpdate").field(event).finish()
            }
            Self::Activity {
                route_key,
                activity,
                ..
            } => formatter
                .debug_struct("Activity")
                .field("route_key", route_key)
                .field("activity", activity)
                .finish(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionUpdate {
    route_key: String,
    kind: SessionUpdateKind,
    sequence: u64,
    text: Option<String>,
    replace: bool,
    terminal: Option<TerminalOutcome>,
    error_kind: Option<SessionErrorKind>,
    stop_reason: Option<String>,
    message_id: Option<MessageId>,
    provenance: Option<SessionEventProvenance>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionUpdateKind {
    Delta,
    Snapshot,
    Terminal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalOutcome {
    Completed,
    Aborted,
    Error,
}

impl SessionUpdate {
    pub(crate) fn terminal_error(route_key: String) -> Self {
        Self {
            route_key,
            kind: SessionUpdateKind::Terminal,
            sequence: 0,
            text: None,
            replace: false,
            terminal: Some(TerminalOutcome::Error),
            error_kind: Some(SessionErrorKind::Unknown),
            stop_reason: None,
            message_id: None,
            provenance: None,
        }
    }

    pub fn route_key(&self) -> &str {
        &self.route_key
    }
    pub const fn kind(&self) -> SessionUpdateKind {
        self.kind
    }
    pub const fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn text(&self) -> Option<&str> {
        self.text.as_deref()
    }
    pub const fn replace(&self) -> bool {
        self.replace
    }
    pub const fn terminal(&self) -> Option<TerminalOutcome> {
        self.terminal
    }
    pub const fn error_kind(&self) -> Option<SessionErrorKind> {
        self.error_kind
    }
    pub fn stop_reason(&self) -> Option<&str> {
        self.stop_reason.as_deref()
    }
    pub fn message_id(&self) -> Option<&MessageId> {
        self.message_id.as_ref()
    }
    pub fn provenance(&self) -> Option<&SessionEventProvenance> {
        self.provenance.as_ref()
    }
}

#[derive(Clone, Eq)]
pub struct LifecycleEvent {
    sequence: Option<u64>,
    has_run: bool,
    has_message: bool,
    has_session_activity: bool,
    provenance: Option<SessionEventProvenance>,
}

impl PartialEq for LifecycleEvent {
    fn eq(&self, other: &Self) -> bool {
        self.sequence == other.sequence
            && self.has_run == other.has_run
            && self.has_message == other.has_message
            && self.has_session_activity == other.has_session_activity
    }
}

impl fmt::Debug for LifecycleEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LifecycleEvent")
            .field("sequence", &self.sequence)
            .field("has_run", &self.has_run)
            .field("has_message", &self.has_message)
            .field("has_session_activity", &self.has_session_activity)
            .finish()
    }
}

impl LifecycleEvent {
    pub const fn new(
        sequence: Option<u64>,
        has_run: bool,
        has_message: bool,
        has_session_activity: bool,
    ) -> Self {
        Self {
            sequence: match sequence {
                Some(sequence) if sequence > MAX_SAFE_SEQUENCE => None,
                sequence => sequence,
            },
            has_run,
            has_message,
            has_session_activity,
            provenance: None,
        }
    }

    fn with_provenance(mut self, provenance: SessionEventProvenance) -> Self {
        self.provenance = Some(provenance);
        self
    }

    pub const fn sequence(&self) -> Option<u64> {
        self.sequence
    }

    pub const fn has_run(&self) -> bool {
        self.has_run
    }

    pub const fn has_message(&self) -> bool {
        self.has_message
    }

    pub const fn has_session_activity(&self) -> bool {
        self.has_session_activity
    }

    pub fn provenance(&self) -> Option<&SessionEventProvenance> {
        self.provenance.as_ref()
    }
}

impl SessionEvent {
    pub const fn lifecycle(event: LifecycleEvent) -> Self {
        Self::Lifecycle(event)
    }

    pub fn provenance(&self) -> Option<&SessionEventProvenance> {
        match self {
            Self::Lifecycle(event) => event.provenance(),
            Self::SessionUpdate(event) => event.provenance(),
            Self::Activity { provenance, .. } => provenance.as_ref(),
        }
    }

    pub fn lifecycle_event(&self) -> Option<LifecycleEvent> {
        match self {
            Self::Lifecycle(event) => Some(event.clone()),
            Self::SessionUpdate(_) | Self::Activity { .. } => None,
        }
    }

    pub fn session_update(&self) -> Option<&SessionUpdate> {
        match self {
            Self::SessionUpdate(event) => Some(event),
            Self::Lifecycle(_) | Self::Activity { .. } => None,
        }
    }

    pub fn activity(&self) -> Option<(&str, &SessionActivity)> {
        match self {
            Self::Activity {
                route_key,
                activity,
                ..
            } => Some((route_key, activity)),
            Self::Lifecycle(_) | Self::SessionUpdate(_) => None,
        }
    }
}

fn terminal_kind(state: ChatState) -> Option<TerminalOutcome> {
    match state {
        ChatState::Final => Some(TerminalOutcome::Completed),
        ChatState::Aborted => Some(TerminalOutcome::Aborted),
        ChatState::Error => Some(TerminalOutcome::Error),
        ChatState::Delta => None,
    }
}

pub(crate) fn project_lifecycle(
    event: &SessionEventEnvelope,
    epoch: GatewayEpoch,
) -> LifecycleEvent {
    LifecycleEvent::new(
        event.gateway_sequence,
        event.run_id.is_some(),
        native_message_id(event).is_some(),
        event.chat.is_some() || event.activity.is_some(),
    )
    .with_provenance(SessionEventProvenance::from_event(event, Some(epoch), None))
}

pub(crate) fn send_lifecycle(
    sender: &mpsc::Sender<SessionEvent>,
    event: &SessionEventEnvelope,
    epoch: GatewayEpoch,
) -> Result<(), mpsc::error::TrySendError<SessionEvent>> {
    sender.try_send(SessionEvent::lifecycle(project_lifecycle(event, epoch)))
}

pub(crate) const MAX_RENDERER_ROUTES: usize = 32;

#[derive(Default)]
pub(crate) struct RendererRoutes {
    routes: Vec<RendererRoute>,
}

struct RendererRoute {
    session_key: SessionKey,
    run_id: RunId,
    route_key: String,
    last_sequence: Option<u64>,
    last_state: Option<ChatState>,
    last_activity_sequence: Option<u64>,
    content: String,
}

impl RendererRoutes {
    pub(crate) fn register(
        &mut self,
        session_key: SessionKey,
        run_id: RunId,
        route_key: String,
    ) -> Result<(), ()> {
        if self.routes.len() == MAX_RENDERER_ROUTES {
            return Err(());
        }
        self.routes.push(RendererRoute {
            session_key,
            run_id,
            route_key,
            last_sequence: None,
            last_state: None,
            last_activity_sequence: None,
            content: String::new(),
        });
        Ok(())
    }

    pub(crate) fn route(
        &mut self,
        event: &SessionEventEnvelope,
        epoch: GatewayEpoch,
    ) -> Option<SessionEvent> {
        let Some(activity) = event.activity.as_ref() else {
            return self.route_chat(event, epoch);
        };
        let index = self.routes.iter().position(|route| {
            activity.session_key() == &route.session_key && activity.run_id() == &route.run_id
        })?;
        let route = &mut self.routes[index];
        if route.last_activity_sequence.is_some_and(|last| {
            activity
                .gateway_sequence()
                .is_some_and(|sequence| sequence <= last)
        }) {
            return None;
        }
        route.last_activity_sequence = activity.gateway_sequence();
        let route_key = route.route_key.clone();
        Some(SessionEvent::Activity {
            route_key: route_key.clone(),
            activity: activity.clone(),
            provenance: Some(SessionEventProvenance::from_event(
                event,
                Some(epoch),
                Some(route_key),
            )),
        })
    }

    pub(crate) fn route_chat(
        &mut self,
        event: &SessionEventEnvelope,
        epoch: GatewayEpoch,
    ) -> Option<SessionEvent> {
        let chat = event.chat.as_ref()?;
        let index = self.routes.iter().position(|route| {
            route.session_key == chat.session_key && route.run_id == chat.run_id
        })?;
        let route = &mut self.routes[index];
        if route.last_sequence.is_some_and(|last| {
            chat.sequence < last
                || (chat.sequence == last
                    && !(route.last_state == Some(ChatState::Delta) && is_terminal(chat.state)))
        }) {
            return None;
        }
        route.last_sequence = Some(chat.sequence);
        route.last_state = Some(chat.state);
        if chat.replace {
            route.content.clear();
        }
        if let Some(text) = chat.delta_text.as_deref() {
            route.content.push_str(text);
        }
        if let Some(text) = chat.message_text.as_deref() {
            route.content.clear();
            route.content.push_str(text);
        }
        let update_route_key = route.route_key.clone();
        let update = SessionUpdate {
            route_key: update_route_key.clone(),
            kind: if chat.message_text.is_some() {
                SessionUpdateKind::Snapshot
            } else if is_terminal(chat.state) {
                SessionUpdateKind::Terminal
            } else {
                SessionUpdateKind::Delta
            },
            sequence: chat.sequence,
            text: (!route.content.is_empty()).then(|| route.content.clone()),
            replace: chat.replace,
            terminal: terminal_kind(chat.state),
            error_kind: chat.error_kind,
            stop_reason: chat.stop_reason.clone(),
            message_id: native_message_id(event).cloned(),
            provenance: Some(SessionEventProvenance::from_event(
                event,
                Some(epoch),
                Some(update_route_key),
            )),
        };
        if is_terminal(chat.state) {
            self.routes.swap_remove(index);
        }
        Some(SessionEvent::SessionUpdate(update))
    }

    pub(crate) fn release_error(
        &mut self,
        session_key: &SessionKey,
        run_id: &RunId,
    ) -> Option<SessionEvent> {
        let index = self
            .routes
            .iter()
            .position(|route| route.session_key == *session_key && route.run_id == *run_id)?;
        let route = self.routes.swap_remove(index);
        let provenance = SessionEventProvenance::local(
            route.session_key.clone(),
            Some(route.run_id.clone()),
            Some(route.route_key.clone()),
        );
        Some(SessionEvent::SessionUpdate(SessionUpdate {
            route_key: route.route_key,
            kind: SessionUpdateKind::Terminal,
            sequence: route.last_sequence.unwrap_or_default(),
            text: (!route.content.is_empty()).then_some(route.content),
            replace: false,
            terminal: Some(TerminalOutcome::Error),
            error_kind: Some(SessionErrorKind::Unknown),
            stop_reason: None,
            message_id: None,
            provenance: Some(provenance),
        }))
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct TurnProjection<'event> {
    run_id: &'event RunId,
}

impl<'event> TurnProjection<'event> {
    pub fn run_id(self) -> &'event RunId {
        self.run_id
    }
}

impl fmt::Debug for TurnProjection<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TurnProjection")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq)]
pub struct ProjectedSessionEvent {
    envelope: SessionEventEnvelope,
}

impl ProjectedSessionEvent {
    pub fn envelope(&self) -> &SessionEventEnvelope {
        &self.envelope
    }

    pub fn into_envelope(self) -> SessionEventEnvelope {
        self.envelope
    }

    pub fn session_key(&self) -> &SessionKey {
        &self.envelope.session_key
    }

    pub fn run_id(&self) -> Option<&RunId> {
        self.envelope.run_id.as_ref()
    }

    pub fn turn(&self) -> Option<TurnProjection<'_>> {
        self.run_id().map(|run_id| TurnProjection { run_id })
    }

    pub fn message_id(&self) -> Option<&MessageId> {
        native_message_id(&self.envelope)
    }

    pub fn chat_sequence(&self) -> Option<u64> {
        self.envelope.chat.as_ref().map(|chat| chat.sequence)
    }

    pub fn chat_state(&self) -> Option<ChatState> {
        self.envelope.chat.as_ref().map(|chat| chat.state)
    }
}

impl fmt::Debug for ProjectedSessionEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProjectedSessionEvent")
            .field("gateway_sequence", &self.envelope.gateway_sequence)
            .field("chat_sequence", &self.chat_sequence())
            .field("chat_state", &self.chat_state())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentityKind {
    Session,
    Run,
    Message,
}

pub type EventProjectionResult = Result<ProjectedSessionEvent, EventDisposition>;

#[derive(Clone, PartialEq)]
pub enum EventDisposition {
    Duplicate {
        sequence: u64,
        state: ChatState,
    },
    Stale {
        last_sequence: u64,
        received_sequence: u64,
    },
    OutOfRun,
    OutOfSession,
    ConflictingIdentity {
        identity: IdentityKind,
    },
    InvalidEnvelope,
}

impl fmt::Debug for EventDisposition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Duplicate { sequence, state } => formatter
                .debug_struct("Duplicate")
                .field("sequence", sequence)
                .field("state", state)
                .finish(),
            Self::Stale {
                last_sequence,
                received_sequence,
            } => formatter
                .debug_struct("Stale")
                .field("last_sequence", last_sequence)
                .field("received_sequence", received_sequence)
                .finish(),
            Self::OutOfRun => formatter.write_str("OutOfRun"),
            Self::OutOfSession => formatter.write_str("OutOfSession"),
            Self::ConflictingIdentity { identity } => formatter
                .debug_struct("ConflictingIdentity")
                .field("identity", identity)
                .finish(),
            Self::InvalidEnvelope => formatter.write_str("InvalidEnvelope"),
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct ChatCursor {
    sequence: u64,
    state: ChatState,
}

pub struct SessionEventProjector {
    session_key: SessionKey,
    run_id: RunId,
    last_chat: Option<ChatCursor>,
}

impl SessionEventProjector {
    pub fn new(session_key: SessionKey, run_id: RunId) -> Self {
        Self {
            session_key,
            run_id,
            last_chat: None,
        }
    }

    pub fn last_chat_sequence(&self) -> Option<u64> {
        self.last_chat.map(|cursor| cursor.sequence)
    }

    pub fn project(&mut self, envelope: SessionEventEnvelope) -> EventProjectionResult {
        validate_envelope(&envelope)?;
        if envelope.session_key != self.session_key {
            return Err(EventDisposition::OutOfSession);
        }
        if envelope
            .run_id
            .as_ref()
            .is_some_and(|run_id| run_id != &self.run_id)
        {
            return Err(EventDisposition::OutOfRun);
        }

        if let Some(chat) = envelope.chat.as_ref() {
            if let Some(disposition) = self.check_chat_order(chat) {
                return Err(disposition);
            }
            self.last_chat = Some(ChatCursor {
                sequence: chat.sequence,
                state: chat.state,
            });
        }

        Ok(ProjectedSessionEvent { envelope })
    }

    fn check_chat_order(&self, chat: &ChatEvent) -> Option<EventDisposition> {
        let last = self.last_chat?;
        if chat.sequence < last.sequence {
            return Some(EventDisposition::Stale {
                last_sequence: last.sequence,
                received_sequence: chat.sequence,
            });
        }
        if chat.sequence > last.sequence {
            return is_terminal(last.state).then_some(EventDisposition::Stale {
                last_sequence: last.sequence,
                received_sequence: chat.sequence,
            });
        }
        if chat.state == last.state {
            return Some(EventDisposition::Duplicate {
                sequence: chat.sequence,
                state: chat.state,
            });
        }
        if is_terminal(last.state) {
            return Some(EventDisposition::Stale {
                last_sequence: last.sequence,
                received_sequence: chat.sequence,
            });
        }
        if last.state == ChatState::Delta && is_terminal(chat.state) {
            return None;
        }
        Some(EventDisposition::Stale {
            last_sequence: last.sequence,
            received_sequence: chat.sequence,
        })
    }
}

impl fmt::Debug for SessionEventProjector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEventProjector")
            .field("last_chat_sequence", &self.last_chat_sequence())
            .field(
                "last_chat_state",
                &self.last_chat.map(|cursor| cursor.state),
            )
            .finish_non_exhaustive()
    }
}

fn validate_envelope(envelope: &SessionEventEnvelope) -> Result<(), EventDisposition> {
    if envelope
        .embedded_message_id
        .as_ref()
        .zip(envelope.message_id.as_ref())
        .is_some_and(|(embedded, top_level)| embedded != top_level)
    {
        return Err(conflicting(IdentityKind::Message));
    }
    if let Some(activity) = envelope.activity.as_ref() {
        if activity.session_key != envelope.session_key {
            return Err(conflicting(IdentityKind::Session));
        }
        if envelope.run_id.as_ref() != Some(&activity.run_id) {
            return Err(conflicting(IdentityKind::Run));
        }
    }
    match (envelope.kind, envelope.chat.as_ref()) {
        (ProtocolSessionEventKind::Chat, Some(chat)) => validate_chat(envelope, chat),
        (ProtocolSessionEventKind::Chat, None) | (_, Some(_)) => {
            Err(EventDisposition::InvalidEnvelope)
        }
        (_, None) => Ok(()),
    }
}

fn validate_chat(
    envelope: &SessionEventEnvelope,
    chat: &ChatEvent,
) -> Result<(), EventDisposition> {
    if chat.session_key != envelope.session_key {
        return Err(conflicting(IdentityKind::Session));
    }
    if envelope.run_id.as_ref() != Some(&chat.run_id) {
        return Err(conflicting(IdentityKind::Run));
    }
    Ok(())
}

fn conflicting(identity: IdentityKind) -> EventDisposition {
    EventDisposition::ConflictingIdentity { identity }
}

fn is_terminal(state: ChatState) -> bool {
    matches!(
        state,
        ChatState::Final | ChatState::Aborted | ChatState::Error
    )
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::{gateway::wire::GatewayEvent, session::protocol::decode_session_event};

    fn key(value: &str) -> SessionKey {
        SessionKey::try_new(value).unwrap()
    }

    fn run(value: &str) -> RunId {
        RunId::try_new(value).unwrap()
    }

    fn projector() -> SessionEventProjector {
        SessionEventProjector::new(key("agent:main:session-1"), run("run-1"))
    }

    fn event(name: &str, payload: Value) -> SessionEventEnvelope {
        decode_session_event(GatewayEvent {
            name: name.to_owned(),
            payload: Some(payload),
            sequence: Some(41),
            state_version: None,
        })
        .unwrap()
        .unwrap()
    }

    fn chat(sequence: u64, state: ChatState) -> SessionEventEnvelope {
        let state_name = match state {
            ChatState::Delta => "delta",
            ChatState::Final => "final",
            ChatState::Aborted => "aborted",
            ChatState::Error => "error",
        };
        let mut payload = json!({
            "runId": "run-1",
            "sessionKey": "agent:main:session-1",
            "seq": sequence,
            "state": state_name,
        });
        if state == ChatState::Delta {
            payload["deltaText"] = Value::String("secret delta".to_owned());
        }
        event("chat", payload)
    }

    #[test]
    fn lifecycle_projection_retains_only_permitted_facts() {
        let chat = event(
            "chat",
            json!({
                "sessionKey": "private-session",
                "runId": "private-run",
                "seq": 9,
                "state": "delta",
                "deltaText": "private-transcript",
            }),
        );
        let message = event(
            "session.message",
            json!({
                "sessionKey": "private-session",
                "runId": "private-run",
                "messageId": "private-message",
                "message": {
                    "content": "private-transcript",
                    "__openclaw": {"id": "private-message"}
                },
            }),
        );

        let lifecycle = project_lifecycle(&chat, GatewayEpoch::try_new(1).unwrap());
        assert_eq!(lifecycle, LifecycleEvent::new(Some(41), true, false, true));
        let provenance = lifecycle.provenance().unwrap();
        assert_eq!(provenance.session_key().as_str(), "private-session");
        assert_eq!(provenance.run_id().unwrap().as_str(), "private-run");
        assert_eq!(provenance.source_epoch(), Some(1));
        assert_eq!(provenance.source_cursor(), Some(41));
        assert_eq!(
            project_lifecycle(&message, GatewayEpoch::try_new(1).unwrap()),
            LifecycleEvent::new(Some(41), true, true, false)
        );
        assert_eq!(
            LifecycleEvent::new(Some(MAX_SAFE_SEQUENCE + 1), false, false, false).sequence(),
            None
        );

        let debug = format!("{lifecycle:?}");
        for private_value in ["private-session", "private-run", "private-transcript"] {
            assert!(!debug.contains(private_value));
        }
    }

    #[tokio::test]
    async fn lifecycle_delivery_emits_only_safe_value() {
        let (sender, mut receiver) = mpsc::channel(1);
        let native = event(
            "chat",
            json!({
                "sessionKey": "private-session",
                "runId": "private-run",
                "seq": 9,
                "state": "delta",
                "deltaText": "private-transcript",
            }),
        );

        send_lifecycle(&sender, &native, GatewayEpoch::try_new(1).unwrap()).unwrap();
        assert_eq!(
            receiver.recv().await,
            Some(SessionEvent::Lifecycle(LifecycleEvent::new(
                Some(41),
                true,
                false,
                true,
            )))
        );
    }

    #[test]
    fn lifecycle_delivery_reports_backpressure_without_native_payload() {
        let (sender, _receiver) = mpsc::channel(1);
        let native = chat(9, ChatState::Delta);

        send_lifecycle(&sender, &native, GatewayEpoch::try_new(1).unwrap()).unwrap();
        assert!(matches!(
            send_lifecycle(&sender, &native, GatewayEpoch::try_new(1).unwrap()),
            Err(mpsc::error::TrySendError::Full(SessionEvent::Lifecycle(
                LifecycleEvent { .. }
            )))
        ));
    }

    #[test]
    fn renderer_routes_emit_bounded_typed_updates_and_release_terminal() {
        let mut routes = RendererRoutes::default();
        routes
            .register(
                key("agent:main:session-1"),
                run("run-1"),
                "route-canary".into(),
            )
            .unwrap();

        let update = routes
            .route(
                &chat(1, ChatState::Delta),
                GatewayEpoch::try_new(1).unwrap(),
            )
            .unwrap();
        let update = update.session_update().unwrap();
        assert_eq!(update.route_key(), "route-canary");
        assert_eq!(update.kind(), SessionUpdateKind::Delta);
        assert_eq!(update.sequence(), 1);
        assert_eq!(update.text(), Some("secret delta"));
        assert_eq!(update.message_id(), None);
        let provenance = update.provenance().unwrap();
        assert_eq!(provenance.session_key().as_str(), "agent:main:session-1");
        assert_eq!(provenance.run_id().unwrap().as_str(), "run-1");
        assert_eq!(provenance.source_epoch(), Some(1));
        assert_eq!(provenance.source_cursor(), Some(41));

        let update = routes
            .route(
                &chat(1, ChatState::Final),
                GatewayEpoch::try_new(1).unwrap(),
            )
            .unwrap();
        let update = update.session_update().unwrap();
        assert_eq!(update.kind(), SessionUpdateKind::Terminal);
        assert_eq!(update.terminal(), Some(TerminalOutcome::Completed));
        assert_eq!(update.text(), Some("secret delta"));
        assert_eq!(
            routes.route(
                &chat(2, ChatState::Delta),
                GatewayEpoch::try_new(1).unwrap()
            ),
            None
        );

        let mut foreign = chat(3, ChatState::Delta);
        foreign.chat.as_mut().unwrap().run_id = run("other-run");
        assert_eq!(
            routes.route(&foreign, GatewayEpoch::try_new(1).unwrap()),
            None
        );
    }

    #[test]
    fn renderer_routes_are_bounded() {
        let mut routes = RendererRoutes::default();
        for index in 0..MAX_RENDERER_ROUTES {
            routes
                .register(
                    key(&format!("agent:main:session-{index}")),
                    run(&format!("run-{index}")),
                    format!("route-{index}"),
                )
                .unwrap();
        }
        assert!(
            routes
                .register(
                    key("agent:main:overflow"),
                    run("overflow"),
                    "route-overflow".into()
                )
                .is_err()
        );
    }

    #[test]
    fn projects_protocol_identities_and_derives_turn_only_from_run_id() {
        let mut projector = projector();
        let message = event(
            "session.message",
            json!({
                "sessionKey": "agent:main:session-1",
                "messageId": "message-1",
                "message": {
                    "role": "assistant",
                    "__openclaw": {"id": "message-1"}
                },
                "future": "preserved"
            }),
        );
        let Ok(message) = projector.project(message) else {
            panic!("expected projected message");
        };
        assert_eq!(message.message_id().unwrap().as_str(), "message-1");
        assert_eq!(message.turn(), None);
        assert_eq!(message.envelope().kind, ProtocolSessionEventKind::Message);

        let Ok(chat) = projector.project(chat(4, ChatState::Delta)) else {
            panic!("expected projected chat event");
        };
        assert_eq!(chat.turn().unwrap().run_id().as_str(), "run-1");
        assert_eq!(chat.message_id(), None);
    }

    #[test]
    fn chat_order_is_sparse_and_allows_same_sequence_terminal_projection() {
        let mut projector = projector();

        assert!(projector.project(chat(3, ChatState::Delta)).is_ok());
        assert!(projector.project(chat(8, ChatState::Delta)).is_ok());
        assert!(projector.project(chat(8, ChatState::Final)).is_ok());
        assert_eq!(projector.last_chat_sequence(), Some(8));
        assert_eq!(
            projector.project(chat(8, ChatState::Final)),
            Err(EventDisposition::Duplicate {
                sequence: 8,
                state: ChatState::Final,
            })
        );
        assert_eq!(
            projector.project(chat(9, ChatState::Delta)),
            Err(EventDisposition::Stale {
                last_sequence: 8,
                received_sequence: 9,
            })
        );
    }

    #[test]
    fn stale_or_duplicate_chat_does_not_mutate_ordering_state() {
        let mut projector = projector();
        assert!(projector.project(chat(7, ChatState::Delta)).is_ok());
        assert_eq!(
            projector.project(chat(7, ChatState::Delta)),
            Err(EventDisposition::Duplicate {
                sequence: 7,
                state: ChatState::Delta,
            })
        );
        assert_eq!(
            projector.project(chat(6, ChatState::Delta)),
            Err(EventDisposition::Stale {
                last_sequence: 7,
                received_sequence: 6,
            })
        );
        assert_eq!(projector.last_chat_sequence(), Some(7));
        assert!(projector.project(chat(9, ChatState::Final)).is_ok());
    }

    #[test]
    fn foreign_and_conflicting_identities_fail_closed_without_advancing_order() {
        let mut projector = projector();
        let foreign_session = event(
            "sessions.changed",
            json!({"sessionKey": "agent:main:session-2", "runId": "run-1"}),
        );
        assert_eq!(
            projector.project(foreign_session),
            Err(EventDisposition::OutOfSession)
        );
        let foreign_run = event(
            "sessions.changed",
            json!({"sessionKey": "agent:main:session-1", "runId": "run-2"}),
        );
        assert_eq!(
            projector.project(foreign_run),
            Err(EventDisposition::OutOfRun)
        );

        let mut conflicting_session = chat(2, ChatState::Delta);
        conflicting_session.chat.as_mut().unwrap().session_key = key("embedded-foreign");
        assert_eq!(
            projector.project(conflicting_session),
            Err(EventDisposition::ConflictingIdentity {
                identity: IdentityKind::Session,
            })
        );

        let mut conflicting_run = chat(2, ChatState::Delta);
        conflicting_run.chat.as_mut().unwrap().run_id = run("embedded-foreign");
        assert_eq!(
            projector.project(conflicting_run),
            Err(EventDisposition::ConflictingIdentity {
                identity: IdentityKind::Run,
            })
        );

        let conflicting_message = event(
            "session.message",
            json!({
                "sessionKey": "agent:main:session-1",
                "messageId": "message-1",
                "message": {"__openclaw": {"id": "message-2"}}
            }),
        );
        assert_eq!(
            projector.project(conflicting_message),
            Err(EventDisposition::ConflictingIdentity {
                identity: IdentityKind::Message,
            })
        );
        let missing_envelope_message = event(
            "session.message",
            json!({
                "sessionKey": "agent:main:session-1",
                "message": {"__openclaw": {"id": "message-1"}}
            }),
        );
        let projected = projector
            .project(missing_envelope_message)
            .expect("embedded native message identity is valid");
        assert_eq!(projected.message_id().unwrap().as_str(), "message-1");
        assert_eq!(projector.last_chat_sequence(), None);
    }

    #[test]
    fn debug_output_never_contains_identities_or_raw_payload() {
        let secret = "secret delta";
        let mut projector = projector();
        let projected = projector.project(chat(1, ChatState::Delta));
        let turn = match &projected {
            Ok(event) => event.turn().unwrap(),
            Err(_) => panic!("expected projected event"),
        };

        for output in [
            format!("{projected:?}"),
            format!("{projector:?}"),
            format!("{turn:?}"),
        ] {
            assert!(!output.contains(secret));
            assert!(!output.contains("agent:main:session-1"));
            assert!(!output.contains("run-1"));
            assert!(!output.contains("message-1"));
        }
    }
}
