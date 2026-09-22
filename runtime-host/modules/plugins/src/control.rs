use serde::Deserialize;
use serde_json::{Value, json};

use crate::{ConfigurationOutcome, Operation, OperationOutcome, PluginsModule, projection};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetEnabledRequest {
    pub plugin_id: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationRequest {
    pub operation: Operation,
    pub plugin_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ControlOutcome {
    Succeeded(Value),
    Rejected(&'static str),
    Unknown(Value),
    Unavailable,
    InvalidInput,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidControlInput;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityExecuteRequest {
    id: String,
    operation_id: String,
    scope: Value,
    target: Value,
    input: Value,
    #[serde(rename = "traceId", default)]
    _trace_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginSetEnabledRequest {
    plugin_id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginOperationRequest {
    operation: String,
    plugin_id: String,
}

pub async fn capability_set_enabled(plugins: &PluginsModule, input: Value) -> ControlOutcome {
    let request = match decode_capability_set_enabled(input) {
        Ok(request) => request,
        Err(_) => return ControlOutcome::InvalidInput,
    };
    match plugins
        .set_enabled(request.plugin_id, request.enabled)
        .await
    {
        Ok(ConfigurationOutcome::Configured) => {
            ControlOutcome::Succeeded(projection::project_capability_configured())
        }
        Ok(ConfigurationOutcome::Rejected) => {
            ControlOutcome::Rejected("Plugin configuration was rejected.")
        }
        Ok(ConfigurationOutcome::Unknown) => {
            ControlOutcome::Unknown(projection::project_control_unknown_outcome())
        }
        Err(_) => ControlOutcome::Unavailable,
    }
}

pub async fn catalog(plugins: &PluginsModule) -> ControlOutcome {
    match plugins.catalog().await {
        Ok(Ok(catalog)) => ControlOutcome::Succeeded(projection::project_control_catalog(catalog)),
        Ok(Err(_)) | Err(_) => ControlOutcome::Unavailable,
    }
}

pub async fn runtime(plugins: &PluginsModule) -> ControlOutcome {
    match plugins.runtime().await {
        Ok(Ok(runtime)) => ControlOutcome::Succeeded(projection::project_control_runtime(runtime)),
        Ok(Err(_)) | Err(_) => ControlOutcome::Unavailable,
    }
}

pub async fn set_enabled(plugins: &PluginsModule, input: Value) -> ControlOutcome {
    let request = match decode_set_enabled(input) {
        Ok(request) => request,
        Err(_) => return ControlOutcome::InvalidInput,
    };
    match plugins
        .set_enabled(request.plugin_id, request.enabled)
        .await
    {
        Ok(ConfigurationOutcome::Configured) => {
            ControlOutcome::Succeeded(projection::project_control_configured_result())
        }
        Ok(ConfigurationOutcome::Rejected) => {
            ControlOutcome::Rejected("Plugin configuration was rejected.")
        }
        Ok(ConfigurationOutcome::Unknown) => {
            ControlOutcome::Rejected("Plugin configuration outcome is unknown.")
        }
        Err(_) => ControlOutcome::Unavailable,
    }
}

pub async fn operation(plugins: &PluginsModule, input: Value) -> ControlOutcome {
    let request = match decode_operation(input) {
        Ok(request) => request,
        Err(_) => return ControlOutcome::InvalidInput,
    };
    match plugins
        .operation(request.operation, request.plugin_id)
        .await
    {
        Ok(OperationOutcome::Configured) => {
            ControlOutcome::Succeeded(projection::project_control_configured_result())
        }
        Ok(OperationOutcome::Rejected) => {
            ControlOutcome::Rejected("Plugin operation was rejected.")
        }
        Ok(OperationOutcome::Unknown) => {
            ControlOutcome::Unknown(projection::project_control_unknown_outcome())
        }
        Err(_) => ControlOutcome::Unavailable,
    }
}

pub fn decode_capability_set_enabled(
    input: Value,
) -> Result<SetEnabledRequest, InvalidControlInput> {
    let request: CapabilityExecuteRequest = decode(input)?;
    if request.id != "plugin.runtime"
        || request.operation_id != "plugins.setEnabled"
        || !is_openclaw_runtime_scope(&request.scope)
        || !is_plugin_target(&request.target, &request.input)
    {
        return Err(InvalidControlInput);
    }
    let plugin_id = request
        .target
        .get("pluginId")
        .and_then(Value::as_str)
        .ok_or(InvalidControlInput)?;
    let enabled = request
        .input
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or(InvalidControlInput)?;
    Ok(SetEnabledRequest {
        plugin_id: plugin_id.to_owned(),
        enabled,
    })
}

pub fn decode_set_enabled(input: Value) -> Result<SetEnabledRequest, InvalidControlInput> {
    let request: PluginSetEnabledRequest = decode(input)?;
    if request.plugin_id.trim().is_empty() {
        return Err(InvalidControlInput);
    }
    Ok(SetEnabledRequest {
        plugin_id: request.plugin_id,
        enabled: request.enabled,
    })
}

pub fn decode_operation(input: Value) -> Result<OperationRequest, InvalidControlInput> {
    let request: PluginOperationRequest = decode(input)?;
    if request.plugin_id.trim().is_empty() {
        return Err(InvalidControlInput);
    }
    Ok(OperationRequest {
        operation: Operation::from_wire(&request.operation).ok_or(InvalidControlInput)?,
        plugin_id: request.plugin_id,
    })
}

pub fn is_plugin_target(target: &Value, input: &Value) -> bool {
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

fn decode<T: for<'de> Deserialize<'de>>(input: Value) -> Result<T, InvalidControlInput> {
    serde_json::from_value(input).map_err(|_| InvalidControlInput)
}

fn is_openclaw_runtime_scope(value: &Value) -> bool {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    value
        == &json!({
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": identity.runtime_adapter_id(),
                "runtimeInstanceId": identity.runtime_instance_id(),
            },
        })
}
