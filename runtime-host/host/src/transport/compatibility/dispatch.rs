use serde_json::{Value, json};

use crate::{
    composition::PeerHandle,
    control::{CommandInput, CommandOutcome},
    facade::{
        PlatformRuntimeHandle, PluginsHandle, SkillsHandle, SubagentTemplate,
        SubagentTemplateCatalog, SubagentTemplateCategory, SubagentTemplateDetail,
        SubagentTemplateError, SubagentTemplateSummary, ToolPermissionEffect, ToolPermissionMode,
        ToolchainHandle,
    },
    sessions::SessionHandle,
};

use super::wire::{DispatchRequest, DispatchResponse, DispatchSuccess, VERSION};

pub(crate) async fn execute(
    owner: &crate::host_actor::Handle,
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
    owner: &crate::host_actor::Handle,
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
        ("GET", "/api/capabilities/list") => {
            command_outcome(crate::capabilities::directory::list())
        }
        ("POST", "/api/capabilities/describe") => dispatch_capability_describe(payload),
        ("POST", "/api/capabilities/execute") => Ok(None),
        ("GET", "/api/openclaw/status") => dispatch_openclaw_status(peer).await,
        ("GET", "/api/openclaw/ready") => dispatch_openclaw_ready(peer).await,
        ("GET", "/api/openclaw/dir")
        | ("GET", "/api/openclaw/config-dir")
        | ("GET", "/api/openclaw/workspace-dir")
        | ("GET", "/api/openclaw/task-workspace-dirs")
        | ("GET", "/api/openclaw/skills-dir") => {
            dispatch_openclaw_path_availability(platform_runtime).await
        }
        ("GET", "/api/openclaw/cli-command") => {
            dispatch_openclaw_cli_command_availability(platform_runtime).await
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

async fn dispatch_host_health(
    owner: &crate::host_actor::Handle,
) -> Result<Option<Value>, DispatchResponse> {
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
    command_outcome(crate::capabilities::directory::describe(CommandInput(
        Value::Object(payload),
    )))
}

async fn dispatch_openclaw_status(peer: &PeerHandle) -> Result<Option<Value>, DispatchResponse> {
    let state = peer
        .open_claw_status()
        .await
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(runtime_state_json(&state)))
}

async fn dispatch_openclaw_ready(peer: &PeerHandle) -> Result<Option<Value>, DispatchResponse> {
    let state = peer
        .open_claw_status()
        .await
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({
        "ready": matches!(state.lifecycle(), crate::RuntimeLifecycle::Running),
        "state": runtime_state_json(&state),
    })))
}

fn runtime_state_json(state: &crate::RuntimeState) -> Value {
    let mut object = serde_json::Map::new();
    object.insert(
        "lifecycle".into(),
        json!(runtime_lifecycle_code(state.lifecycle())),
    );
    if let Some(failure) = state.failure() {
        object.insert("failure".into(), json!(runtime_failure_code(failure)));
    }
    if let Some(diagnostic) = state.startup_diagnostic() {
        object.insert(
            "startupDiagnostic".into(),
            json!(runtime_startup_diagnostic_code(diagnostic)),
        );
    }
    Value::Object(object)
}

fn runtime_lifecycle_code(lifecycle: crate::RuntimeLifecycle) -> &'static str {
    match lifecycle {
        crate::RuntimeLifecycle::Unavailable => "unavailable",
        crate::RuntimeLifecycle::Idle => "idle",
        crate::RuntimeLifecycle::Starting => "starting",
        crate::RuntimeLifecycle::Running => "running",
        crate::RuntimeLifecycle::Stopping => "stopping",
        crate::RuntimeLifecycle::WaitingToRestart => "waitingToRestart",
        crate::RuntimeLifecycle::Failed => "failed",
        crate::RuntimeLifecycle::ShutDown => "shutDown",
    }
}

fn runtime_failure_code(failure: crate::RuntimeFailure) -> &'static str {
    match failure {
        crate::RuntimeFailure::ArtifactUnavailable => "artifactUnavailable",
        crate::RuntimeFailure::PermissionDenied => "permissionDenied",
        crate::RuntimeFailure::ResourceUnavailable => "resourceUnavailable",
        crate::RuntimeFailure::PlatformRejected => "platformRejected",
        crate::RuntimeFailure::Stdio => "stdio",
        crate::RuntimeFailure::Readiness => "readiness",
        crate::RuntimeFailure::UnexpectedExit => "unexpectedExit",
        crate::RuntimeFailure::AuthorityLost => "authorityLost",
        crate::RuntimeFailure::CleanupUnconfirmed => "cleanupUnconfirmed",
        crate::RuntimeFailure::MaterialCleanupFailed => "materialCleanupFailed",
    }
}

