use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::Value;

use crate::protocol::wire::{JsonRpcId, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse};

use super::{
    model::{ClientId, EventId, MessageId, RunId, Sequence, SessionId, ValidationError, WorkerId},
    request::{RequestError, ResponseError, decode_result, request},
};

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ReplayLimit(f64);

impl ReplayLimit {
    pub fn try_new(value: f64) -> Result<Self, ValidationError> {
        if !value.is_finite() {
            return Err(ValidationError::new("limit must be a finite number"));
        }
        Ok(Self(value))
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl fmt::Debug for ReplayLimit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReplayLimit([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsReplayParams {
    session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    after_seq: Option<Sequence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limit: Option<ReplayLimit>,
}

impl fmt::Debug for EventsReplayParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EventsReplayParams")
            .field("has_after_seq", &self.after_seq.is_some())
            .field("has_limit", &self.limit.is_some())
            .finish()
    }
}

impl EventsReplayParams {
    pub fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            after_seq: None,
            limit: None,
        }
    }

    pub fn after(mut self, sequence: Sequence) -> Self {
        self.after_seq = Some(sequence);
        self
    }

    pub fn with_limit(mut self, limit: ReplayLimit) -> Self {
        self.limit = Some(limit);
        self
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsSubscribeParams {
    session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    after_seq: Option<Sequence>,
}

impl fmt::Debug for EventsSubscribeParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EventsSubscribeParams")
            .field("has_after_seq", &self.after_seq.is_some())
            .finish()
    }
}

impl EventsSubscribeParams {
    pub fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            after_seq: None,
        }
    }

    pub fn after(mut self, sequence: Sequence) -> Self {
        self.after_seq = Some(sequence);
        self
    }
}

#[derive(Clone, PartialEq)]
pub struct Event {
    value: Value,
    message_id: Option<MessageId>,
}

impl fmt::Debug for Event {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Event")
            .field("has_message_id", &self.message_id.is_some())
            .finish()
    }
}

impl Event {
    pub(crate) fn try_new(value: Value) -> Result<Self, ValidationError> {
        let object = value
            .as_object()
            .ok_or(ValidationError::new("event must be an object"))?;
        let event_type = object
            .get("type")
            .and_then(Value::as_str)
            .filter(|event_type| !event_type.trim().is_empty())
            .ok_or(ValidationError::new(
                "event type must be a non-empty string",
            ))?;
        let message_id = match event_type {
            "message.started" | "message.delta" | "message.completed" => Some(
                object
                    .get("messageId")
                    .and_then(Value::as_str)
                    .ok_or(ValidationError::new(
                        "message event must contain a non-empty messageId",
                    ))
                    .and_then(MessageId::try_new)?,
            ),
            _ => None,
        };
        Ok(Self { value, message_id })
    }

    pub fn event_type(&self) -> &str {
        self.value["type"]
            .as_str()
            .expect("Event::try_new establishes the event type")
    }

    pub fn message_id(&self) -> Option<&MessageId> {
        self.message_id.as_ref()
    }

    pub(crate) fn as_value(&self) -> &Value {
        &self.value
    }
}

