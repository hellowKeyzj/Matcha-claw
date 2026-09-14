use std::{
    collections::HashMap,
    num::NonZeroUsize,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use tokio::sync::mpsc;

use crate::gateway::{
    ingress::{GatewayEpoch, Ingress, IngressError, IngressEvent},
    wire::GatewayEvent,
};

use super::{
    event_router::EventRouter,
    events::{SessionEvent, send_lifecycle},
    projection::{CanonicalIngressResult, CanonicalSessionDeltaProducer},
    protocol::{
        ChatState, SessionEventEnvelope, SessionEventKind, SessionKey, decode_session_event,
    },
};

const INGRESS_CAPACITY: usize = 256;

fn gateway_event_trace_payload(event: &GatewayEvent, epoch: GatewayEpoch) -> serde_json::Value {
    let payload = event
        .payload
        .as_ref()
        .and_then(serde_json::Value::as_object);
    let message = payload.and_then(|payload| payload.get("message"));
    let data = payload
        .and_then(|payload| payload.get("data"))
        .and_then(serde_json::Value::as_object);
    serde_json::json!({
        "sourceEpoch": epoch.as_u64(),
        "eventName": &event.name,
        "gatewaySequence": event.sequence,
        "hasPayload": event.payload.is_some(),
        "state": payload.and_then(|payload| payload.get("state")).and_then(serde_json::Value::as_str),
        "stream": payload.and_then(|payload| payload.get("stream")).and_then(serde_json::Value::as_str),
        "dataKind": data.and_then(|data| data.get("kind")).and_then(serde_json::Value::as_str),
        "dataPhase": data.and_then(|data| data.get("phase")).and_then(serde_json::Value::as_str),
        "hasData": data.is_some(),
        "hasDataItemId": data.and_then(|data| data.get("itemId")).is_some(),
        "hasDataText": data.and_then(|data| data.get("text")).is_some(),
        "dataTextLength": data
            .and_then(|data| data.get("text"))
            .and_then(serde_json::Value::as_str)
            .map_or(0, str::len),
        "hasDataDelta": data.and_then(|data| data.get("delta")).is_some(),
        "dataDeltaLength": data
            .and_then(|data| data.get("delta"))
            .and_then(serde_json::Value::as_str)
            .map_or(0, str::len),
        "dataProgressTextLength": data
            .and_then(|data| data.get("progressText"))
            .and_then(serde_json::Value::as_str)
            .map_or(0, str::len),
        "replace": payload
            .and_then(|payload| payload.get("replace"))
            .and_then(serde_json::Value::as_bool),
        "dataReplace": data.and_then(|data| data.get("replace")).and_then(serde_json::Value::as_bool),
        "hasDeltaText": payload.and_then(|payload| payload.get("deltaText")).is_some(),
        "deltaTextLength": payload
            .and_then(|payload| payload.get("deltaText"))
            .and_then(serde_json::Value::as_str)
            .map_or(0, str::len),
        "hasMessage": message.is_some(),
        "messageTextLength": message.and_then(message_text_length).unwrap_or(0),
        "messageThinkingLength": message.and_then(message_thinking_length).unwrap_or(0),
        "hasRunId": payload.and_then(|payload| payload.get("runId")).is_some(),
        "hasSessionKey": payload.and_then(|payload| payload.get("sessionKey")).is_some(),
    })
}

fn trace_gateway_drop(
    stage: &'static str,
    mut payload: Option<serde_json::Value>,
    reason: impl Into<String>,
) {
    if !super::trace::enabled() {
        return;
    }
    let Some(payload) = payload.as_mut() else {
        return;
    };
    if let serde_json::Value::Object(fields) = payload {
        fields.insert(
            "dropReason".into(),
            serde_json::Value::String(reason.into()),
        );
    }
    super::trace::log_unscoped(stage, payload.clone());
}

fn trace_decoded_event(stage: &'static str, envelope: &SessionEventEnvelope, epoch: GatewayEpoch) {
    if !super::trace::enabled() {
        return;
    }
    let chat = envelope.chat.as_ref();
    super::trace::log_unscoped(
        stage,
        serde_json::json!({
            "sourceEpoch": epoch.as_u64(),
            "kind": format!("{:?}", envelope.kind),
            "gatewaySequence": envelope.gateway_sequence,
            "hasRunId": envelope.run_id.is_some(),
            "hasMessageId": envelope.message_id.is_some(),
            "hasEmbeddedMessageId": envelope.embedded_message_id.is_some(),
            "hasChat": envelope.chat.is_some(),
            "chatState": chat.map(|chat| format!("{:?}", chat.state)),
            "deltaTextLength": chat.and_then(|chat| chat.delta_text.as_ref()).map_or(0, String::len),
            "replace": chat.is_some_and(|chat| chat.replace),
            "messageTextLength": chat.and_then(|chat| chat.message_text.as_ref()).map_or(0, String::len),
            "messageThinkingLength": chat.and_then(|chat| chat.message_thinking.as_ref()).map_or(0, String::len),
            "hasActivity": envelope.activity.is_some(),
            "hasApproval": envelope.approval.is_some(),
        }),
    );
}

fn message_text_length(message: &serde_json::Value) -> Option<usize> {
    message_content_length(message, "text", "text")
}

fn message_thinking_length(message: &serde_json::Value) -> Option<usize> {
    message_content_length(message, "thinking", "thinking")
}

fn message_content_length(
    message: &serde_json::Value,
    block_type: &str,
    text_key: &str,
) -> Option<usize> {
    message
        .get("content")
        .and_then(serde_json::Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter_map(|block| {
                    (block.get("type").and_then(serde_json::Value::as_str) == Some(block_type))
                        .then(|| block.get(text_key).and_then(serde_json::Value::as_str))?
                })
                .map(str::len)
                .sum()
        })
}