fn runtime_startup_diagnostic_code(
    diagnostic: crate::diagnostics::RuntimeStartupDiagnostic,
) -> &'static str {
    match diagnostic {
        crate::diagnostics::RuntimeStartupDiagnostic::PortConflict => "portConflict",
        crate::diagnostics::RuntimeStartupDiagnostic::ConfigurationRejected => {
            "configurationRejected"
        }
        crate::diagnostics::RuntimeStartupDiagnostic::AppServerReportedError => {
            "appServerReportedError"
        }
        crate::diagnostics::RuntimeStartupDiagnostic::UnclassifiedStderr => "unclassifiedStderr",
        crate::diagnostics::RuntimeStartupDiagnostic::InvalidUtf8 => "invalidUtf8",
        crate::diagnostics::RuntimeStartupDiagnostic::LineTooLong => "lineTooLong",
        crate::diagnostics::RuntimeStartupDiagnostic::ListenerReported => "listenerReported",
        crate::diagnostics::RuntimeStartupDiagnostic::BindRejected => "bindRejected",
        crate::diagnostics::RuntimeStartupDiagnostic::StartupFailed => "startupFailed",
        crate::diagnostics::RuntimeStartupDiagnostic::InvalidEncoding => "invalidEncoding",
        crate::diagnostics::RuntimeStartupDiagnostic::DiagnosticLimitReached => {
            "diagnosticLimitReached"
        }
    }
}

async fn dispatch_openclaw_path_availability(
    platform_runtime: &PlatformRuntimeHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let available = platform_runtime.runtime_paths_available().await.is_ok();
    Ok(Some(json!({ "available": available })))
}

async fn dispatch_openclaw_cli_command_availability(
    platform_runtime: &PlatformRuntimeHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let available = platform_runtime.cli_command_available().await.is_ok();
    Ok(Some(json!({ "available": available })))
}

async fn dispatch_openclaw_tool_permission_mode(
    platform_runtime: &PlatformRuntimeHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let mode = platform_runtime
        .tool_permission_mode()
        .await
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({ "mode": mode.as_str() })))
}

async fn dispatch_set_openclaw_tool_permission_mode(
    platform_runtime: &PlatformRuntimeHandle,
    payload: Option<Value>,
) -> Result<Option<Value>, DispatchResponse> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        mode: ToolPermissionMode,
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
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(
        json!({ "mode": request.mode.as_str(), "changed": matches!(effect, ToolPermissionEffect::Written) }),
    ))
}

async fn dispatch_subagent_template_catalog(
    platform_runtime: &PlatformRuntimeHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let catalog = platform_runtime
        .subagent_template_catalog()
        .await
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(subagent_template_catalog_json(&catalog)))
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
        .map_err(|error| match error {
            SubagentTemplateError::Unavailable => DispatchResponse::internal_error(),
            SubagentTemplateError::NotFound => DispatchResponse::not_found("GET", path),
        })?;
    Ok(Some(subagent_template_detail_json(&template)))
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
    let mut object = serde_json::Map::new();
    object.insert("id".into(), json!(&category.id));
    if let Some(order) = category.order {
        object.insert("order".into(), json!(order));
    }
    Value::Object(object)
}

fn subagent_template_summary_json(summary: &SubagentTemplateSummary) -> Value {
    Value::Object(subagent_template_summary_object(summary))
}

fn subagent_template_summary_object(
    summary: &SubagentTemplateSummary,
) -> serde_json::Map<String, Value> {
    let mut object = serde_json::Map::new();
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
    Ok(Some(json!({
        "result": crate::transport::skills::plugins::project_runtime(runtime),
    })))
}

async fn dispatch_plugins_catalog(
    plugins: &PluginsHandle,
) -> Result<Option<Value>, DispatchResponse> {
    let catalog = plugins
        .catalog()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
        .map_err(|_| DispatchResponse::internal_error())?;
    Ok(Some(json!({
        "result": crate::transport::skills::plugins::project_catalog(catalog),
    })))
}

async fn dispatch_skill_status(skills: &SkillsHandle) -> Result<Option<Value>, DispatchResponse> {
    match skills
        .skill_status()
        .await
        .map_err(|_| DispatchResponse::internal_error())?
    {
        crate::skills::status::Outcome::Available(catalog) => {
            Ok(Some(crate::skills::status::project(&catalog)))
        }
        crate::skills::status::Outcome::Unavailable => Err(DispatchResponse::internal_error()),
    }
}