impl Serialize for Event {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.value.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Event {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::try_new(Value::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub event_id: EventId,
    pub session_id: SessionId,
    pub seq: Sequence,
    pub run_id: Option<RunId>,
    pub worker_id: Option<WorkerId>,
    pub created_at: String,
    pub event: Event,
}

impl<'de> Deserialize<'de> for EventEnvelope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = EventEnvelopeWire::deserialize(deserializer)?;
        if wire.seq.get() == 0 {
            return Err(D::Error::custom("event sequence must start at one"));
        }
        Ok(Self {
            event_id: wire.event_id,
            session_id: wire.session_id,
            seq: wire.seq,
            run_id: wire.run_id,
            worker_id: wire.worker_id,
            created_at: wire.created_at,
            event: wire.event,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventEnvelopeWire {
    event_id: EventId,
    session_id: SessionId,
    seq: Sequence,
    run_id: Option<RunId>,
    worker_id: Option<WorkerId>,
    created_at: String,
    event: Event,
}

impl fmt::Debug for EventEnvelope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EventEnvelope")
            .field("has_run_id", &self.run_id.is_some())
            .field("has_worker_id", &self.worker_id.is_some())
            .field("has_message_id", &self.event.message_id().is_some())
            .finish()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct EventsReplayResult {
    pub events: Vec<EventEnvelope>,
}

impl fmt::Debug for EventsReplayResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EventsReplayResult")
            .field("event_count", &self.events.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "resultType",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EventsSubscribeResult {
    Subscribed {
        client_id: ClientId,
        session_id: SessionId,
        after_seq: Option<Sequence>,
        last_seq: Sequence,
    },
    ClientNotFound {
        client_id: ClientId,
    },
    ClientRequired,
}

impl fmt::Debug for EventsSubscribeResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut result = formatter.debug_struct("EventsSubscribeResult");
        match self {
            Self::Subscribed {
                after_seq,
                last_seq,
                ..
            } => result
                .field("state", &"subscribed")
                .field("has_after_seq", &after_seq.is_some())
                .field("last_seq", &last_seq.get())
                .finish(),
            Self::ClientNotFound { .. } => result.field("state", &"client_not_found").finish(),
            Self::ClientRequired => result.field("state", &"client_required").finish(),
        }
    }
}

pub(crate) fn events_replay_request(
    id: JsonRpcId,
    params: EventsReplayParams,
) -> Result<JsonRpcRequest, RequestError> {
    request(id, "events.replay", params)
}

pub(crate) fn decode_events_replay_result(
    expected_id: &JsonRpcId,
    response: JsonRpcResponse,
) -> Result<EventsReplayResult, ResponseError> {
    decode_result(expected_id, response, "events.replay")
}

pub(crate) fn events_subscribe_request(
    id: JsonRpcId,
    params: EventsSubscribeParams,
) -> Result<JsonRpcRequest, RequestError> {
    request(id, "events.subscribe", params)
}

pub(crate) fn decode_events_subscribe_result(
    expected_id: &JsonRpcId,
    response: JsonRpcResponse,
) -> Result<EventsSubscribeResult, ResponseError> {
    decode_result(expected_id, response, "events.subscribe")
}

pub(crate) fn decode_event_notification(
    notification: JsonRpcNotification,
) -> Result<EventEnvelope, ResponseError> {
    if notification.method != "event" {
        return Err(ResponseError::InvalidEvent);
    }
    serde_json::from_value(notification.params.ok_or(ResponseError::InvalidEvent)?)
        .map_err(|_| ResponseError::InvalidEvent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::wire::{JsonRpcMessage, decode, encode};

    fn id(value: &str) -> JsonRpcId {
        JsonRpcId::String(value.to_owned())
    }

    fn session_id() -> SessionId {
        SessionId::try_new("session-1").unwrap()
    }

    fn frame(request: JsonRpcRequest) -> String {
        encode(&JsonRpcMessage::from(request)).unwrap()
    }

    fn notification(frame: &str) -> JsonRpcNotification {
        match decode(frame).unwrap() {
            JsonRpcMessage::Notification(notification) => notification,
            _ => panic!("expected notification"),
        }
    }

    #[test]
    fn subscribe_without_cursor_omits_after_seq() {
        let subscribe = frame(
            events_subscribe_request(id("subscribe"), EventsSubscribeParams::new(session_id()))
                .unwrap(),
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&subscribe).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "subscribe",
                "method": "events.subscribe",
                "params": { "sessionId": "session-1" }
            }),
        );
    }

    #[test]
    fn replay_and_subscribe_requests_match_native_edge_v1() {
        let replay = frame(
            events_replay_request(
                id("replay"),
                EventsReplayParams::new(session_id())
                    .after(Sequence::try_new(7).unwrap())
                    .with_limit(ReplayLimit::try_new(25.5).unwrap()),
            )
            .unwrap(),
        );
        let replay_expected = "{\"jsonrpc\":\"2.0\",\"id\":\"replay\",\"method\":\"events.replay\",\"params\":{\"sessionId\":\"session-1\",\"afterSeq\":7,\"limit\":25.5}}\n";
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&replay).unwrap(),
            serde_json::from_str::<serde_json::Value>(replay_expected).unwrap(),
        );

