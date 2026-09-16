use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{facade::PluginsHandle, transport::common::authorization::CapabilityDecisionVerifier};

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
    handle: PluginsHandle,
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
    handle
        .catalog()
        .await
        .map_err(|_| RequestError::Invalid)?
        .map(project_catalog)
        .map_err(|_| RequestError::Invalid)
}

pub(crate) async fn runtime(
    headers: &[(String, String)],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: PluginsHandle,
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
    handle
        .runtime()
        .await
        .map_err(|_| RequestError::Invalid)?
        .map(project_runtime)
        .map_err(|_| RequestError::Invalid)
}

pub(crate) fn project_catalog(catalog: crate::plugins::Catalog) -> Value {
    json!({
        "success": catalog.success,
        "execution": project_execution(catalog.execution),
        "plugins": catalog.plugins.into_iter().map(project_catalog_entry).collect::<Vec<_>>(),
    })
}

pub(crate) fn project_runtime(runtime: crate::plugins::Runtime) -> Value {
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

fn project_execution(execution: crate::plugins::Execution) -> Value {
    json!({ "enabledPluginIds": execution.enabled_plugin_ids })
}

fn project_catalog_entry(entry: crate::plugins::CatalogEntry) -> Value {
    let mut value = json!({
        "runtime": entry.runtime,
        "id": entry.id,
        "name": entry.name,
        "version": entry.version,
        "kind": entry.kind,
        "platform": entry.platform,
        "enabled": entry.enabled,
        "installed": entry.installed,
        "updateAvailable": entry.update_available,
        "companionSkillReady": entry.companion_skill_ready,
    });
    if let Some(description) = entry.description {
        value["description"] = json!(description);
    }
    if let Some(companion_skill_slugs) = entry.companion_skill_slugs {
        value["companionSkillSlugs"] = json!(companion_skill_slugs);
    }
    value
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
    handle: PluginsHandle,
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
        "install" => crate::plugins::Operation::Install,
        "update" => crate::plugins::Operation::Update,
        "uninstall" => crate::plugins::Operation::Uninstall,
        _ => return Err(RequestError::Invalid),
    };
    let outcome = handle
        .operation(operation, request.plugin_id)
        .await
        .map_err(|_| RequestError::Invalid)?;
    Ok(json!({ "outcome": match outcome {
        crate::plugins::OperationOutcome::Configured => "configured",
        crate::plugins::OperationOutcome::Rejected => "rejected",
        crate::plugins::OperationOutcome::Unknown => "unknown",
    }}))
}

pub(crate) async fn configuration(
    headers: &[(String, String)],
    body: &[u8],
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    handle: PluginsHandle,
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
    let outcome = handle
        .set_enabled(request.plugin_id, request.enabled)
        .await
        .map_err(|_| RequestError::Invalid)?;
    Ok(json!({ "outcome": match outcome {
        crate::plugins::ConfigurationOutcome::Configured => "configured",
        crate::plugins::ConfigurationOutcome::Rejected => "rejected",
        crate::plugins::ConfigurationOutcome::Unknown => "unknown",
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
        let body = project_runtime(crate::plugins::Runtime {
            success: true,
            lifecycle: "stopped",
            state: "stopped",
            health: "stopped",
            execution: crate::plugins::Execution {
                enabled_plugin_ids: vec!["browser-relay".into()],
            },
            plugins: vec![crate::plugins::RuntimeEntry {
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
