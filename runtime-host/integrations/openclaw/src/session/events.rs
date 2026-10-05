use std::fmt;

use tokio::sync::mpsc;

use crate::gateway::ingress::GatewayEpoch;

use super::protocol::{MessageId, RunId, SessionEventEnvelope, SessionKey};

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


    pub fn message_id(&self) -> Option<&MessageId> {
        self.message_id.as_ref()
    }

    pub(crate) fn from_event(
        event: &SessionEventEnvelope,
        epoch: Option<GatewayEpoch>,

    ) -> Self {
        Self::from_native_event(event, epoch.map(GatewayEpoch::as_u64))
    }

    pub(crate) fn from_native_event(
        event: &SessionEventEnvelope,
        source_epoch: Option<u64>,

    ) -> Self {
        Self {
            session_key: event.session_key.clone(),
            run_id: event.run_id.clone(),
            source_epoch: source_epoch.filter(|epoch| *epoch > 0),
            source_cursor: event
                .gateway_sequence
                .filter(|sequence| *sequence <= MAX_SAFE_SEQUENCE),

            message_id: native_message_id(event).cloned(),
        }
    }

    pub(crate) fn from_replay_source(
        session_key: SessionKey,
        run_id: Option<RunId>,
        source_epoch: Option<u64>,
        source_cursor: Option<u64>,

        message_id: Option<MessageId>,
    ) -> Self {
        Self {
            session_key,
            run_id,
            source_epoch: source_epoch.filter(|epoch| *epoch > 0),
            source_cursor: source_cursor.filter(|sequence| *sequence <= MAX_SAFE_SEQUENCE),

            message_id,
        }
    }

    pub(crate) fn recovery(
        session_key: SessionKey,

        source_epoch: Option<u64>,
    ) -> Self {
        Self {
            session_key,
            run_id: None,
            source_epoch: source_epoch.filter(|epoch| *epoch > 0),
            source_cursor: None,

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

            .field("has_message_id", &self.message_id.is_some())
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub enum SessionEvent {
    Lifecycle(LifecycleEvent),
    QuestionsChanged,
}

impl fmt::Debug for SessionEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Lifecycle(event) => formatter.debug_tuple("Lifecycle").field(event).finish(),
            Self::QuestionsChanged => formatter.write_str("QuestionsChanged"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalOutcome {
    Completed,
    Aborted,
    Error,
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
            Self::QuestionsChanged => None,
        }
    }

    pub fn lifecycle_event(&self) -> Option<LifecycleEvent> {
        match self {
            Self::Lifecycle(event) => Some(event.clone()),
            Self::QuestionsChanged => None,
        }
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
        event.chat.is_some() || event.activity.is_some() || event.approval.is_some(),
    )
    .with_provenance(SessionEventProvenance::from_event(event, Some(epoch)))
}

pub(crate) fn send_lifecycle(
    sender: &mpsc::Sender<SessionEvent>,
    event: &SessionEventEnvelope,
    epoch: GatewayEpoch,
) -> Result<(), mpsc::error::TrySendError<SessionEvent>> {
    sender.try_send(SessionEvent::lifecycle(project_lifecycle(event, epoch)))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::{gateway::wire::GatewayEvent, session::protocol::decode_session_event};

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

    #[test]
    fn approval_lifecycle_marks_session_activity() {
        let approval = event(
            "exec.approval.requested",
            json!({
                "id": "approval-1",
                "request": {
                    "sessionKey": "agent:main:session-1",
                    "runId": "run-1",
                    "command": "git status",
                },
            }),
        );

        assert_eq!(
            project_lifecycle(&approval, GatewayEpoch::try_new(1).unwrap()),
            LifecycleEvent::new(Some(41), true, false, true)
        );
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
        let native = event(
            "chat",
            json!({
                "sessionKey": "agent:main:session-1",
                "runId": "run-1",
                "seq": 9,
                "state": "delta",
                "deltaText": "secret delta",
            }),
        );

        send_lifecycle(&sender, &native, GatewayEpoch::try_new(1).unwrap()).unwrap();
        assert!(matches!(
            send_lifecycle(&sender, &native, GatewayEpoch::try_new(1).unwrap()),
            Err(mpsc::error::TrySendError::Full(SessionEvent::Lifecycle(
                LifecycleEvent { .. }
            )))
        ));
    }
}
