use crate::{rpc, session::Sessions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    session_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    name: String,
    value: String,
    display_name: String,
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    supports_effort: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    supported_effort_levels: Option<Vec<Effort>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    supports_adaptive_thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    supports_fast_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    supports_auto_mode: Option<bool>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

pub(super) async fn list(params: Value, sessions: &Sessions) -> rpc::Result {
    let input: List = rpc::params(params)?;
    uuid::Uuid::parse_str(&input.session_id)
        .map_err(|source| rpc::Error::invalid("sessionId must be a UUID").with_source(source))?;
    let snapshot = sessions.native_snapshot(&input.session_id).await?;
    let initialize = snapshot
        .get("initialize")
        .filter(|value| !value.is_null())
        .ok_or_else(|| {
            rpc::Error::unavailable(
                "models_not_initialized",
                "Model options require a Session that has already initialized its native CLI",
            )
            .with_data(json!({"sessionId": input.session_id, "initializationObserved": false}))
        })?;
    let models: Vec<Model> = serde_json::from_value(
        initialize
            .get("models")
            .cloned()
            .ok_or_else(native_models)?,
    )
    .map_err(|source| native_models().with_source(source))?;
    Ok(json!({
        "sessionId": input.session_id,
        "source": "nativeInitialize",
        "models": models,
        "discoveryPerformed": false,
        "availabilityVerified": false,
    }))
}

fn native_models() -> rpc::Error {
    rpc::Error::new(
        -32004,
        "native_models_response",
        "Native initialization did not contain the expected model option catalogue",
    )
}
