use serde_json::{Value, json};

use crate::{
    capability_directory,
    composition::PeerHandle,
    control::{CommandInput, CommandOutcome},
    facade::{PlatformRuntimeHandle, PluginsHandle, SkillsHandle, ToolchainHandle},
    owner,
    sessions::SessionHandle,
};

use super::wire::{DispatchRequest, DispatchResponse, DispatchSuccess, VERSION};

pub(crate) async fn execute(
    owner: &owner::Handle,
    peer: &PeerHandle,
    platform_runtime: &PlatformRuntimeHandle,
    toolchain: &ToolchainHandle,
    plugins: &PluginsHandle,
    skills: &SkillsHandle,
    _session: &SessionHandle,
    request: DispatchRequest,
) -> DispatchResponse {
    if request.version != VERSION
        || !matches!(request.method.as_str(), "GET" | "POST" | "PUT" | "DELETE")
        || !request.route.starts_with('/')
    {
        return DispatchResponse::bad_request("Dispatch envelope is invalid");
    }

    match dispatch_route(
        owner,
        peer,
        platform_runtime,
        toolchain,
        plugins,
        skills,
        &request.method,
        &request.route,
        request.payload,
    )
    .await
    {
        Ok(Some(data)) => DispatchResponse::Success(DispatchSuccess {
            version: VERSION,
            success: true,
            status: 200,
            data,
        }),
        Ok(None) => DispatchResponse::not_found(&request.method, &request.route),
        Err(response) => response,
    }
}

async fn dispatch_route(
    owner: &owner::Handle,
    peer: &PeerHandle,
    platform_runtime: &PlatformRuntimeHandle,
    toolchain: &ToolchainHandle,
    plugins: &PluginsHandle,
    skills: &SkillsHandle,
    method: &str,
    route: &str,
    payload: Option<Value>,
) -> Result<Option<Value>, DispatchResponse> {
    match (method, route_without_query(route)) {
        ("GET", "/api/runtime-host/health") => dispatch_host_health(owner).await,
        ("GET", "/api/capabilities/list") => command_outcome(capability_directory::list()),
        ("POST", "/api/capabilities/describe") => dispatch_capability_describe(payload),
        ("POST", "/api/capabilities/execute") => Ok(None),
        ("GET", "/api/openclaw/status") => dispatch_openclaw_status(peer).await,
        ("GET", "/api/openclaw/ready") => dispatch_openclaw_ready(peer).await,
        ("GET", "/api/openclaw/dir") => {
            dispatch_openclaw_path(platform_runtime, OpenClawPathKind::Directory).await
        }
        ("GET", "/api/openclaw/config-dir") => {
            dispatch_openclaw_path(platform_runtime, OpenClawPathKind::ConfigDirectory).await
        }
        ("GET", "/api/openclaw/workspace-dir") => {
            dispatch_openclaw_path(platform_runtime, OpenClawPathKind::WorkspaceDirectory).await
        }
        ("GET", "/api/openclaw/task-workspace-dirs") => {
            dispatch_openclaw_path(platform_runtime, OpenClawPathKind::TaskWorkspaceDirectories)
                .await
        }
        ("GET", "/api/openclaw/skills-dir") => {
            dispatch_openclaw_path(platform_runtime, OpenClawPathKind::SkillsDirectory).await
        }
        ("GET", "/api/openclaw/cli-command") => {
            dispatch_openclaw_cli_command(platform_runtime).await
        }
        ("GET", "/api/openclaw/tool-permission-mode") => {
            dispatch_openclaw_tool_permission_mode(platform_runtime).await
        }
        ("PUT", "/api/openclaw/tool-permission-mode") => {
            dispatch_set_openclaw_tool_permission_mode(platform_runtime, payload).await
        }
        ("GET", "/api/openclaw/subagent-templates") => {
            dispatch_subagent_template_catalog(platform_runtime).await
        }
        ("GET", path) if path.starts_with("/api/openclaw/subagent-templates/") => {
            dispatch_subagent_template(platform_runtime, path).await
        }
        ("GET", "/api/toolchain/uv/check") => dispatch_toolchain_uv_check(toolchain).await,
        ("GET", "/api/plugins/runtime") => dispatch_plugins_runtime(plugins).await,
        ("GET", "/api/plugins/catalog") => dispatch_plugins_catalog(plugins).await,
        ("GET", "/api/skills/status") => dispatch_skill_status(skills).await,
        ("GET", "/api/skills/effective") => dispatch_skill_status(skills).await,
        ("POST", "/api/runtime-connectors/connect")
        | ("POST", "/api/runtime-connectors/disconnect") => {
            Err(legacy_rejection(LEGACY_RUNTIME_CONNECTOR_ROUTE_REJECTION))
        }
        ("POST", "/api/gateway/ready") | ("POST", "/api/gateway/control-ui/auto-approve") => {
            Err(legacy_rejection(LEGACY_GATEWAY_CONTROL_ROUTE_REJECTION))
        }
        ("POST", "/api/sessions/window") | ("POST", "/api/sessions/state") => {
            Err(legacy_rejection(LEGACY_HYDRATING_SESSION_ROUTE_REJECTION))
        }
        ("POST", path) if LEGACY_SESSION_ROUTES.contains(&path) => {
            Err(legacy_rejection(LEGACY_SESSION_ROUTE_REJECTION))
        }
        ("POST", path) if LEGACY_FILE_ROUTES.contains(&path) => {
            Err(legacy_rejection(LEGACY_FILE_ROUTE_REJECTION))
        }
        ("POST", "/api/subagents/list") | ("POST", "/api/subagents/config/get") => {
            Err(legacy_rejection(LEGACY_SUBAGENT_READ_ROUTE_REJECTION))
        }
        ("POST", "/api/subagents/files/get") | ("POST", "/api/subagents/files/list") => {
            Err(legacy_rejection(LEGACY_SUBAGENT_FILE_ROUTE_REJECTION))
        }
        _ => Ok(None),
    }
}

