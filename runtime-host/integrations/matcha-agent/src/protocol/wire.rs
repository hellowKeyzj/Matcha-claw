use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Number, Value};

use super::{error::DecodeError, grammar};

pub const APP_SERVER_PROTOCOL_VERSION: &str = "matcha-agent-app-server-v1";
pub const JSON_RPC_VERSION: &str = "2.0";

#[cfg(test)]
pub const PARSE_ERROR: i64 = -32700;
#[cfg(test)]
pub const INVALID_REQUEST: i64 = -32600;
#[cfg(test)]
pub const METHOD_NOT_FOUND: i64 = -32601;
#[cfg(test)]
pub const INVALID_PARAMS: i64 = -32602;
#[cfg(test)]
pub const INTERNAL_ERROR: i64 = -32603;

#[derive(Clone, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    String(String),
    Number(Number),
}

impl fmt::Debug for JsonRpcId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::String(_) => formatter.write_str("JsonRpcId::String"),
            Self::Number(_) => formatter.write_str("JsonRpcId::Number"),
        }
    }
}

#[derive(Clone, PartialEq, Serialize)]
pub struct JsonRpcRequest {
    #[serde(rename = "jsonrpc")]
    version: &'static str,
    pub id: JsonRpcId,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl fmt::Debug for JsonRpcRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JsonRpcRequest")
            .field("has_params", &self.params.is_some())
            .finish()
    }
}

impl JsonRpcRequest {
    pub fn new(id: JsonRpcId, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            version: JSON_RPC_VERSION,
            id,
            method: method.into(),
            params,
        }
    }
}

#[derive(Clone, PartialEq, Serialize)]
pub struct JsonRpcNotification {
    #[serde(rename = "jsonrpc")]
    version: &'static str,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl fmt::Debug for JsonRpcNotification {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JsonRpcNotification")
            .field("has_params", &self.params.is_some())
            .finish()
    }
}

impl JsonRpcNotification {
    pub fn new(method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            version: JSON_RPC_VERSION,
            method: method.into(),
            params,
        }
    }
}

#[derive(Clone, PartialEq, Serialize)]
pub struct JsonRpcSuccess {
    #[serde(rename = "jsonrpc")]
    version: &'static str,
    pub id: JsonRpcId,
    pub result: Value,
}

impl fmt::Debug for JsonRpcSuccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JsonRpcSuccess")
    }
}

#[derive(Clone, PartialEq, Serialize)]
pub struct JsonRpcFailure {
    #[serde(rename = "jsonrpc")]
    version: &'static str,
    pub id: Option<JsonRpcId>,
    pub error: JsonRpcError,
}

impl fmt::Debug for JsonRpcFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JsonRpcFailure")
    }
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct JsonRpcError {
    pub code: i64,
    message: &'static str,
    #[serde(skip)]
    has_data: bool,
    #[serde(skip)]
    session_not_found: bool,
}

impl fmt::Debug for JsonRpcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JsonRpcError")
            .field("code", &self.code)
            .field("has_data", &self.has_data)
            .finish()
    }
}

impl JsonRpcError {
    pub(super) const fn peer_rejection(code: i64, has_data: bool) -> Self {
        Self {
            code,
            message: "app-server request rejected",
            has_data,
            session_not_found: false,
        }
    }

    pub(super) const fn session_not_found(code: i64, has_data: bool) -> Self {
        Self {
            code,
            message: "app-server request rejected",
            has_data,
            session_not_found: true,
        }
    }

    pub(crate) const fn is_session_not_found(&self) -> bool {
        self.session_not_found
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JsonRpcResponse {
    Success(JsonRpcSuccess),
    Failure(JsonRpcFailure),
}

impl fmt::Debug for JsonRpcResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Success(_) => formatter.write_str("JsonRpcResponse::Success"),
            Self::Failure(_) => formatter.write_str("JsonRpcResponse::Failure"),
        }
    }
}

impl JsonRpcResponse {
    pub fn success(id: JsonRpcId, result: Value) -> Self {
        Self::Success(JsonRpcSuccess {
            version: JSON_RPC_VERSION,
            id,
            result,
        })
    }

    pub fn failure(id: Option<JsonRpcId>, error: JsonRpcError) -> Self {
        Self::Failure(JsonRpcFailure {
            version: JSON_RPC_VERSION,
            id,
            error,
        })
    }
}

impl<'de> Deserialize<'de> for JsonRpcResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        grammar::decode_response(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Notification(JsonRpcNotification),
    Response(JsonRpcResponse),
}

impl fmt::Debug for JsonRpcMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request(_) => formatter.write_str("JsonRpcMessage::Request"),
            Self::Notification(_) => formatter.write_str("JsonRpcMessage::Notification"),
            Self::Response(_) => formatter.write_str("JsonRpcMessage::Response"),
        }
    }
}

impl From<JsonRpcRequest> for JsonRpcMessage {
    fn from(request: JsonRpcRequest) -> Self {
        Self::Request(request)
    }
}

impl From<JsonRpcNotification> for JsonRpcMessage {
    fn from(notification: JsonRpcNotification) -> Self {
        Self::Notification(notification)
    }
}

impl From<JsonRpcResponse> for JsonRpcMessage {
    fn from(response: JsonRpcResponse) -> Self {
        Self::Response(response)
    }
}

impl<'de> Deserialize<'de> for JsonRpcMessage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        grammar::decode_message(value).map_err(serde::de::Error::custom)
    }
}

pub fn encode(message: &JsonRpcMessage) -> Result<String, serde_json::Error> {
    let mut frame = serde_json::to_string(message)?;
    frame.push('\n');
    Ok(frame)
}

