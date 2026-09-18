use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    composition::PeerHandle,
    facade::{
        InstallationStatus, PlatformRuntimeError, PlatformRuntimeHandle, SubagentTemplate,
        SubagentTemplateCatalog, SubagentTemplateCategory, SubagentTemplateDetail,
        SubagentTemplateError, SubagentTemplateSummary, ToolPermissionEffect, ToolPermissionMode,
    },
};

use super::{
    COMMAND_FAILED_MESSAGE, CommandInput, CommandOutcome, CommandResult, INVALID_INPUT_MESSAGE,
    InvalidPayload, RejectionCode, decode, internal_error, invalid_input, unavailable,
};

pub(super) async fn matcha_status(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::matcha_status(peer).await
}

pub(super) async fn start_matcha(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::start_matcha(peer).await
}

pub(super) async fn stop_matcha(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::stop_matcha(peer).await
}

pub(super) async fn restart_matcha(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::restart_matcha(peer).await
}

pub(super) async fn status(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::status(peer).await
}

pub(super) async fn start(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::start(peer).await
}

pub(super) async fn stop(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::stop(peer).await
}

pub(super) async fn restart(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::restart(peer).await
}

pub(super) async fn logs(peer: &PeerHandle, input: CommandInput) -> CommandOutcome {
    super::super::lifecycle::logs(peer, input).await
}

pub(super) async fn control_ready(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::control_ready(peer).await
}

pub(super) async fn gateway_health(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::gateway_health(peer).await
}

pub(super) async fn gateway_status(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::gateway_status(peer).await
}

pub(super) async fn control_ui_url(peer: &PeerHandle) -> CommandOutcome {
    super::super::lifecycle::control_ui_url(peer).await
}

pub(super) async fn openclaw_environment_status(
    platform_runtime: &PlatformRuntimeHandle,
) -> CommandOutcome {
    match platform_runtime.installation_status().await {
        Ok(Some(status)) => CommandOutcome::succeeded(CommandResult::private(
            json!({ "result": installation_status_json(&status) }),
        )),
        Ok(None) | Err(_) => unavailable(),
    }
}

fn installation_status_json(status: &InstallationStatus) -> Value {
    let mut object = Map::new();
    object.insert("packageExists".into(), json!(status.package_exists));
    object.insert("isBuilt".into(), json!(status.is_built));
    object.insert("dir".into(), json!(&status.dir));
    if let Some(version) = status.version.as_ref() {
        object.insert("version".into(), json!(version));
    }
    Value::Object(object)
}

pub(super) async fn openclaw_runtime_paths(
    platform_runtime: &PlatformRuntimeHandle,
) -> CommandOutcome {
    match platform_runtime.runtime_paths_available().await {
        Ok(paths) => CommandOutcome::succeeded(CommandResult::private(json!({
            "openclawDirectory": paths.openclaw_directory,
            "configDirectory": paths.config_directory,
            "workspaceDirectory": paths.workspace_directory,
            "taskWorkspaceDirectories": paths.task_workspace_directories,
            "skillsDirectory": paths.skills_directory,
        }))),
        Err(_) => unavailable(),
    }
}

pub(super) async fn openclaw_cli_command(
    platform_runtime: &PlatformRuntimeHandle,
) -> CommandOutcome {
    match platform_runtime.cli_command_available().await {
        Ok(cli_command) => CommandOutcome::succeeded(CommandResult::private(
            json!({ "command": cli_command.command }),
        )),
        Err(_) => unavailable(),
    }
}

