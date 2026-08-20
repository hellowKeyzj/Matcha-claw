use std::fmt;

use serde::{Deserialize, Serialize};

use crate::protocol::wire::{JsonRpcId, JsonRpcRequest, JsonRpcResponse};

use super::{
    model::SessionId,
    request::{RequestError, ResponseError, decode_result, request},
};

/// Parameters for closing one logical app-server session.
#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseParams {
    session_id: SessionId,
}

impl SessionCloseParams {
    pub fn new(session_id: SessionId) -> Self {
        Self { session_id }
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }
}

impl fmt::Debug for SessionCloseParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCloseParams")
            .field("has_session_id", &true)
            .finish()
    }
}

/// Acknowledges a completed logical-session close.
///
/// This is not an active-session record. The native response contains a
/// pre-removal record, which is intentionally not exposed after the close.
#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseResult {
    session_id: SessionId,
}

impl SessionCloseResult {
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }
}

impl fmt::Debug for SessionCloseResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCloseResult")
            .field("closed", &true)
            .finish()
    }
}

pub(crate) fn session_close_request(
    id: JsonRpcId,
    params: SessionCloseParams,
) -> Result<JsonRpcRequest, RequestError> {
    request(id, "session.close", params)
}

pub(crate) fn decode_session_close_result(
    expected_id: &JsonRpcId,
    response: JsonRpcResponse,
) -> Result<SessionCloseResult, ResponseError> {
    decode_result(expected_id, response, "session.close")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::protocol::wire::{JsonRpcMessage, decode, encode};

    fn session_id() -> SessionId {
        SessionId::try_new("session-close-canary").unwrap()
    }

    #[test]
    fn close_request_matches_native_edge_and_debug_is_redacted() {
        let request = session_close_request(
            JsonRpcId::Number(1.into()),
            SessionCloseParams::new(session_id()),
        )
        .unwrap();
        let frame = encode(&JsonRpcMessage::from(request)).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&frame).unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "session.close",
                "params": {"sessionId": "session-close-canary"},
            })
        );

        let debug = format!("{:?}", SessionCloseParams::new(session_id()));
        assert_eq!(debug, "SessionCloseParams { has_session_id: true }");
        assert!(!debug.contains("session-close-canary"));
    }

    #[test]
    fn close_result_keeps_only_close_confirmation() {
        let response = match decode(
            r#"{"jsonrpc":"2.0","id":1,"result":{"sessionId":"session-close-canary","createdAt":"private","updatedAt":"private","runtime":"matcha-agent","lastSeq":3,"lastSnapshotVersion":1,"workerState":{"state":"unloaded","reason":"notStarted"}}}"#,
        )
        .unwrap()
        {
            JsonRpcMessage::Response(response) => response,
            _ => panic!("expected response"),
        };
        let result = decode_session_close_result(&JsonRpcId::Number(1.into()), response).unwrap();

        assert_eq!(result.session_id().as_str(), "session-close-canary");
        assert_eq!(result.session_id(), &session_id());
        let debug = format!("{result:?}");
        assert_eq!(debug, "SessionCloseResult { closed: true }");
        for canary in ["session-close-canary", "private"] {
            assert!(!debug.contains(canary));
        }
    }

    #[test]
    fn close_result_cannot_confirm_a_different_session() {
        let response = match decode(
            r#"{"jsonrpc":"2.0","id":1,"result":{"sessionId":"other-session-canary"}}"#,
        )
        .unwrap()
        {
            JsonRpcMessage::Response(response) => response,
            _ => panic!("expected response"),
        };
        let result = decode_session_close_result(&JsonRpcId::Number(1.into()), response).unwrap();

        assert_ne!(result.session_id(), &session_id());
    }
}