async fn dispatch_host_health(owner: &owner::Handle) -> Result<Option<Value>, DispatchResponse> {
    let state = owner.state();
    Ok(Some(json!({
        "success": true,
        "state": state,
    })))
}

fn dispatch_capability_describe(payload: Option<Value>) -> Result<Option<Value>, DispatchResponse> {
    let Some(Value::Object(payload)) = payload else {
        return Err(DispatchResponse::bad_request(
            "Capability payload is invalid",
        ));
    };
    command_outcome(capability_directory::describe(CommandInput(Value::Object(
        payload,
    ))))
}

async fn dispatch_openclaw_status(peer: &PeerHandle) -> Result<Option<Value>, DispatchResponse> {
    let state = peer
        .open_claw_status()
        .await
        .map_err(|_| DispatchResponse::internal_error())?;
    serde_json::to_value(state.projection())
        .map(Some)
        .map_err(|_| DispatchResponse::internal_error())
}

async fn dispatch_openclaw_ready(peer: &PeerHandle) -> Result<Option<Value>, DispatchResponse> {
    let state = peer
        .open_claw_status()
        .await
        .map_err(|_| DispatchResponse::internal_error())?;
    let projection = state.projection();
    Ok(Some(json!({
        "ready": matches!(state.lifecycle(), crate::RuntimeLifecycle::Running),
        "state": projection,
    })))
}

enum OpenClawPathKind {
    Directory,
    ConfigDirectory,
    WorkspaceDirectory,
    TaskWorkspaceDirectories,
    SkillsDirectory,
}

async fn dispatch_openclaw_path(
    platform_runtime: &PlatformRuntimeHandle,
    kind: OpenClawPathKind,
) -> Result<Option<Value>, DispatchResponse> {
    let paths = platform_runtime
        .runtime_paths()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    let value = match kind {
        OpenClawPathKind::Directory => json!(paths.openclaw_directory()),
        OpenClawPathKind::ConfigDirectory => json!(paths.config_directory()),
        OpenClawPathKind::WorkspaceDirectory => json!(paths.workspace_directory()),
        OpenClawPathKind::TaskWorkspaceDirectories => json!(paths.task_workspace_directories()),
        OpenClawPathKind::SkillsDirectory => json!(paths.skills_directory()),
    };
    Ok(Some(value))
}

async fn dispatch_openclaw_cli_command(
    platform_runtime: &PlatformRuntimeHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let command = platform_runtime
        .cli_command()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({ "command": command.command() })))
}

async fn dispatch_openclaw_tool_permission_mode(
    platform_runtime: &PlatformRuntimeHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let mode = platform_runtime
        .tool_permission_mode()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({ "mode": mode })))
}

async fn dispatch_set_openclaw_tool_permission_mode(
    platform_runtime: &PlatformRuntimeHandle,
    payload: Option<Value>,
) -> Result<Option<Value>, DispatchResponse> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        mode: openclaw::projection::tool_permission::Mode,
    }

    let Some(payload) = payload else {
        return Err(DispatchResponse::bad_request(
            "permission mode must be \"default\" or \"fullAccess\"",
        ));
    };
    let request = serde_json::from_value::<Request>(payload).map_err(|_| {
        DispatchResponse::bad_request("permission mode must be \"default\" or \"fullAccess\"")
    })?;
    let effect = platform_runtime
        .set_tool_permission_mode(request.mode)
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(
        json!({ "mode": request.mode, "changed": matches!(effect, openclaw::projection::tool_permission::Effect::Written) }),
    ))
}

