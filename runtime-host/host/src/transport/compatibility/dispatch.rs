use serde_json::{Value, json};

use crate::{
    capability_directory,
    control::{CommandInput, CommandOutcome},
    owner,
};

use super::wire::{DispatchRequest, DispatchResponse, DispatchSuccess, VERSION};

pub(crate) async fn execute(owner: &owner::Handle, request: DispatchRequest) -> DispatchResponse {
    if request.version != VERSION
        || !matches!(request.method.as_str(), "GET" | "POST" | "PUT" | "DELETE")
        || !request.route.starts_with('/')
    {
        return DispatchResponse::bad_request("Dispatch envelope is invalid");
    }

    match dispatch_route(owner, &request.method, &request.route, request.payload).await {
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
    method: &str,
    route: &str,
    payload: Option<Value>,
) -> Result<Option<Value>, DispatchResponse> {
    match (method, route_without_query(route)) {
        ("GET", "/api/runtime-host/health") => dispatch_host_health(owner).await,
        ("GET", "/api/capabilities/list") => command_outcome(capability_directory::list()),
        ("POST", "/api/capabilities/describe") => dispatch_capability_describe(payload),
        ("POST", "/api/capabilities/execute") => dispatch_capability(owner, payload).await,
        ("GET", "/api/openclaw/status") => dispatch_openclaw_status(owner).await,
        ("GET", "/api/openclaw/ready") => dispatch_openclaw_ready(owner).await,
        ("GET", "/api/openclaw/dir") => {
            dispatch_openclaw_path(owner, OpenClawPathKind::Directory).await
        }
        ("GET", "/api/openclaw/config-dir") => {
            dispatch_openclaw_path(owner, OpenClawPathKind::ConfigDirectory).await
        }
        ("GET", "/api/openclaw/workspace-dir") => {
            dispatch_openclaw_path(owner, OpenClawPathKind::WorkspaceDirectory).await
        }
        ("GET", "/api/openclaw/task-workspace-dirs") => {
            dispatch_openclaw_path(owner, OpenClawPathKind::TaskWorkspaceDirectories).await
        }
        ("GET", "/api/openclaw/skills-dir") => {
            dispatch_openclaw_path(owner, OpenClawPathKind::SkillsDirectory).await
        }
        ("GET", "/api/openclaw/cli-command") => dispatch_openclaw_cli_command(owner).await,
        ("GET", "/api/openclaw/tool-permission-mode") => {
            dispatch_openclaw_tool_permission_mode(owner).await
        }
        ("PUT", "/api/openclaw/tool-permission-mode") => {
            dispatch_set_openclaw_tool_permission_mode(owner, payload).await
        }
        ("GET", "/api/openclaw/subagent-templates") => {
            dispatch_subagent_template_catalog(owner).await
        }
        ("GET", path) if path.starts_with("/api/openclaw/subagent-templates/") => {
            dispatch_subagent_template(owner, path).await
        }
        ("GET", "/api/toolchain/uv/check") => dispatch_toolchain_uv_check(owner).await,
        ("GET", "/api/plugins/runtime") => dispatch_plugins_runtime(owner).await,
        ("GET", "/api/plugins/catalog") => dispatch_plugins_catalog(owner).await,
        ("GET", "/api/skills/status") => dispatch_skill_status(owner).await,
        ("GET", "/api/skills/effective") => dispatch_skill_status(owner).await,
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

async fn dispatch_openclaw_status(
    owner: &owner::Handle,
) -> Result<Option<Value>, DispatchResponse> {
    let state = owner.state();
    serde_json::to_value(state.open_claw().projection())
        .map(Some)
        .map_err(|_| DispatchResponse::internal_error())
}

async fn dispatch_openclaw_ready(owner: &owner::Handle) -> Result<Option<Value>, DispatchResponse> {
    let state = owner.state();
    let projection = state.open_claw().projection();
    Ok(Some(json!({
        "ready": matches!(state.open_claw().lifecycle(), crate::RuntimeLifecycle::Running),
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
    owner: &owner::Handle,
    kind: OpenClawPathKind,
) -> Result<Option<Value>, DispatchResponse> {
    let paths = owner
        .open_claw_runtime_paths()
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
    owner: &owner::Handle,
) -> Result<Option<Value>, DispatchResponse> {
    let command = owner
        .open_claw_cli_command()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({ "command": command.command() })))
}

async fn dispatch_openclaw_tool_permission_mode(
    owner: &owner::Handle,
) -> Result<Option<Value>, DispatchResponse> {
    let mode = owner
        .open_claw_tool_permission_mode()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({ "mode": mode })))
}

async fn dispatch_set_openclaw_tool_permission_mode(
    owner: &owner::Handle,
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
    let effect = owner
        .set_open_claw_tool_permission_mode(request.mode)
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(
        json!({ "mode": request.mode, "changed": matches!(effect, openclaw::projection::tool_permission::Effect::Written) }),
    ))
}

async fn dispatch_subagent_template_catalog(
    owner: &owner::Handle,
) -> Result<Option<Value>, DispatchResponse> {
    let catalog = owner
        .list_subagent_templates()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    serde_json::to_value(catalog)
        .map(Some)
        .map_err(|_| DispatchResponse::internal_error())
}

async fn dispatch_subagent_template(
    owner: &owner::Handle,
    path: &str,
) -> Result<Option<Value>, DispatchResponse> {
    let id = path
        .strip_prefix("/api/openclaw/subagent-templates/")
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| DispatchResponse::bad_request("Subagent template id is required"))?;
    let template = owner
        .subagent_template(percent_decode_path_segment(id))
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::not_found("GET", path))?;
    serde_json::to_value(template)
        .map(Some)
        .map_err(|_| DispatchResponse::internal_error())
}

