use std::sync::Arc;

use platform::{capability::CapabilityDecisionVerifier, loopback::Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{ConfigurationOutcome, Operation, OperationOutcome, PluginsModule, projection};

pub(super) const CATALOG_ENDPOINT: &str = "/api/plugins/catalog";
pub(super) const RUNTIME_ENDPOINT: &str = "/api/plugins/runtime";
pub(super) const CONFIGURATION_ENDPOINT: &str = "/api/plugins/configuration";
pub(super) const OPERATION_ENDPOINT: &str = "/api/plugins/operation";

const BEARER_PREFIX: &str = "Bearer ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

pub(super) async fn catalog(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsModule,
) -> Response {
    match catalog_request(
        &request.head.headers,
        verifier,
        plugins,
        super::now_millis(),
    )
    .await
    {
        Ok(body) => Response::json(200, body),
        Err(RequestError::Invalid) => Response::json(
            503,
            json!({ "success": false, "error": "Plugin catalog is unavailable" }),
        ),
        Err(RequestError::Unauthorized) => Response::json(
            401,
            json!({ "success": false, "error": "Plugin authorization is invalid" }),
        ),
    }
}

pub(super) async fn runtime(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsModule,
) -> Response {
    match runtime_request(
        &request.head.headers,
        verifier,
        plugins,
        super::now_millis(),
    )
    .await
    {
        Ok(body) => Response::json(200, body),
        Err(RequestError::Invalid) => Response::json(
            503,
            json!({ "success": false, "error": "Plugin runtime is unavailable" }),
        ),
        Err(RequestError::Unauthorized) => Response::json(
            401,
            json!({ "success": false, "error": "Plugin authorization is invalid" }),
        ),
    }
}

pub(super) async fn operation(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsModule,
) -> Response {
    match operation_request(
        &request.head.headers,
        &request.body,
        verifier,
        plugins,
        super::now_millis(),
    )
    .await
    {
        Ok(body) => Response::json(200, body),
        Err(RequestError::Invalid) => Response::json(
            400,
            json!({ "success": false, "error": "Plugin operation request is invalid" }),
        ),
        Err(RequestError::Unauthorized) => Response::json(
            401,
            json!({ "success": false, "error": "Plugin authorization is invalid" }),
        ),
    }
}

pub(super) async fn configuration(
    request: platform::loopback::Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsModule,
) -> Response {
    match configuration_request(
        &request.head.headers,
        &request.body,
        verifier,
        plugins,
        super::now_millis(),
    )
    .await
    {
        Ok(body) => Response::json(200, body),
        Err(RequestError::Invalid) => Response::json(
            400,
            json!({ "success": false, "error": "Plugin configuration request is invalid" }),
        ),
        Err(RequestError::Unauthorized) => Response::json(
            401,
            json!({ "success": false, "error": "Plugin authorization is invalid" }),
        ),
    }
}

pub async fn catalog_request(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsModule,
    now: u64,
) -> Result<Value, RequestError> {
    verify(
        headers,
        verifier,
        now,
        CATALOG_ENDPOINT,
        "plugins:read",
        "plugins.catalog.read",
        "plugin-catalog",
    )
    .await?;
    plugins
        .catalog()
        .await
        .map_err(|_| RequestError::Invalid)?
        .map(projection::project_catalog)
        .map_err(|_| RequestError::Invalid)
}

pub async fn runtime_request(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsModule,
    now: u64,
) -> Result<Value, RequestError> {
    verify(
        headers,
        verifier,
        now,
        RUNTIME_ENDPOINT,
        "plugins:read",
        "plugins.runtime.read",
        "plugin-runtime",
    )
    .await?;
    plugins
        .runtime()
        .await
        .map_err(|_| RequestError::Invalid)?
        .map(projection::project_runtime)
        .map_err(|_| RequestError::Invalid)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigurationRequest {
    runtime: String,
    plugin_id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationRequest {
    runtime: String,
    operation: String,
    plugin_id: String,
}

pub async fn operation_request(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsModule,
    now: u64,
) -> Result<Value, RequestError> {
    verify(
        headers,
        verifier,
        now,
        OPERATION_ENDPOINT,
        "plugins:write",
        "plugins:operation",
        "plugin-operation",
    )
    .await?;
    let request: OperationRequest =
        serde_json::from_slice(body).map_err(|_| RequestError::Invalid)?;
    if request.runtime != "openclaw" || request.plugin_id.trim().is_empty() {
        return Err(RequestError::Invalid);
    }
    let operation = Operation::from_wire(&request.operation).ok_or(RequestError::Invalid)?;
    let outcome = plugins
        .operation(operation, request.plugin_id)
        .await
        .map_err(|_| RequestError::Invalid)?;
    Ok(json!({ "outcome": match outcome {
        OperationOutcome::Configured => "configured",
        OperationOutcome::Rejected => "rejected",
        OperationOutcome::Unknown => "unknown",
    }}))
}

pub async fn configuration_request(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    plugins: PluginsModule,
    now: u64,
) -> Result<Value, RequestError> {
    verify(
        headers,
        verifier,
        now,
        CONFIGURATION_ENDPOINT,
        "plugins:write",
        "plugins.configuration",
        "plugin-configuration",
    )
    .await?;
    let request: ConfigurationRequest =
        serde_json::from_slice(body).map_err(|_| RequestError::Invalid)?;
    if request.runtime != "openclaw" || request.plugin_id.trim().is_empty() {
        return Err(RequestError::Invalid);
    }
    let outcome = plugins
        .set_enabled(request.plugin_id, request.enabled)
        .await
        .map_err(|_| RequestError::Invalid)?;
    Ok(json!({ "outcome": match outcome {
        ConfigurationOutcome::Configured => "configured",
        ConfigurationOutcome::Rejected => "rejected",
        ConfigurationOutcome::Unknown => "unknown",
    }}))
}

async fn verify(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    now: u64,
    endpoint: &str,
    scope: &str,
    capability: &str,
    subject: &str,
) -> Result<(), RequestError> {
    let token = headers
        .iter()
        .find(|(name, _)| name == "authorization")
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
        .ok_or(RequestError::Unauthorized)?;
    verifier
        .lock()
        .await
        .verify(token, now, endpoint, scope, capability, subject)
        .map(|_| ())
        .map_err(|_| RequestError::Unauthorized)
}