/// Consumes a socket's decoded Gateway events, sequences them through the
/// shared [`Ingress`], and fans each verified event out to the lifecycle sink
/// and the canonical-delta sink.
pub(crate) struct SessionEventIngest {
    ingress: Arc<Ingress>,
    next_epoch: AtomicU64,
    route_keys: Arc<Mutex<HashMap<SessionKey, String>>>,
    canonical_events: mpsc::Sender<CanonicalIngressResult>,
}

impl SessionEventIngest {
    pub(crate) fn new(
        events: mpsc::Sender<SessionEvent>,
        canonical_events: mpsc::Sender<CanonicalIngressResult>,
    ) -> Self {
        let (ingress, receiver) = Ingress::new(NonZeroUsize::new(INGRESS_CAPACITY).unwrap());
        let route_keys = Arc::new(Mutex::new(HashMap::new()));
        tokio::spawn(project_ingress(
            receiver,
            events,
            canonical_events.clone(),
            Arc::clone(&route_keys),
        ));
        Self {
            ingress: Arc::new(ingress),
            next_epoch: AtomicU64::new(0),
            route_keys,
            canonical_events,
        }
    }

    pub(crate) fn register_route(&self, session_key: SessionKey, route_key: String) {
        self.route_keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(session_key, route_key);
    }

    pub(crate) fn unregister_route(&self, session_key: &SessionKey) {
        self.route_keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(session_key);
    }