pub fn decode(frame: &str) -> Result<JsonRpcMessage, DecodeError> {
    let value =
        serde_json::from_str(frame).map_err(|_| crate::protocol::error::DecodeError::Parse)?;
    grammar::decode_message(value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn request_and_notification_frames_match_the_active_wire() {
        let request =
            decode(r#"{"jsonrpc":"2.0","id":"request-1","method":"initialize","params":null}"#)
                .unwrap();
        assert_eq!(
            encode(&request).unwrap(),
            "{\"jsonrpc\":\"2.0\",\"id\":\"request-1\",\"method\":\"initialize\",\"params\":null}\n"
        );

        let notification =
            decode(r#"{"jsonrpc":"2.0","method":"event","params":{"seq":1}}"#).unwrap();
        assert_eq!(
            encode(&notification).unwrap(),
            "{\"jsonrpc\":\"2.0\",\"method\":\"event\",\"params\":{\"seq\":1}}\n"
        );
    }

    #[test]
    fn response_requires_exactly_one_result_or_error() {
        for frame in [
            r#"{"jsonrpc":"2.0","id":1}"#,
            r#"{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":-32603,"message":"failed"}}"#,
        ] {
            assert!(matches!(
                decode(frame),
                Err(crate::protocol::error::DecodeError::InvalidRequest { .. })
            ));
        }
        assert!(matches!(
            decode(r#"{"jsonrpc":"2.0","id":1,"result":null,"future":true}"#),
            Err(crate::protocol::error::DecodeError::InvalidRequest { .. })
        ));
    }

    #[test]
    fn wire_debug_output_is_structural_and_redacted() {
        let id = JsonRpcId::String("secret-id".to_owned());
        let numeric_id = JsonRpcId::Number(Number::from(4_242));
        let request = JsonRpcRequest::new(
            id.clone(),
            "secret-request-method",
            Some(json!({"secret-params": true})),
        );
        let notification = JsonRpcNotification::new(
            "secret-notification-method",
            Some(json!({"secret-notification-params": true})),
        );
        let success = JsonRpcSuccess {
            version: JSON_RPC_VERSION,
            id: id.clone(),
            result: json!({"secret-result": true}),
        };
        let error = JsonRpcError::peer_rejection(INTERNAL_ERROR, true);
        let failure = JsonRpcFailure {
            version: JSON_RPC_VERSION,
            id: Some(id.clone()),
            error: error.clone(),
        };

        assert_eq!(format!("{id:?}"), "JsonRpcId::String");
        assert_eq!(format!("{numeric_id:?}"), "JsonRpcId::Number");
        assert_eq!(
            format!("{request:?}"),
            "JsonRpcRequest { has_params: true }"
        );
        assert_eq!(
            format!("{notification:?}"),
            "JsonRpcNotification { has_params: true }"
        );
        assert_eq!(format!("{success:?}"), "JsonRpcSuccess");
        assert_eq!(format!("{failure:?}"), "JsonRpcFailure");
        assert_eq!(
            format!("{error:?}"),
            "JsonRpcError { code: -32603, has_data: true }"
        );
        assert_eq!(
            format!("{:?}", JsonRpcResponse::Success(success.clone())),
            "JsonRpcResponse::Success"
        );
        assert_eq!(
            format!("{:?}", JsonRpcResponse::Failure(failure.clone())),
            "JsonRpcResponse::Failure"
        );
        assert_eq!(
            format!("{:?}", JsonRpcMessage::Request(request)),
            "JsonRpcMessage::Request"
        );
        assert_eq!(
            format!("{:?}", JsonRpcMessage::Notification(notification)),
            "JsonRpcMessage::Notification"
        );
        assert_eq!(
            format!(
                "{:?}",
                JsonRpcMessage::Response(JsonRpcResponse::Success(success))
            ),
            "JsonRpcMessage::Response"
        );
    }

    #[test]
    fn decode_error_debug_does_not_expose_id() {
        let error =
            decode(r#"{"jsonrpc":"1.0","id":"secret-decode-error-id","method":"initialize"}"#)
                .unwrap_err();

        assert_eq!(format!("{error:?}"), "DecodeError::InvalidRequest");
    }

    #[test]
    fn versions_are_fixed() {
        assert_eq!(APP_SERVER_PROTOCOL_VERSION, "matcha-agent-app-server-v1");
        assert!(decode(r#"{"jsonrpc":"1.0","id":7,"method":"initialize"}"#).is_err());
        assert!(decode(r#"{"id":7,"method":"initialize"}"#).is_err());
    }

    #[test]
    fn ids_follow_request_and_response_rules() {
        for id in [json!(7), json!(1.5), json!("seven")] {
            let frame = json!({"jsonrpc": "2.0", "id": id, "method": "initialize"});
            assert!(matches!(
                decode(&frame.to_string()).unwrap(),
                JsonRpcMessage::Request(_)
            ));
        }
        assert!(decode(r#"{"jsonrpc":"2.0","id":null,"method":"initialize"}"#).is_err());
        assert!(decode(r#"{"jsonrpc":"2.0","id":null,"result":{}}"#).is_err());
        assert!(matches!(
            decode(r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"bad"}}"#)
                .unwrap(),
            JsonRpcMessage::Response(JsonRpcResponse::Failure(_))
        ));
    }

    #[test]
    fn standard_codes_are_fixed_and_extra_error_fields_are_rejected() {
        assert_eq!(
            [
                PARSE_ERROR,
                INVALID_REQUEST,
                METHOD_NOT_FOUND,
                INVALID_PARAMS,
                INTERNAL_ERROR,
            ],
            [-32700, -32600, -32601, -32602, -32603]
        );
        assert!(matches!(
            decode(
                r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"bad params","data":null,"future":true}}"#,
            ),
            Err(crate::protocol::error::DecodeError::InvalidRequest { .. })
        ));
    }
}