fn percent_decode_path_segment(value: &str) -> String {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Some(decoded) = hex_byte(bytes[index + 1], bytes[index + 2]) {
                output.push(decoded);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex_byte(high: u8, low: u8) -> Option<u8> {
    Some(hex_value(high)? << 4 | hex_value(low)?)
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
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
            Ok(Some(result.into_value()))
        }
        CommandOutcome::Rejected { .. } => Err(DispatchResponse::bad_request(
            "Runtime Host command input is invalid.",
        )),
        CommandOutcome::TimedOut => Err(DispatchResponse::internal_error()),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        net::TcpListener,
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    use matcha_agent::lifecycle::secret::Secret;
    use openclaw::{
        gateway::{auth::GatewaySecret, client::GatewayClientMetadata},
        lifecycle::state_dir::CanonicalStateDir,
        projection::workspace::WorkspaceProjectionFixture,
    };
    use serde_json::{Value, json};

    use super::*;
    use crate::{Host, HostInput, MatchaAgentInput, OpenClawInput, RuntimeObservationConfig};

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot {
        base: PathBuf,
        matcha_storage_parent: PathBuf,
        state_parent: PathBuf,
        openclaw: WorkspaceProjectionFixture,
    }

    impl TestRoot {
        fn new() -> Self {
            let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock must follow the Unix epoch")
                .as_nanos();
            let base = std::env::temp_dir().join(format!(
                "runtime-host-compatibility-dispatch-{}/-{nanos}-{sequence}",
                std::process::id()
            ));
            let state_parent = base.join("state");
            let matcha_storage_parent = base.join("matcha");
            fs::create_dir_all(&state_parent).unwrap();
            fs::create_dir(&matcha_storage_parent).unwrap();
            let openclaw = WorkspaceProjectionFixture::install(&base);
            Self {
                matcha_storage_parent,
                state_parent,
                openclaw,
                base,
            }
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    struct TestHandles {
        peer: PeerHandle,
        platform_runtime: PlatformRuntimeHandle,
        toolchain: ToolchainHandle,
        plugins: PluginsHandle,
        skills: SkillsHandle,
        session: SessionHandle,
    }

    struct TestHost {
        _root: TestRoot,
        owner: crate::host_actor::Owner,
        handles: TestHandles,
    }

    impl TestHost {
        async fn start() -> Self {
            let root = TestRoot::new();
            let input = host_input(&root);
            seed_workspace_config(&input.open_claw.state_dir, &root.base);
            let (mut host, events, handles) = Host::new(input).expect("construct host");
            host.start_admission_only().await.expect("start admission");
            let owner = crate::host_actor::Owner::spawn(host, events);
            Self {
                _root: root,
                owner,
                handles: TestHandles {
                    peer: handles.peer,
                    platform_runtime: handles.platform_runtime,
                    toolchain: handles.toolchain,
                    plugins: handles.plugins,
                    skills: handles.skills,
                    session: handles.session,
                },
            }
        }
    }

    impl Drop for TestHost {
        fn drop(&mut self) {
            let handle = self.owner.handle();
            tokio::spawn(async move {
                let _ = handle.shutdown().await;
            });
        }
    }

    #[tokio::test]
    async fn openclaw_runtime_path_compatibility_routes_project_only_availability() {
        let host = TestHost::start().await;

        for route in [
            "/api/openclaw/dir",
            "/api/openclaw/config-dir",
            "/api/openclaw/workspace-dir",
            "/api/openclaw/task-workspace-dirs",
            "/api/openclaw/skills-dir",
        ] {
            let outcome = execute_dispatch(&host, route).await;
            let data = success_data(outcome);
            assert_eq!(data, json!({ "available": true }));
            assert_no_openclaw_private_projection(&data);
        }
    }

    #[tokio::test]
    async fn openclaw_cli_command_compatibility_route_does_not_project_command_or_argv() {
        let host = TestHost::start().await;
        let outcome = execute_dispatch(&host, "/api/openclaw/cli-command").await;

        match outcome {
            DispatchResponse::Success(success) => {
                assert_availability_shape(&success.data);
                assert_no_openclaw_private_projection(&success.data);
            }
            DispatchResponse::Failure(failure) => {
                assert_eq!(failure.status, 500);
                assert_eq!(failure.error.code, "INTERNAL_ERROR");
                assert_no_openclaw_private_projection(&json!({
                    "code": failure.error.code,
                    "message": failure.error.message,
                }));
            }
        }
    }

    #[test]
    fn percent_decode_path_segment_never_slices_utf8_boundaries() {
        assert_eq!(
            percent_decode_path_segment("template%2Done"),
            "template-one"
        );
        assert_eq!(percent_decode_path_segment("%aé"), "%aé");
        assert_eq!(percent_decode_path_segment("%E4%B8%AD"), "中");
    }

    async fn execute_dispatch(host: &TestHost, route: &str) -> DispatchResponse {
        execute(
            &host.owner.handle(),
            &host.handles.peer,
            &host.handles.platform_runtime,
            &host.handles.toolchain,
            &host.handles.plugins,
            &host.handles.skills,
            &host.handles.session,
            DispatchRequest {
                version: VERSION,
                method: "GET".into(),
                route: route.into(),
                payload: None,
            },
        )
        .await
    }

    fn success_data(response: DispatchResponse) -> Value {
        match response {
            DispatchResponse::Success(success) => success.data,
            DispatchResponse::Failure(failure) => panic!(
                "expected dispatch success, got {} {}",
                failure.status, failure.error.code
            ),
        }
    }

    fn assert_availability_shape(value: &Value) {
        assert!(
            value["available"].is_boolean(),
            "invalid availability shape: {value}"
        );
        assert_eq!(
            value.as_object().map(|object| object.len()),
            Some(1),
            "availability projection must not include private fields: {value}"
        );
    }

    fn assert_no_openclaw_private_projection(value: &Value) {
        let serialized = value.to_string();
        for private in [
            "runtime-host-compatibility-dispatch",
            "openclawDir",
            "workspace",
            "taskWorkspace",
            "skillsDir",
            "argv",
            "command",
            "openclaw.mjs",
            "node '",
            "node \\\"",
        ] {
            assert!(
                !serialized.contains(private),
                "private OpenClaw projection leaked {private}: {serialized}"
            );
        }
    }

    fn seed_workspace_config(state_dir: &CanonicalStateDir, root: &std::path::Path) {
        fs::write(
            state_dir.as_path().join("openclaw.json"),
            serde_json::to_vec(&json!({
                "agents": {
                    "defaults": { "workspace": root.join("default-workspace") }
                }
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn host_input(root: &TestRoot) -> HostInput {
        let state_dir = CanonicalStateDir::provision(root.state_parent.join("openclaw")).unwrap();

        HostInput {
            matcha: MatchaAgentInput {
                bun_executable: absolute_path("bin/bun"),
                entry: absolute_path("matcha-agent/dist/cli-bun.js"),
                working_directory: absolute_path("runtime"),
                storage_root: root.matcha_storage_parent.join("app-server"),
                port: free_local_port(),
                #[cfg(windows)]
                git_bash: absolute_path("bin/bash.exe"),
                #[cfg(unix)]
                guardian_executable: absolute_path("bin/runtime-host-guardian"),
            },
            matcha_secret: Secret::new(entropy()).unwrap(),
            open_claw: OpenClawInput {
                team_run_mcp_executable: absolute_path("runtime-host-mcp"),
                team_run_mcp_state_dir: absolute_path("runtime-host"),
                electron_image: absolute_path("MatchaClaw"),
                working_directory: absolute_path("runtime"),
                openclaw_dir: root.openclaw.openclaw_dir().to_owned(),
                companion_skill_source_root: root.state_parent.join("openclaw-plugins"),
                managed_plugin_root: root.state_parent.join("openclaw-plugins"),
                subagent_template_dir: {
                    let path = root.state_parent.join("subagent-templates");
                    fs::create_dir_all(&path).expect("create subagent template directory");
                    path
                },
                entry: root.openclaw.openclaw_dir().join("openclaw.mjs"),
                state_dir,
                port: free_local_port(),
                sealed_endpoint: None,
                sealed_token: None,
                client_metadata: GatewayClientMetadata::try_new(
                    "test".into(),
                    std::env::consts::OS.into(),
                )
                .unwrap(),
                report_diagnostic: Arc::new(|_| {}),
                #[cfg(unix)]
                guardian_executable: absolute_path("bin/runtime-host-guardian"),
            },
            open_claw_secret: GatewaySecret::new(entropy()).unwrap(),
            organization_store: organization::OrganizationStore::open(
                root.state_parent.join("organization-facts.log"),
            )
            .unwrap(),
            runtime_state_dir: root.state_parent.join("runtime-host"),
            app_log_dir: root.state_parent.join("userdata-logs"),
            parent_callback_base_url: "http://127.0.0.1:34100".into(),
            parent_callback_dispatch_token: "test-parent-dispatch-token".into(),
            cron_transport_port: free_local_port(),
            runtime_observation: RuntimeObservationConfig::off(),
        }
    }

    fn free_local_port() -> u16 {
        TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn entropy() -> String {
        let sequence = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock must follow the Unix epoch")
            .as_nanos();
        format!("{nanos}-{sequence}")
    }

    fn absolute_path(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"C:\MatchaClaw\{name}"))
        } else {
            PathBuf::from(format!("/MatchaClaw/{name}"))
        }
    }
}