    /// Drives one socket's event stream through the ingress. Each call is a new
    /// connection epoch, so a reconnect advances the shared cursor instead of
    /// replaying the previous socket's tail.
    pub(crate) fn forward(self: &Arc<Self>, events: mpsc::Receiver<GatewayEvent>) {
        let ingest = Arc::clone(self);
        tokio::spawn(async move {
            let epoch = ingest.begin_next_epoch();
            let mut events = events;
            while let Some(event) = events.recv().await {
                let trace_payload =
                    super::trace::enabled().then(|| gateway_event_trace_payload(&event, epoch));
                let envelope = match decode_session_event(event) {
                    Ok(Some(envelope)) => envelope,
                    Ok(None) => continue,
                    Err(error) => {
                        trace_gateway_drop(
                            "runtime.openclaw.ingress.dropped",
                            trace_payload,
                            error.to_string(),
                        );
                        continue;
                    }
                };
                trace_decoded_event("runtime.openclaw.ingress.decoded", &envelope, epoch);
                let session_key = envelope.session_key.clone();
                match ingest.ingress.try_ingest(epoch, envelope) {
                    Ok(()) | Err(IngressError::StaleEpoch) => {}
                    Err(error) => {
                        ingest
                            .publish_recovery(session_key, Some(epoch), error)
                            .await
                    }
                }
            }
        });
    }

    fn begin_next_epoch(&self) -> GatewayEpoch {
        let value = self.next_epoch.fetch_add(1, Ordering::Relaxed) + 1;
        let epoch = GatewayEpoch::try_new(value).expect("epoch counter never yields zero");
        self.ingress
            .begin_epoch(epoch)
            .expect("epoch counter is monotonic");
        epoch
    }

    async fn publish_recovery(
        &self,
        session_key: SessionKey,
        epoch: Option<GatewayEpoch>,
        error: IngressError,
    ) {
        let route_key = self
            .route_keys
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&session_key)
            .cloned();
        let recovery =
            CanonicalSessionDeltaProducer::from_ingress_error(session_key, route_key, epoch, error);
        let _ = self
            .canonical_events
            .send(CanonicalIngressResult::Produced(recovery))
            .await;
    }
}

async fn project_ingress(
    mut receiver: mpsc::Receiver<IngressEvent>,
    events: mpsc::Sender<SessionEvent>,
    canonical_events: mpsc::Sender<CanonicalIngressResult>,
    route_keys: Arc<Mutex<HashMap<SessionKey, String>>>,
) {
    let mut router = EventRouter::new(canonical_events);
    while let Some(ingress_event) = receiver.recv().await {
        let epoch = ingress_event.epoch();
        let envelope = ingress_event.event();
        let _ = send_lifecycle(&events, envelope, epoch);
        let route_key = route_key_for(envelope, &route_keys);
        trace_decoded_event("runtime.openclaw.ingress.routed", envelope, epoch);
        router.route(envelope.clone(), epoch, route_key).await;
        if should_clear_route_key(envelope) {
            clear_route_key(envelope, &route_keys);
        }
    }
}

fn route_key_for(
    envelope: &SessionEventEnvelope,
    route_keys: &Mutex<HashMap<SessionKey, String>>,
) -> Option<String> {
    route_keys
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&envelope.session_key)
        .cloned()
}

fn should_clear_route_key(envelope: &SessionEventEnvelope) -> bool {
    matches!(envelope.kind, SessionEventKind::Chat)
        && envelope.chat.as_ref().is_some_and(|chat| {
            matches!(
                chat.state,
                ChatState::Final | ChatState::Aborted | ChatState::Error
            )
        })
}