pub(super) async fn openclaw_tool_permission_get(
    platform_runtime: &PlatformRuntimeHandle,
) -> CommandOutcome {
    match platform_runtime.tool_permission_mode().await {
        Ok(mode) => CommandOutcome::succeeded(CommandResult::private(
            json!({ "result": { "mode": mode.as_str() } }),
        )),
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ToolPermissionModeRequest {
    pub(super) mode: ToolPermissionMode,
}

pub(super) async fn openclaw_tool_permission_set(
    platform_runtime: &PlatformRuntimeHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request = match decode::<ToolPermissionModeRequest>(input) {
        Ok(request) => request,
        Err(_) => return invalid_input(),
    };
    match platform_runtime
        .set_tool_permission_mode(request.mode)
        .await
    {
        Ok(ToolPermissionEffect::Unchanged) => CommandOutcome::succeeded(CommandResult::private(
            json!({ "result": { "mode": request.mode.as_str(), "changed": false } }),
        )),
        Ok(ToolPermissionEffect::Written) => CommandOutcome::succeeded(CommandResult::private(
            json!({ "result": { "mode": request.mode.as_str(), "changed": true } }),
        )),
        Err(PlatformRuntimeError::Unavailable) => unavailable(),
        Err(PlatformRuntimeError::Unknown) => internal_error(),
    }
}

pub(super) async fn subagent_template_catalog(
    platform_runtime: &PlatformRuntimeHandle,
) -> CommandOutcome {
    match platform_runtime.subagent_template_catalog().await {
        Ok(catalog) => CommandOutcome::succeeded(CommandResult::private(
            json!({ "result": subagent_template_catalog_json(&catalog) }),
        )),
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubagentTemplateRequest {
    id: String,
}

pub(super) async fn subagent_template(
    platform_runtime: &PlatformRuntimeHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request: SubagentTemplateRequest = match decode::<SubagentTemplateRequest>(input) {
        Ok(request) if !request.id.trim().is_empty() => request,
        Err(_) | Ok(_) => return invalid_input(),
    };
    match platform_runtime.subagent_template(&request.id).await {
        Ok(template) => CommandOutcome::succeeded(CommandResult::private(
            json!({ "result": subagent_template_detail_json(&template) }),
        )),
        Err(SubagentTemplateError::NotFound) => {
            CommandOutcome::rejected(RejectionCode::InvalidInput, INVALID_INPUT_MESSAGE)
        }
        Err(SubagentTemplateError::Unavailable) => unavailable(),
    }
}

fn subagent_template_catalog_json(catalog: &SubagentTemplateCatalog) -> Value {
    json!({
        "categories": catalog
            .categories
            .iter()
            .map(subagent_template_category_json)
            .collect::<Vec<_>>(),
        "templates": catalog
            .templates
            .iter()
            .map(subagent_template_summary_json)
            .collect::<Vec<_>>()
    })
}

fn subagent_template_category_json(category: &SubagentTemplateCategory) -> Value {
    let mut object = Map::new();
    object.insert("id".into(), json!(&category.id));
    if let Some(order) = category.order {
        object.insert("order".into(), json!(order));
    }
    Value::Object(object)
}

fn subagent_template_summary_json(summary: &SubagentTemplateSummary) -> Value {
    Value::Object(subagent_template_summary_object(summary))
}

fn subagent_template_summary_object(summary: &SubagentTemplateSummary) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert("id".into(), json!(&summary.id));
    object.insert("name".into(), json!(&summary.name));
    if let Some(summary_text) = summary.summary.as_ref() {
        object.insert("summary".into(), json!(summary_text));
    }
    if let Some(category_id) = summary.category_id.as_ref() {
        object.insert("categoryId".into(), json!(category_id));
    }
    if let Some(subcategory_id) = summary.subcategory_id.as_ref() {
        object.insert("subcategoryId".into(), json!(subcategory_id));
    }
    if let Some(order) = summary.order {
        object.insert("order".into(), json!(order));
    }
    object.insert("files".into(), json!(&summary.files));
    object
}

fn subagent_template_detail_json(detail: &SubagentTemplateDetail) -> Value {
    json!({ "template": subagent_template_json(&detail.template) })
}

fn subagent_template_json(template: &SubagentTemplate) -> Value {
    let mut object = subagent_template_summary_object(&template.summary);
    object.insert(
        "fileContents".into(),
        Value::Object(
            template
                .file_contents
                .iter()
                .map(|(file, content)| (file.clone(), json!(content)))
                .collect(),
        ),
    );
    Value::Object(object)
}

#[derive(Debug)]
pub(super) struct OpenClawBrowserRequest {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) query: Option<Value>,
    pub(super) body: Option<Value>,
    pub(super) timeout_ms: Option<u64>,
    pub(super) target: Option<String>,
    pub(super) node: Option<String>,
}

#[derive(Debug)]
pub(super) struct OpenClawMcpAppRequest {
    pub(super) operation_id: String,
    pub(super) session_key: String,
    pub(super) view_id: String,
    pub(super) standalone: Option<bool>,
}

pub(super) async fn openclaw_browser_request(
    peer: &PeerHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request = match decode_browser_request(input) {
        Ok(request) => request,
        Err(_) => return invalid_input(),
    };
    match peer
        .open_claw_browser_request(
            request.method,
            request.path,
            request.query,
            request.body,
            request.timeout_ms,
            request.target,
            request.node,
        )
        .await
    {
        Ok(outcome) => openclaw_gateway_request_outcome(outcome),
        Err(_) => unavailable(),
    }
}

pub(super) async fn openclaw_mcp_app_request(
    peer: &PeerHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request = match decode_mcp_app_request(input) {
        Ok(request) => request,
        Err(_) => return invalid_input(),
    };
    match peer
        .open_claw_mcp_app_request(
            request.operation_id,
            request.session_key,
            request.view_id,
            request.standalone,
        )
        .await
    {
        Ok(outcome) => openclaw_gateway_request_outcome(outcome),
        Err(_) => unavailable(),
    }
}

pub(super) fn openclaw_gateway_request_outcome(
    outcome: openclaw::port::OpenClawGatewayRequestOutcome,
) -> CommandOutcome {
    match outcome {
        openclaw::port::OpenClawGatewayRequestOutcome::Succeeded(payload) => {
            CommandOutcome::succeeded(CommandResult::private(payload))
        }
        openclaw::port::OpenClawGatewayRequestOutcome::Rejected => {
            CommandOutcome::rejected(RejectionCode::Failed, COMMAND_FAILED_MESSAGE)
        }
        openclaw::port::OpenClawGatewayRequestOutcome::Unavailable => unavailable(),
        openclaw::port::OpenClawGatewayRequestOutcome::CapacityExhausted => {
            CommandOutcome::rejected(
                RejectionCode::CapacityExhausted,
                "OpenClaw Gateway request capacity is exhausted.",
            )
        }
        openclaw::port::OpenClawGatewayRequestOutcome::OutcomeUnknown => {
            CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "unknown" })))
        }
    }
}