        let subscribe = frame(
            events_subscribe_request(
                id("9"),
                EventsSubscribeParams::new(session_id()).after(Sequence::try_new(7).unwrap()),
            )
            .unwrap(),
        );
        let subscribe_expected = "{\"jsonrpc\":\"2.0\",\"id\":\"9\",\"method\":\"events.subscribe\",\"params\":{\"sessionId\":\"session-1\",\"afterSeq\":7}}\n";
        assert!(subscribe.ends_with('\n'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&subscribe).unwrap(),
            serde_json::from_str::<serde_json::Value>(subscribe_expected).unwrap(),
        );
        assert!(ReplayLimit::try_new(f64::NAN).is_err());
    }

    #[test]
    fn replay_result_and_event_decoder_preserve_protocol_identities() {
        let replay = decode_events_replay_result(
            &id("replay"),
            match decode(r#"{"jsonrpc":"2.0","id":"replay","result":{"events":[{"eventId":"event-10","sessionId":"session-1","seq":10,"createdAt":"now","event":{"type":"run.started","runId":"run-1"}}]}}"#).unwrap() {
                JsonRpcMessage::Response(response) => response,
                _ => panic!("expected response"),
            },
        )
        .unwrap();
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].seq.get(), 10);
        let replay_debug = format!("{replay:?}");
        assert!(!replay_debug.contains("event-10"));
        assert!(!replay_debug.contains("session-1"));

        let subscription = decode_events_subscribe_result(
            &id("subscribe"),
            match decode(r#"{"jsonrpc":"2.0","id":"subscribe","result":{"resultType":"subscribed","clientId":"client-1","sessionId":"session-1","afterSeq":7,"lastSeq":9}}"#).unwrap() {
                JsonRpcMessage::Response(response) => response,
                _ => panic!("expected response"),
            },
        )
        .unwrap();
        assert!(matches!(
            subscription,
            EventsSubscribeResult::Subscribed { last_seq, .. } if last_seq.get() == 9
        ));
        assert_eq!(
            decode_events_subscribe_result(
                &id("subscribe"),
                match decode(r#"{"jsonrpc":"2.0","id":"subscribe","result":{"resultType":"subscribed","clientId":"client-1","sessionId":"session-1","afterSeq":7}}"#).unwrap() {
                    JsonRpcMessage::Response(response) => response,
                    _ => panic!("expected response"),
                },
            )
            .unwrap_err(),
            ResponseError::InvalidResult {
                method: "events.subscribe"
            }
        );

        let envelope = decode_event_notification(notification(
            r#"{"jsonrpc":"2.0","method":"event","params":{"eventId":"event-11","sessionId":"session-1","seq":11,"runId":"run-9","createdAt":"2026-01-01T00:00:00.000Z","event":{"type":"message.delta","messageId":"message-4","delta":"hi"}}}"#,
        ))
        .unwrap();
        assert_eq!(envelope.seq.get(), 11);
        assert_eq!(envelope.run_id.unwrap().as_str(), "run-9");
        assert_eq!(envelope.event.message_id().unwrap().as_str(), "message-4");
    }

    #[test]
    fn event_decoder_rejects_invalid_sequence_and_message_identity() {
        for seq in ["-1", "0", "1.5", "9007199254740992"] {
            let frame = format!(
                "{{\"jsonrpc\":\"2.0\",\"method\":\"event\",\"params\":{{\"eventId\":\"event-1\",\"sessionId\":\"session-1\",\"seq\":{seq},\"createdAt\":\"now\",\"event\":{{\"type\":\"run.started\",\"runId\":\"run-1\",\"workerId\":\"worker-1\"}}}}}}"
            );
            let error = decode_event_notification(notification(&frame)).unwrap_err();
            assert_eq!(error, ResponseError::InvalidEvent);
        }

        let error = decode_event_notification(notification(
            r#"{"jsonrpc":"2.0","method":"event","params":{"eventId":"event-1","sessionId":"session-1","seq":1,"createdAt":"now","event":{"type":"message.delta","messageId":42,"delta":"secret body"}}}"#,
        ))
        .unwrap_err();
        assert_eq!(error.to_string(), "invalid event notification");
        assert!(!error.to_string().contains("secret body"));
    }

    #[test]
    fn debug_output_is_structural_and_redacts_protocol_values() {
        let envelope = decode_event_notification(notification(
            r#"{"jsonrpc":"2.0","method":"event","params":{"eventId":"event-secret","sessionId":"session-secret","seq":41,"runId":"run-secret","workerId":"worker-secret","createdAt":"created-at-secret","event":{"type":"event-type-secret","messageId":"message-secret","delta":"payload-secret"}}}"#,
        ))
        .unwrap();
        let event_debug = format!("{:?}", envelope.event);
        assert_eq!(event_debug, "Event { has_message_id: false }");

        let envelope_debug = format!("{envelope:?}");
        assert_eq!(
            envelope_debug,
            "EventEnvelope { has_run_id: true, has_worker_id: true, has_message_id: false }"
        );

        let subscribed = EventsSubscribeResult::Subscribed {
            client_id: ClientId::try_new("client-secret").unwrap(),
            session_id: SessionId::try_new("subscribe-session-secret").unwrap(),
            after_seq: Some(Sequence::try_new(40).unwrap()),
            last_seq: Sequence::try_new(41).unwrap(),
        };
        assert_eq!(
            format!("{subscribed:?}"),
            "EventsSubscribeResult { state: \"subscribed\", has_after_seq: true, last_seq: 41 }"
        );

        let params =
            EventsSubscribeParams::new(SessionId::try_new("params-session-secret").unwrap())
                .after(Sequence::try_new(40).unwrap());
        let replay_params =
            EventsReplayParams::new(SessionId::try_new("replay-params-session-secret").unwrap())
                .after(Sequence::try_new(40).unwrap())
                .with_limit(ReplayLimit::try_new(12.5).unwrap());
        let debug_outputs = [
            event_debug,
            envelope_debug,
            format!("{subscribed:?}"),
            format!("{params:?}"),
            format!("{replay_params:?}"),
            format!(
                "{:?}",
                EventsSubscribeResult::ClientNotFound {
                    client_id: ClientId::try_new("missing-client-secret").unwrap(),
                }
            ),
        ];
        for debug in debug_outputs {
            for secret in [
                "event-secret",
                "event-type-secret",
                "session-secret",
                "run-secret",
                "worker-secret",
                "message-secret",
                "client-secret",
                "created-at-secret",
                "payload-secret",
                "replay-params-session-secret",
            ] {
                assert!(
                    !debug.contains(secret),
                    "debug output leaked {secret}: {debug}"
                );
            }
        }
    }
}