fn clear_route_key(
    envelope: &SessionEventEnvelope,
    route_keys: &Mutex<HashMap<SessionKey, String>>,
) {
    route_keys
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&envelope.session_key);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        events::TerminalOutcome,
        projection::{AssistantTurnChunkKind, CanonicalSessionChange},
        protocol::{ChatEvent, RunId},
    };
    use serde_json::json;
    use tokio::sync::mpsc;

    fn session_key() -> SessionKey {
        SessionKey::try_new("agent:main:session-1").unwrap()
    }

    fn run(value: &str) -> RunId {
        RunId::try_new(value).unwrap()
    }

    fn envelope(run_id: &str, state: ChatState) -> SessionEventEnvelope {
        let session_key = session_key();
        let run_id = run(run_id);
        SessionEventEnvelope {
            gateway_sequence: Some(1),
            kind: SessionEventKind::Chat,
            session_key: session_key.clone(),
            run_id: Some(run_id.clone()),
            message_id: None,
            embedded_message_id: None,
            chat: Some(ChatEvent {
                run_id,
                session_key,
                sequence: 1,
                state,
                status_phase: None,
                delta_text: Some("delta".to_owned()),
                replace: false,
                message_text: None,
                message_thinking: None,
                error_kind: None,
                error_message: None,
                stop_reason: None,
                error_detail: None,
            }),
            activity: None,
            approval: None,
        }
    }

    #[test]
    fn route_key_uses_session_key_not_run_id() {
        let route_keys = Mutex::new(HashMap::from([(
            session_key(),
            "renderer-route:session".to_owned(),
        )]));

        assert_eq!(
            route_key_for(&envelope("native-run", ChatState::Delta), &route_keys).as_deref(),
            Some("renderer-route:session")
        );
    }

    #[test]
    fn terminal_chat_clears_session_route() {
        let route_keys = Mutex::new(HashMap::from([(
            session_key(),
            "renderer-route:session".to_owned(),
        )]));

        let terminal = envelope("native-run", ChatState::Final);
        assert!(should_clear_route_key(&terminal));
        clear_route_key(&terminal, &route_keys);

        assert_eq!(
            route_key_for(&envelope("another-run", ChatState::Delta), &route_keys),
            None
        );
    }

    #[tokio::test]
    async fn messages_subscribe_events_emit_route_bound_delta_and_terminal() {
        let (_events_tx, mut events_rx) = mpsc::channel(8);
        let (canonical_tx, mut canonical_rx) = mpsc::channel(8);
        let ingest = Arc::new(SessionEventIngest::new(_events_tx, canonical_tx));
        let (gateway_tx, gateway_rx) = mpsc::channel(8);
        ingest.register_route(session_key(), "renderer-route:session".to_owned());
        ingest.forward(gateway_rx);

        gateway_tx
            .send(GatewayEvent {
                name: "chat".to_owned(),
                payload: Some(json!({
                    "sessionKey": "agent:main:session-1",
                    "runId": "native-run",
                    "seq": 1,
                    "state": "delta",
                    "deltaText": "hello"
                })),
                sequence: Some(1),
                state_version: None,
            })
            .await
            .unwrap();
        gateway_tx
            .send(GatewayEvent {
                name: "chat".to_owned(),
                payload: Some(json!({
                    "sessionKey": "agent:main:session-1",
                    "runId": "native-run",
                    "seq": 2,
                    "state": "final"
                })),
                sequence: Some(2),
                state_version: None,
            })
            .await
            .unwrap();
        drop(gateway_tx);

        let produced = canonical_rx.recv().await.expect("delta canonical event");
        let CanonicalIngressResult::Produced(delta) = produced else {
            panic!("expected produced delta");
        };
        assert_eq!(delta.route_key(), Some("renderer-route:session"));
        assert_eq!(delta.run_id().unwrap().as_str(), "native-run");
        assert!(matches!(
            delta.changes(),
            [CanonicalSessionChange::AssistantTurnChunk {
                kind: AssistantTurnChunkKind::Text,
                text,
                ..
            }] if text == "hello"
        ));

        let produced = canonical_rx.recv().await.expect("terminal canonical event");
        let CanonicalIngressResult::Produced(delta) = produced else {
            panic!("expected produced terminal");
        };
        assert_eq!(delta.route_key(), Some("renderer-route:session"));
        assert!(matches!(
            delta.changes(),
            [CanonicalSessionChange::Terminal {
                outcome: TerminalOutcome::Completed,
                ..
            }]
        ));
        assert_eq!(
            route_key_for(
                &envelope("native-run", ChatState::Delta),
                &ingest.route_keys
            ),
            None
        );

        assert!(events_rx.recv().await.is_some());
        assert!(events_rx.recv().await.is_some());
    }
}