pub(super) fn decode_browser_request(
    input: CommandInput,
) -> Result<OpenClawBrowserRequest, InvalidPayload> {
    let input = input.into_value();
    let object = input.as_object().ok_or(InvalidPayload)?;
    if !object.keys().all(|key| {
        matches!(
            key.as_str(),
            "method" | "path" | "query" | "body" | "timeoutMs" | "target" | "node"
        )
    }) || !object.contains_key("method")
        || !object.contains_key("path")
    {
        return Err(InvalidPayload);
    }
    let query = object.get("query").cloned();
    if query.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(InvalidPayload);
    }
    let timeout_ms = match object.get("timeoutMs") {
        Some(value) => {
            let timeout_ms = value.as_u64().ok_or(InvalidPayload)?;
            if timeout_ms == 0 {
                return Err(InvalidPayload);
            }
            Some(timeout_ms)
        }
        None => None,
    };
    let target = match object.get("target") {
        Some(value) => {
            let target = bounded_gateway_text(Some(value))?;
            if target != "host" && target != "node" {
                return Err(InvalidPayload);
            }
            Some(target)
        }
        None => None,
    };
    let node = match object.get("node") {
        Some(value) if target.as_deref() == Some("node") => {
            Some(bounded_gateway_text(Some(value))?)
        }
        Some(_) => return Err(InvalidPayload),
        None => None,
    };
    Ok(OpenClawBrowserRequest {
        method: bounded_gateway_text(object.get("method"))?,
        path: bounded_gateway_text(object.get("path"))?,
        query,
        body: object.get("body").cloned(),
        timeout_ms,
        target,
        node,
    })
}

pub(super) fn decode_mcp_app_request(
    input: CommandInput,
) -> Result<OpenClawMcpAppRequest, InvalidPayload> {
    let input = input.into_value();
    let object = input.as_object().ok_or(InvalidPayload)?;
    if !object.keys().all(|key| {
        matches!(
            key.as_str(),
            "operationId" | "sessionKey" | "viewId" | "standalone"
        )
    }) || !object.contains_key("operationId")
        || !object.contains_key("sessionKey")
        || !object.contains_key("viewId")
    {
        return Err(InvalidPayload);
    }
    let operation_id = bounded_gateway_text(object.get("operationId"))?;
    if !operation_id.starts_with("mcp.app.") {
        return Err(InvalidPayload);
    }
    Ok(OpenClawMcpAppRequest {
        operation_id,
        session_key: bounded_gateway_text(object.get("sessionKey"))?,
        view_id: bounded_gateway_text(object.get("viewId"))?,
        standalone: match object.get("standalone") {
            Some(value) => Some(value.as_bool().ok_or(InvalidPayload)?),
            None => None,
        },
    })
}

fn bounded_gateway_text(value: Option<&Value>) -> Result<String, InvalidPayload> {
    let value = value.and_then(Value::as_str).ok_or(InvalidPayload)?;
    if value.trim().is_empty() || value.len() > 4_096 || value.chars().any(char::is_control) {
        return Err(InvalidPayload);
    }
    Ok(value.to_owned())
}
