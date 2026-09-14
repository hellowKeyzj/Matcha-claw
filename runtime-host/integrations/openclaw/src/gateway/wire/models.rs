use serde::Deserialize;
use serde_json::json;

use super::{GatewayResponse, RpcRequest, WireError, rpc_request};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub provider: String,
    pub context_window: Option<u64>,
    #[serde(default)]
    pub input: Vec<String>,
    pub available: Option<bool>,
}

pub(crate) fn list_request(request_id: String) -> Result<RpcRequest, WireError> {
    rpc_request(
        request_id,
        "models.list",
        Some(json!({
            "view": "all", "refresh": true
        })),
    )
}

pub(crate) fn auth_status_refresh_request(request_id: String) -> Result<RpcRequest, WireError> {
    rpc_request(
        request_id,
        "models.authStatus",
        Some(json!({ "refresh": true })),
    )
}

pub(crate) fn decode_list(response: GatewayResponse) -> Option<Vec<Model>> {
    #[derive(Deserialize)]
    struct Catalog {
        models: Vec<Model>,
    }
    let GatewayResponse::Success {
        payload: Some(payload),
        ..
    } = response
    else {
        return None;
    };
    serde_json::from_value::<Catalog>(payload)
        .ok()
        .map(|catalog| catalog.models)
}