async fn dispatch_toolchain_uv_check(
    owner: &owner::Handle,
) -> Result<Option<Value>, DispatchResponse> {
    let status = owner
        .open_claw_toolchain_status()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!(matches!(
        status.uv(),
        openclaw::toolchain::ToolAvailability::Available
    ))))
}

async fn dispatch_plugins_runtime(
    owner: &owner::Handle,
) -> Result<Option<Value>, DispatchResponse> {
    let runtime = owner
        .plugins_runtime()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({ "result": runtime })))
}

async fn dispatch_plugins_catalog(
    owner: &owner::Handle,
) -> Result<Option<Value>, DispatchResponse> {
    let catalog = owner
        .plugins_catalog()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({ "result": catalog })))
}

async fn dispatch_skill_status(owner: &owner::Handle) -> Result<Option<Value>, DispatchResponse> {
    match owner.skill_status().await {
        Ok(crate::skill_status::Outcome::Available(catalog)) => Ok(Some(json!({
            "skills": catalog.entries.iter().map(|entry| json!({
                "key": entry.key,
                "name": entry.name,
                "description": entry.description,
                "enabled": entry.enabled,
                "selectable": entry.selectable,
                "installed": entry.installed,
                "eligible": entry.eligible,
                "blockedByAllowlist": entry.blocked_by_allowlist,
                "blockedByAgentFilter": entry.blocked_by_agent_filter,
                "unavailableReason": entry.unavailable_reason.map(|reason| format!("{reason:?}").to_ascii_lowercase()),
                "missingCategories": entry.missing_categories.iter().map(|category| format!("{category:?}").to_ascii_lowercase()).collect::<Vec<_>>()
            })).collect::<Vec<_>>(),
        }))),
        Ok(crate::skill_status::Outcome::Unavailable) | Err(_) => {
            Err(DispatchResponse::internal_error())
        }
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

const PLATFORM_RUNTIME_CAPABILITY_ID: &str = "platform.runtime";
const TOOLCHAIN_INSTALL_UV_OPERATION_ID: &str = "toolchain.installUv";
const RUNTIME_HOST_CAPABILITY_ID: &str = "runtime.host";
const RUNTIME_JOB_GET_OPERATION_ID: &str = "runtimeHost.jobGet";
const PLUGIN_RUNTIME_CAPABILITY_ID: &str = "plugin.runtime";
const SKILL_MANAGEMENT_CAPABILITY_ID: &str = "skill.management";

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

async fn dispatch_capability(
    owner: &owner::Handle,
    payload: Option<Value>,
) -> Result<Option<Value>, DispatchResponse> {
    let Some(Value::Object(payload)) = payload else {
        return Err(DispatchResponse::bad_request(
            "Capability payload is invalid",
        ));
    };
    match (
        payload.get("id").and_then(Value::as_str),
        payload.get("operationId").and_then(Value::as_str),
    ) {
        (Some(PLATFORM_RUNTIME_CAPABILITY_ID), Some(TOOLCHAIN_INSTALL_UV_OPERATION_ID)) => {
            dispatch_toolchain_install_submit(owner, &payload).await
        }
        (Some(RUNTIME_HOST_CAPABILITY_ID), Some(RUNTIME_JOB_GET_OPERATION_ID)) => {
            dispatch_runtime_job_get(owner, &payload).await
        }
        _ => Ok(None),
    }
}

async fn dispatch_toolchain_install_submit(
    owner: &owner::Handle,
    payload: &serde_json::Map<String, Value>,
) -> Result<Option<Value>, DispatchResponse> {
    validate_toolchain_install_request(payload)?;

    match owner.submit_open_claw_toolchain_install().await {
        Ok(Ok(submission)) => serde_json::to_value(submission)
            .map(Some)
            .map_err(|_| DispatchResponse::internal_error()),
        Ok(Err(_)) | Err(_) => Err(DispatchResponse::internal_error()),
    }
}

async fn dispatch_runtime_job_get(
    owner: &owner::Handle,
    payload: &serde_json::Map<String, Value>,
) -> Result<Option<Value>, DispatchResponse> {
    validate_runtime_job_target_input(payload)?;

    let job_id = payload
        .get("input")
        .and_then(Value::as_object)
        .and_then(|input| input.get("jobId"))
        .and_then(Value::as_str)
        .ok_or_else(DispatchResponse::target_rejected)?;
    match owner.get_compatible_runtime_job(job_id.to_owned()).await {
        Ok(Ok(lookup)) => serde_json::to_value(lookup)
            .map(Some)
            .map_err(|_| DispatchResponse::internal_error()),
        Ok(Err(_)) | Err(_) => Err(DispatchResponse::internal_error()),
    }
}

fn validate_toolchain_install_request(
    payload: &serde_json::Map<String, Value>,
) -> Result<(), DispatchResponse> {
    if !has_exact_keys(payload, &["id", "operationId", "scope", "target", "input"])
        || payload.get("id").and_then(Value::as_str) != Some(PLATFORM_RUNTIME_CAPABILITY_ID)
        || payload.get("operationId").and_then(Value::as_str)
            != Some(TOOLCHAIN_INSTALL_UV_OPERATION_ID)
        || !is_native_runtime_scope(payload.get("scope"))
    {
        return Err(DispatchResponse::bad_request(
            "Capability payload is invalid",
        ));
    }

    let valid_target = payload
        .get("target")
        .and_then(Value::as_object)
        .is_some_and(|target| {
            has_exact_keys(target, &["kind"])
                && target.get("kind").and_then(Value::as_str) == Some("runtime-job")
        });
    let valid_input = payload
        .get("input")
        .and_then(Value::as_object)
        .is_some_and(|input| input.is_empty());
    if !valid_target || !valid_input {
        return Err(DispatchResponse::target_rejected());
    }
    Ok(())
}

fn has_exact_keys(object: &serde_json::Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

fn is_native_runtime_scope(value: Option<&Value>) -> bool {
    value
        == Some(&serde_json::json!({
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": "openclaw",
                "runtimeInstanceId": "local",
            },
        }))
}

fn validate_runtime_job_target_input(
    payload: &serde_json::Map<String, Value>,
) -> Result<(), DispatchResponse> {
    let target = payload
        .get("target")
        .and_then(Value::as_object)
        .filter(|target| target.get("kind").and_then(Value::as_str) == Some("runtime-job"));
    let input = payload.get("input").and_then(Value::as_object);
    let target_job_id = target
        .and_then(|target| target.get("jobId"))
        .and_then(Value::as_str)
        .filter(|job_id| !job_id.trim().is_empty());
    let input_job_id = input
        .and_then(|input| input.get("jobId"))
        .and_then(Value::as_str)
        .filter(|job_id| !job_id.trim().is_empty());
    if target_job_id.is_none() || input_job_id.is_none() || target_job_id != input_job_id {
        return Err(DispatchResponse::target_rejected());
    }
    Ok(())
}

fn unknown_runtime_job_projection() -> Value {
    serde_json::to_value(crate::projection::job_compatibility::JobCompatibilityLookup::unknown())
        .expect("unknown job compatibility projection must serialize")
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{
        PLATFORM_RUNTIME_CAPABILITY_ID, RUNTIME_HOST_CAPABILITY_ID, RUNTIME_JOB_GET_OPERATION_ID,
        TOOLCHAIN_INSTALL_UV_OPERATION_ID,
    };

    fn payload(target_job_id: &str, input_job_id: &str) -> serde_json::Value {
        json!({
            "id": RUNTIME_HOST_CAPABILITY_ID,
            "operationId": RUNTIME_JOB_GET_OPERATION_ID,
            "scope": { "kind": "runtime-instance", "endpoint": {} },
            "target": { "kind": "runtime-job", "jobId": target_job_id },
            "input": { "jobId": input_job_id },
        })
    }

    fn toolchain_install_payload() -> serde_json::Value {
        json!({
            "id": PLATFORM_RUNTIME_CAPABILITY_ID,
            "operationId": TOOLCHAIN_INSTALL_UV_OPERATION_ID,
            "scope": {
                "kind": "runtime-instance",
                "endpoint": {
                    "kind": "native-runtime",
                    "runtimeAdapterId": "openclaw",
                    "runtimeInstanceId": "local",
                },
            },
            "target": { "kind": "runtime-job" },
            "input": {},
        })
    }

    fn payload_with_extra_input(target_job_id: &str, input_job_id: &str) -> serde_json::Value {
        let mut payload = payload(target_job_id, input_job_id);
        payload["input"]["message"] = json!("must not be echoed");
        payload
    }

    fn assert_target_rejected(payload: serde_json::Value) {
        let response = super::validate_runtime_job_target_input(payload.as_object().unwrap())
            .unwrap_err()
            .into_json();
        assert_eq!(response["error"]["code"], "TARGET_REJECTED");
        assert_eq!(response["status"], 400);
    }

    #[test]
    fn toolchain_install_request_accepts_the_private_capability_envelope() {
        super::validate_toolchain_install_request(toolchain_install_payload().as_object().unwrap())
            .expect("toolchain install envelope must be accepted");
    }

    #[test]
    fn toolchain_install_request_rejects_invalid_envelopes_without_echoing_input() {
        let secret = "private-toolchain-input";
        let mut payload = toolchain_install_payload();
        payload.as_object_mut().unwrap().remove("scope");
        payload["input"] = json!({ "secret": secret });
        let response = super::validate_toolchain_install_request(payload.as_object().unwrap())
            .unwrap_err()
            .into_json();
        assert_eq!(response["status"], 400);
        assert_eq!(response["error"]["code"], "BAD_REQUEST");
        assert!(!response.to_string().contains(secret));
    }

    #[test]
    fn toolchain_install_request_rejects_invalid_scope_without_echoing_it() {
        let secret = "private-runtime-scope";
        let mut payload = toolchain_install_payload();
        payload["scope"] = json!({ "kind": "runtime-instance", "secret": secret });
        let response = super::validate_toolchain_install_request(payload.as_object().unwrap())
            .unwrap_err()
            .into_json();
        assert_eq!(response["status"], 400);
        assert_eq!(response["error"]["code"], "BAD_REQUEST");
        assert!(!response.to_string().contains(secret));
    }

    #[test]
    fn toolchain_install_request_rejects_invalid_target_kind() {
        let mut payload = toolchain_install_payload();
        payload["target"]["kind"] = json!("session");
        let response = super::validate_toolchain_install_request(payload.as_object().unwrap())
            .unwrap_err()
            .into_json();
        assert_eq!(response["status"], 400);
        assert_eq!(response["error"]["code"], "TARGET_REJECTED");
    }

    #[test]
    fn runtime_job_get_returns_unknown_without_a_safe_owner_crosswalk() {
        let response = super::unknown_runtime_job_projection();
        assert_eq!(response["job"], Value::Null);
        assert_eq!(response["outcome"], "unknown");
    }

    #[test]
    fn runtime_job_get_does_not_infer_terminal_state_from_session_identifiers() {
        for (field, value) in [
            ("runId", "run-1"),
            ("routeKey", "renderer-route:session-send"),
            ("requestId", "request-1"),
        ] {
            for status in ["queued", "started", "cancel accepted"] {
                let mut payload = payload("job-1", "job-1");
                payload["input"][field] = json!(value);
                payload["input"]["status"] = json!(status);
                let response = super::unknown_runtime_job_projection();
                assert_eq!(response, json!({ "job": null, "outcome": "unknown" }));
            }
        }
    }

    #[test]
    fn runtime_job_get_rejects_mismatched_target_and_input() {
        assert_target_rejected(payload("job-1", "job-2"));
    }

    #[test]
    fn runtime_job_get_rejects_missing_target() {
        let mut value = payload("job-1", "job-1");
        value.as_object_mut().unwrap().remove("target");
        assert_target_rejected(value);
    }

    #[test]
    fn runtime_job_get_rejects_missing_input() {
        let mut value = payload("job-1", "job-1");
        value.as_object_mut().unwrap().remove("input");
        assert_target_rejected(value);
    }

    #[test]
    fn runtime_job_get_rejects_empty_job_ids() {
        assert_target_rejected(payload("", ""));
        assert_target_rejected(payload("job-1", ""));
        assert_target_rejected(payload("", "job-1"));
    }

    #[test]
    fn runtime_job_get_rejects_malformed_target_kind() {
        let mut value = payload("job-1", "job-1");
        value["target"]["kind"] = json!("session");
        assert_target_rejected(value);
    }

    #[test]
    fn runtime_job_get_does_not_echo_secret_payload_fields() {
        let secret = "token-secret-message";
        let mut value = payload_with_extra_input(secret, secret);
        value["input"]["attachments"] = json!([{ "content": secret }]);
        let _ = super::validate_runtime_job_target_input(value.as_object().unwrap());
        let response = super::unknown_runtime_job_projection().to_string();
        assert!(!response.contains(secret));
        assert_eq!(response, r#"{"job":null,"outcome":"unknown"}"#);
    }
}