async fn dispatch_subagent_template_catalog(
    platform_runtime: &PlatformRuntimeHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let catalog = platform_runtime
        .subagent_template_catalog()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    serde_json::to_value(catalog)
        .map(Some)
        .map_err(|_| DispatchResponse::internal_error())
}

async fn dispatch_subagent_template(
    platform_runtime: &PlatformRuntimeHandle,
    path: &str,
) -> Result<Option<Value>, DispatchResponse> {
    let id = path
        .strip_prefix("/api/openclaw/subagent-templates/")
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| DispatchResponse::bad_request("Subagent template id is required"))?;
    let id = percent_decode_path_segment(id);
    let template = platform_runtime
        .subagent_template(&id)
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::not_found("GET", path))?;
    serde_json::to_value(template)
        .map(Some)
        .map_err(|_| DispatchResponse::internal_error())
}

async fn dispatch_toolchain_uv_check(
    toolchain: &ToolchainHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let status = toolchain
        .status()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!(matches!(
        status.uv(),
        toolchain::ToolAvailability::Available
    ))))
}

async fn dispatch_plugins_runtime(
    plugins: &PluginsHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let runtime = plugins
        .runtime()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({ "result": runtime })))
}

async fn dispatch_plugins_catalog(
    plugins: &PluginsHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let catalog = plugins
        .catalog()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({ "result": catalog })))
}

async fn dispatch_skill_status(skills: &SkillsHandle) -> Result<Option<Value>, DispatchResponse> {
    match skills
        .skill_status()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
    {
        crate::skill_status::Outcome::Available(catalog) => {
            Ok(Some(crate::skill_status::project(&catalog)))
        }
        crate::skill_status::Outcome::Unavailable => Err(DispatchResponse::internal_error()),
    }
}

fn percent_decode_path_segment(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                output.push(char::from(hex));
                index += 3;
                continue;
            }
        }
        output.push(char::from(bytes[index]));
        index += 1;
    }
    output
}

const LEGACY_RUNTIME_CONNECTOR_ROUTE_REJECTION: &str = "Legacy runtime connector lifecycle route is disabled; use /api/capabilities/execute with a runtime-endpoint target";
const LEGACY_GATEWAY_CONTROL_ROUTE_REJECTION: &str = "Legacy gateway control route is disabled; use /api/capabilities/execute with a gateway-control target";
const LEGACY_SESSION_ROUTE_REJECTION: &str =
    "Legacy session route is disabled; use /api/capabilities/execute with a capability target";
const LEGACY_HYDRATING_SESSION_ROUTE_REJECTION: &str = "Legacy session route may hydrate session state; use /api/capabilities/execute with a session target";
const LEGACY_FILE_ROUTE_REJECTION: &str =
    "Legacy file route is disabled; use /api/capabilities/execute with a workspace-file target";
const LEGACY_SUBAGENT_READ_ROUTE_REJECTION: &str =
    "Legacy subagent read route is disabled; use /api/capabilities/execute with an agent target";
const LEGACY_SUBAGENT_FILE_ROUTE_REJECTION: &str =
    "Legacy subagent file route is disabled; use /api/capabilities/execute with a subagent target";

const LEGACY_SESSION_ROUTES: &[&str] = &[
    "/api/sessions/create",
    "/api/sessions/load",
    "/api/sessions/prompt",
    "/api/sessions/patch",
    "/api/sessions/rename",
    "/api/sessions/delete",
    "/api/sessions/archive",
    "/api/sessions/unarchive",
    "/api/sessions/status",
    "/api/sessions/switch",
    "/api/sessions/resume",
    "/api/sessions/abort",
    "/api/sessions/approval/resolve",
];
const LEGACY_FILE_ROUTES: &[&str] = &[
    "/api/files/read-text",
    "/api/files/read-binary",
    "/api/files/stat",
    "/api/files/list-dir",
    "/api/files/thumbnails",
    "/api/files/write-text",
    "/api/files/stage-paths",
    "/api/files/stage-buffer",
    "/api/files/thumbnail",
];

fn route_without_query(route: &str) -> &str {
    route.split_once('?').map_or(route, |(path, _)| path)
}

fn legacy_rejection(message: &'static str) -> DispatchResponse {
    DispatchResponse::bad_request(message)
}

fn command_outcome(outcome: CommandOutcome) -> Result<Option<Value>, DispatchResponse> {
    match outcome {
        CommandOutcome::Succeeded { result } | CommandOutcome::Unknown { result } => {
            Ok(Some(result))
        }
        CommandOutcome::Rejected { .. } => Err(DispatchResponse::bad_request(
            "Runtime Host command input is invalid.",
        )),
        CommandOutcome::TimedOut => Err(DispatchResponse::internal_error()),
    }
}
