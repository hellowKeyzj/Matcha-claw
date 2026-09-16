use serde::Deserialize;
use serde_json::{Value, json};

use crate::facade::PluginsHandle;

use super::{
    CapabilityExecuteRequest, CommandInput, CommandOutcome, CommandResult, RejectionCode, decode,
    invalid_input, is_native_runtime_scope, unavailable,
};

pub(super) async fn openclaw_plugins_execute(
    plugins: &PluginsHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request = match decode::<CapabilityExecuteRequest>(input) {
        Ok(request) if request.id == "plugin.runtime" => request,
        _ => return invalid_input(),
    };
    if !is_native_runtime_scope(&request.scope)
        || request.operation_id != "plugins.setEnabled"
        || !is_plugin_target(&request.target, &request.input)
    {
        return invalid_input();
    }
    let Some(plugin_id) = request.target.get("pluginId").and_then(Value::as_str) else {
        return invalid_input();
    };
    let Some(enabled) = request.input.get("enabled").and_then(Value::as_bool) else {
        return invalid_input();
    };
    match plugins.set_enabled(plugin_id.to_owned(), enabled).await {
        Ok(crate::plugins::ConfigurationOutcome::Configured) => CommandOutcome::succeeded(
            CommandResult::private(json!({ "success": true, "outcome": "configured" })),
        ),
        Ok(crate::plugins::ConfigurationOutcome::Rejected) => {
            CommandOutcome::rejected(RejectionCode::Failed, "Plugin configuration was rejected.")
        }
        Ok(crate::plugins::ConfigurationOutcome::Unknown) => {
            CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "unknown" })))
        }
        Err(_) => unavailable(),
    }
}

pub(super) fn is_plugin_target(target: &Value, input: &Value) -> bool {
    let Some(plugin_id) = target.get("pluginId").and_then(Value::as_str) else {
        return false;
    };
    !plugin_id.trim().is_empty()
        && target
            .as_object()
            .is_some_and(|object| object.len() == 2 && object.get("kind") == Some(&json!("plugin")))
        && input.get("enabled").and_then(Value::as_bool).is_some()
        && input
            .get("pluginIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.len() == 1 && ids[0].as_str() == Some(plugin_id))
        && input.as_object().is_some_and(|object| object.len() == 2)
}

pub(super) async fn plugins_catalog(plugins: &PluginsHandle) -> CommandOutcome {
    match plugins.catalog().await {
        Ok(Ok(catalog)) => CommandOutcome::succeeded(CommandResult::private(
            json!({ "result": crate::transport::skills::plugins::project_catalog(catalog) }),
        )),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

pub(super) async fn plugins_runtime(plugins: &PluginsHandle) -> CommandOutcome {
    match plugins.runtime().await {
        Ok(Ok(runtime)) => CommandOutcome::succeeded(CommandResult::private(
            json!({ "result": crate::transport::skills::plugins::project_runtime(runtime) }),
        )),
        Ok(Err(_)) | Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginSetEnabledRequest {
    plugin_id: String,
    enabled: bool,
}

pub(super) async fn plugins_set_enabled(
    plugins: &PluginsHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request: PluginSetEnabledRequest = match decode::<PluginSetEnabledRequest>(input) {
        Ok(request) if !request.plugin_id.trim().is_empty() => request,
        Err(_) | Ok(_) => return invalid_input(),
    };
    match plugins
        .set_enabled(request.plugin_id, request.enabled)
        .await
    {
        Ok(crate::plugins::ConfigurationOutcome::Configured) => CommandOutcome::succeeded(
            CommandResult::private(json!({ "result": { "outcome": "configured" } })),
        ),
        Ok(crate::plugins::ConfigurationOutcome::Rejected) => {
            CommandOutcome::rejected(RejectionCode::Failed, "Plugin configuration was rejected.")
        }
        Ok(crate::plugins::ConfigurationOutcome::Unknown) => CommandOutcome::rejected(
            RejectionCode::Failed,
            "Plugin configuration outcome is unknown.",
        ),
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginOperationRequest {
    operation: String,
    plugin_id: String,
}

pub(super) async fn plugins_operation(
    plugins: &PluginsHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request: PluginOperationRequest = match decode::<PluginOperationRequest>(input) {
        Ok(request) if !request.plugin_id.trim().is_empty() => request,
        Err(_) | Ok(_) => return invalid_input(),
    };
    let operation = match request.operation.as_str() {
        "install" => crate::plugins::Operation::Install,
        "update" => crate::plugins::Operation::Update,
        "uninstall" => crate::plugins::Operation::Uninstall,
        _ => return invalid_input(),
    };
    match plugins.operation(operation, request.plugin_id).await {
        Ok(crate::plugins::OperationOutcome::Configured) => CommandOutcome::succeeded(
            CommandResult::private(json!({ "result": { "outcome": "configured" } })),
        ),
        Ok(crate::plugins::OperationOutcome::Rejected) => {
            CommandOutcome::rejected(RejectionCode::Failed, "Plugin operation was rejected.")
        }
        Ok(crate::plugins::OperationOutcome::Unknown) => {
            CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "unknown" })))
        }
        Err(_) => unavailable(),
    }
}
