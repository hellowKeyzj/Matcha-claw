use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{owner::Handle, transport::authorization::CapabilityDecisionVerifier};

pub(crate) const CATALOG_ENDPOINT: &str = "/api/plugins/catalog";
pub(crate) const RUNTIME_ENDPOINT: &str = "/api/plugins/runtime";
pub(crate) const CONFIGURATION_ENDPOINT: &str = "/api/plugins/configuration";
pub(crate) const OPERATION_ENDPOINT: &str = "/api/plugins/operation";

const BEARER_PREFIX: &str = "Bearer ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestError {
    Invalid,
    Unauthorized,
}

pub(crate) async fn catalog(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: Handle,
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
    owner
        .plugins_catalog()
        .await
        .map_err(|_| RequestError::Invalid)?
        .map(project_catalog)
        .map_err(|_| RequestError::Invalid)
}

pub(crate) async fn runtime(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: Handle,
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
    owner
        .plugins_runtime()
        .await
        .map_err(|_| RequestError::Invalid)?
        .map(project_runtime)
        .map_err(|_| RequestError::Invalid)
}

fn project_catalog(catalog: crate::plugin::Catalog) -> Value {
    json!({
        "success": catalog.success,
        "execution": catalog.execution,
        "plugins": catalog.plugins,
    })
}

fn project_runtime(runtime: crate::plugin::Runtime) -> Value {
    let enabled_plugin_ids = runtime.execution.enabled_plugin_ids;
    let active_plugin_count = runtime
        .plugins
        .iter()
        .filter(|plugin| {
            plugin.status == "running" && enabled_plugin_ids.iter().any(|id| id == &plugin.id)
        })
        .count();
    json!({
        "success": runtime.success,
        "state": {
            "lifecycle": "running",
            "runtimeLifecycle": "running",
            "activePluginCount": active_plugin_count,
            "enabledPluginIds": enabled_plugin_ids,
        },
        "health": {
            "ok": true,
            "lifecycle": "running",
            "activePluginCount": active_plugin_count,
            "degradedPlugins": [],
        },
        "execution": {
            "enabledPluginIds": enabled_plugin_ids,
        },
    })
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

pub(crate) async fn operation(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: Handle,
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
    let operation = match request.operation.as_str() {
        "install" => crate::plugin::Operation::Install,
        "update" => crate::plugin::Operation::Update,
        "uninstall" => crate::plugin::Operation::Uninstall,
        _ => return Err(RequestError::Invalid),
    };
    let outcome = owner
        .plugins_operation(operation, request.plugin_id)
        .await
        .map_err(|_| RequestError::Invalid)?;
    Ok(json!({ "outcome": match outcome {
        crate::plugin::OperationOutcome::Configured => "configured",
        crate::plugin::OperationOutcome::Rejected => "rejected",
        crate::plugin::OperationOutcome::Unknown => "unknown",
    }}))
}

pub(crate) async fn configuration(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: Handle,
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
    let outcome = owner
        .plugins_set_enabled(request.plugin_id, request.enabled)
        .await
        .map_err(|_| RequestError::Invalid)?;
    Ok(json!({ "outcome": match outcome {
        crate::plugin::ConfigurationOutcome::Configured => "configured",
        crate::plugin::ConfigurationOutcome::Rejected => "rejected",
        crate::plugin::ConfigurationOutcome::Unknown => "unknown",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_projection_keeps_child_lifecycle_running_when_peer_plugins_are_stopped() {
        let body = project_runtime(crate::plugin::Runtime {
            success: true,
            lifecycle: "stopped",
            state: "stopped",
            health: "stopped",
            execution: crate::plugin::Execution {
                enabled_plugin_ids: vec!["browser-relay".into()],
            },
            plugins: vec![crate::plugin::RuntimeEntry {
                id: "browser-relay".into(),
                status: "stopped",
            }],
        });

        assert_eq!(body["state"]["lifecycle"], "running");
        assert_eq!(body["state"]["runtimeLifecycle"], "running");
        assert_eq!(body["health"]["ok"], true);
        assert_eq!(body["health"]["lifecycle"], "running");
        assert_eq!(body["health"].get("error"), None);
        assert_eq!(body["state"]["activePluginCount"], 0);
    }
}
