use serde_json::{Value, json};

use super::{GatewayResponse, RpcRequest, rpc_request};
use crate::driver::search::SearchError;

pub(crate) fn status_request(id: String) -> Result<RpcRequest, SearchError> {
    rpc_request(id, "webSearch/status", Some(json!({}))).map_err(|_| SearchError::Protocol)
}

pub(crate) fn invoke_request(id: String, args: Value) -> Result<RpcRequest, SearchError> {
    rpc_request(
        id,
        "tools.invoke",
        Some(json!({"name": "web_search", "args": args})),
    )
    .map_err(|_| SearchError::Protocol)
}

pub(crate) fn payload(response: GatewayResponse) -> Result<Value, SearchError> {
    match response {
        GatewayResponse::Success {
            payload: Some(value),
            ..
        } if value.is_object() => Ok(value),
        GatewayResponse::Failure { error, .. }
            if error.message().contains("unknown method")
                || error.message().contains("Unknown method") =>
        {
            Err(SearchError::Unsupported)
        }
        GatewayResponse::Failure { error, .. } if error.code() == "FORBIDDEN" => {
            Err(SearchError::PolicyDenied)
        }
        GatewayResponse::Failure { .. } => Err(SearchError::InvocationFailed),
        _ => Err(SearchError::Protocol),
    }
}
