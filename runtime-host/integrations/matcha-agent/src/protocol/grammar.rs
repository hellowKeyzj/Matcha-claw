use serde_json::{Map, Value};

use super::{
    error::DecodeError,
    wire::{
        JSON_RPC_VERSION, JsonRpcError, JsonRpcId, JsonRpcMessage, JsonRpcNotification,
        JsonRpcRequest, JsonRpcResponse,
    },
};

pub(super) fn decode_message(value: Value) -> Result<JsonRpcMessage, DecodeError> {
    let object = object(value, None, "JSON-RPC message must be an object")?;
    let id = request_id(&object);
    require_exact_fields(
        &object,
        &["jsonrpc", "id", "method", "params", "result", "error"],
        id.clone(),
    )?;
    require_version(&object, id.clone())?;

    if object.contains_key("method") {
        return decode_call(&object, id);
    }

    decode_response_object(&object, id).map(JsonRpcMessage::Response)
}

pub(super) fn decode_response(value: Value) -> Result<JsonRpcResponse, DecodeError> {
    let object = object(value, None, "JSON-RPC response must be an object")?;
    let id = request_id(&object);
    require_exact_fields(&object, &["jsonrpc", "id", "result", "error"], id.clone())?;
    require_version(&object, id.clone())?;
    decode_response_object(&object, id)
}

fn decode_call(
    object: &Map<String, Value>,
    id: Option<JsonRpcId>,
) -> Result<JsonRpcMessage, DecodeError> {
    if object.contains_key("result") || object.contains_key("error") {
        return Err(invalid(
            id,
            "request or notification must not contain result or error",
        ));
    }

    let method = object
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| !method.trim().is_empty())
        .ok_or_else(|| invalid(id.clone(), "method must be a non-empty string"))?
        .to_owned();
    let params = object.get("params").cloned();

    if object.contains_key("id") {
        let id = id.ok_or_else(|| invalid(None, "id must be string or number"))?;
        Ok(JsonRpcRequest::new(id, method, params).into())
    } else {
        Ok(JsonRpcNotification::new(method, params).into())
    }
}

fn decode_response_object(
    object: &Map<String, Value>,
    id: Option<JsonRpcId>,
) -> Result<JsonRpcResponse, DecodeError> {
    if object.contains_key("method") || object.contains_key("params") {
        return Err(invalid(id, "response must not contain method or params"));
    }

    match (object.contains_key("result"), object.contains_key("error")) {
        (true, false) => {
            let id = id.ok_or_else(|| invalid(None, "response id must be string or number"))?;
            Ok(JsonRpcResponse::success(id, object["result"].clone()))
        }
        (false, true) => {
            if !object.contains_key("id") {
                return Err(invalid(None, "error response must contain id"));
            }
            if !object["id"].is_null() && id.is_none() {
                return Err(invalid(
                    None,
                    "error response id must be string, number, or null",
                ));
            }
            let error = decode_error(&object["error"], id.clone())?;
            Ok(JsonRpcResponse::failure(id, error))
        }
        _ => Err(invalid(
            id,
            "response must contain exactly one of result or error",
        )),
    }
}

fn decode_error(value: &Value, id: Option<JsonRpcId>) -> Result<JsonRpcError, DecodeError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid(id.clone(), "error must be an object"))?;
    require_exact_fields(object, &["code", "message", "data"], id.clone())?;

    let code = object
        .get("code")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid(id.clone(), "error code must be an integer"))?;
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(id.clone(), "error message must be a string"))?;
    let has_data = object.contains_key("data");
    let session_not_found = message
        .strip_prefix("Session not found: ")
        .is_some_and(|session_id| {
            !session_id.is_empty() && !session_id.bytes().any(|byte| byte.is_ascii_control())
        });
    if session_not_found {
        return Ok(JsonRpcError::session_not_found(code, has_data));
    }
    Ok(JsonRpcError::peer_rejection(code, has_data))
}

fn object(
    value: Value,
    id: Option<JsonRpcId>,
    reason: &'static str,
) -> Result<Map<String, Value>, DecodeError> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid(id, reason))
}

fn require_version(object: &Map<String, Value>, id: Option<JsonRpcId>) -> Result<(), DecodeError> {
    if object.get("jsonrpc").and_then(Value::as_str) == Some(JSON_RPC_VERSION) {
        Ok(())
    } else {
        Err(invalid(id, "jsonrpc must be \"2.0\""))
    }
}

fn require_exact_fields(
    object: &Map<String, Value>,
    allowed: &[&str],
    id: Option<JsonRpcId>,
) -> Result<(), DecodeError> {
    if object.keys().all(|key| allowed.contains(&key.as_str())) {
        Ok(())
    } else {
        Err(invalid(id, "JSON-RPC message contains an unknown field"))
    }
}

fn request_id(object: &Map<String, Value>) -> Option<JsonRpcId> {
    object.get("id").and_then(json_rpc_id)
}

fn json_rpc_id(value: &Value) -> Option<JsonRpcId> {
    match value {
        Value::String(value) => Some(JsonRpcId::String(value.clone())),
        Value::Number(value) => Some(JsonRpcId::Number(value.clone())),
        _ => None,
    }
}

fn invalid(id: Option<JsonRpcId>, reason: &'static str) -> DecodeError {
    DecodeError::invalid(id, reason)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::protocol::wire::{INTERNAL_ERROR, JsonRpcMessage};

    #[test]
    fn request_notification_and_response_have_disjoint_shapes() {
        for frame in [
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "result": {},
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {},
                "method": "initialize",
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {},
                "params": {},
            }),
        ] {
            assert!(decode_message(frame).is_err());
        }
    }

    #[test]
    fn rejects_unknown_envelope_and_error_fields() {
        for frame in [
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "future": true,
            }),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "error": {
                    "code": INTERNAL_ERROR,
                    "message": "failed",
                    "future": true,
                },
            }),
        ] {
            assert!(decode_message(frame).is_err());
        }
    }

    #[test]
    fn preserves_opaque_results_and_discards_peer_error_payloads() {
        let message = decode_message(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": { "native": { "opaque": true } },
        }))
        .unwrap();
        assert!(matches!(
            message,
            JsonRpcMessage::Response(JsonRpcResponse::Success(_))
        ));

        let response = decode_response(json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {
                "code": INTERNAL_ERROR,
                "message": "peer-error-canary",
                "data": { "native": { "opaque": "data-canary" } },
            },
        }))
        .unwrap();
        let encoded = serde_json::to_string(&response).unwrap();

        assert!(matches!(response, JsonRpcResponse::Failure(_)));
        assert!(encoded.contains("app-server request rejected"));
        assert!(!encoded.contains("peer-error-canary"));
        assert!(!encoded.contains("data-canary"));
    }
}
