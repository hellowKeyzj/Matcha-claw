use std::fmt;

use serde::{Deserialize, Serialize};

use crate::protocol::wire::{JsonRpcId, JsonRpcRequest, JsonRpcResponse};

use super::{
    model::SessionId,
    request::{RequestError, ResponseError, decode_result, request},
};

/// Optional native app-server context for listing available model identifiers.
#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<SessionId>,
}

impl ModelsListParams {
    pub fn all() -> Self {
        Self { session_id: None }
    }

    pub fn for_session(session_id: SessionId) -> Self {
        Self {
            session_id: Some(session_id),
        }
    }
}

impl fmt::Debug for ModelsListParams {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelsListParams")
            .field("has_session_id", &self.session_id.is_some())
            .finish()
    }
}

/// Model identifiers available from the native app-server.
#[derive(Clone, Eq, PartialEq, Deserialize)]
pub struct ModelsListResult {
    models: Vec<String>,
}

impl ModelsListResult {
    pub fn models(&self) -> &[String] {
        &self.models
    }
}

impl fmt::Debug for ModelsListResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelsListResult")
            .field("model_count", &self.models.len())
            .finish()
    }
}

pub(crate) fn models_list_request(
    id: JsonRpcId,
    params: ModelsListParams,
) -> Result<JsonRpcRequest, RequestError> {
    request(id, "models.list", params)
}

pub(crate) fn decode_models_list_result(
    expected_id: &JsonRpcId,
    response: JsonRpcResponse,
) -> Result<ModelsListResult, ResponseError> {
    decode_result(expected_id, response, "models.list")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::protocol::wire::{JsonRpcMessage, decode, encode};

    #[test]
    fn models_requests_preserve_optional_session_context_without_debug_leaks() {
        let all =
            models_list_request(JsonRpcId::Number(1.into()), ModelsListParams::all()).unwrap();
        let scoped = models_list_request(
            JsonRpcId::Number(2.into()),
            ModelsListParams::for_session(SessionId::try_new("model-session-canary").unwrap()),
        )
        .unwrap();

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &encode(&JsonRpcMessage::from(all)).unwrap(),
            )
            .unwrap(),
            json!({"jsonrpc": "2.0", "id": 1, "method": "models.list", "params": {}})
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &encode(&JsonRpcMessage::from(scoped)).unwrap(),
            )
            .unwrap(),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "models.list",
                "params": {"sessionId": "model-session-canary"},
            })
        );

        let debug = format!(
            "{:?}",
            ModelsListParams::for_session(SessionId::try_new("model-session-canary").unwrap())
        );
        assert_eq!(debug, "ModelsListParams { has_session_id: true }");
        assert!(!debug.contains("model-session-canary"));
    }

    #[test]
    fn models_result_decodes_without_debugging_model_values() {
        let response = match decode(
            r#"{"jsonrpc":"2.0","id":1,"result":{"models":["model-secret-1","model-secret-2"]}}"#,
        )
        .unwrap()
        {
            JsonRpcMessage::Response(response) => response,
            _ => panic!("expected response"),
        };
        let result = decode_models_list_result(&JsonRpcId::Number(1.into()), response).unwrap();

        assert_eq!(result.models(), ["model-secret-1", "model-secret-2"]);
        let debug = format!("{result:?}");
        assert_eq!(debug, "ModelsListResult { model_count: 2 }");
        assert!(!debug.contains("model-secret"));
    }
}
