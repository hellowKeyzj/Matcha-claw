use std::{sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor as LoopbackModuleDescriptor, ModuleId as LoopbackModuleId,
        Request, RequestHead, Response, RouteDescriptor, RouteFuture, RouteHeadPlan,
    },
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId as CatalogModuleId},
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    driver::OpenClawDriver,
    platform_runtime::{project_cli_command, project_installation_status, project_runtime_paths},
    tool_permission::{decode_set_mode_request, project_mode, project_set_mode},
};

const MODULE_ID: CatalogModuleId = CatalogModuleId::new("openclaw-platform");
const LOOPBACK_MODULE_ID: LoopbackModuleId = LoopbackModuleId::new("openclaw-platform");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("openclaw.platform")];
const REQUIRES: &[CapabilityKey] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::Route, EffectKind::RuntimeOperation];
const ROUTES: &[&str] = &["openclaw-platform.loopback"];
const EVENTS: &[&str] = &[];

const STATUS_ENDPOINT: &str = "/api/openclaw/status";
const RUNTIME_PATHS_ENDPOINT: &str = "/api/openclaw/runtime/paths";
const CLI_COMMAND_ENDPOINT: &str = "/api/openclaw/cli-command";
const TOOL_PERMISSION_ENDPOINT: &str = "/api/openclaw/tool-permission-mode";
const SUBAGENT_TEMPLATES_ENDPOINT: &str = "/api/openclaw/subagent-templates";
const SUBAGENT_TEMPLATE_DETAIL_ENDPOINT: &str = "/api/openclaw/subagent-template/detail";

const READ_SCOPE: &str = "openclaw.platform:read";
const WRITE_SCOPE: &str = "openclaw.platform:write";

const DEFAULT_DEADLINE: Duration = Duration::from_secs(5);
const MAX_REQUEST_BYTES: usize = 4096;

pub trait OpenClawPlatformAdmissionPort: Send + Sync {
    fn admit_openclaw_platform_request(&self) -> bool;
}

pub fn descriptor(
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    driver: Arc<OpenClawDriver>,
    admission: Arc<dyn OpenClawPlatformAdmissionPort>,
) -> ModuleDescriptor {
    ModuleDescriptor::new(
        MODULE_ID,
        PROVIDES,
        REQUIRES,
        EFFECTS,
        ROUTES,
        EVENTS,
        Some(loopback_descriptor(Dependencies::new(
            verifier, admission, driver,
        ))),
    )
}

#[derive(Clone)]
struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    admission: Arc<dyn OpenClawPlatformAdmissionPort>,
    driver: Arc<OpenClawDriver>,
}

impl Dependencies {
    fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        admission: Arc<dyn OpenClawPlatformAdmissionPort>,
        driver: Arc<OpenClawDriver>,
    ) -> Self {
        Self {
            verifier,
            admission,
            driver,
        }
    }
}

fn loopback_descriptor(dependencies: Dependencies) -> LoopbackModuleDescriptor {
    LoopbackModuleDescriptor::new(
        LOOPBACK_MODULE_ID,
        vec![RouteDescriptor::bound(
            "openclaw-platform.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    operation_for(&head.method, pathname(&head.path)).map(|operation| {
        RouteHeadPlan::new(body_policy(operation), DEFAULT_DEADLINE, timeout_response)
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move { handle(dependencies, request).await.into() })
}

async fn handle(dependencies: Dependencies, request: Request) -> Response {
    let Some((operation, authorization)) =
        operation_for(request.method(), pathname(request.path()))
            .map(|operation| (operation, operation.authorization()))
    else {
        return Response::not_found();
    };
    let Some(token) = request.bearer_authorization() else {
        return unauthorized();
    };
    if dependencies
        .verifier
        .lock()
        .await
        .verify(
            token,
            now_millis(),
            authorization.endpoint,
            authorization.scope,
            authorization.capability,
            authorization.subject,
        )
        .is_err()
    {
        return unauthorized();
    }
    if !dependencies.admission.admit_openclaw_platform_request() {
        return unavailable();
    }

    match operation {
        Operation::Status => status_response(&dependencies.driver),
        Operation::RuntimePaths => runtime_paths_response(&dependencies.driver),
        Operation::CliCommand => cli_command_response(&dependencies.driver),
        Operation::ToolPermissionGet => tool_permission_get_response(&dependencies.driver),
        Operation::ToolPermissionSet => {
            tool_permission_set_response(&dependencies.driver, &request.body)
        }
        Operation::SubagentTemplateCatalog => {
            subagent_template_catalog_response(&dependencies.driver)
        }
        Operation::SubagentTemplateDetail => {
            subagent_template_detail_response(&dependencies.driver, &request.body)
        }
    }
}

#[derive(Clone, Copy)]
enum Operation {
    Status,
    RuntimePaths,
    CliCommand,
    ToolPermissionGet,
    ToolPermissionSet,
    SubagentTemplateCatalog,
    SubagentTemplateDetail,
}

impl Operation {
    fn authorization(self) -> RouteAuthorization {
        match self {
            Self::Status => RouteAuthorization::read(
                STATUS_ENDPOINT,
                "openclaw.environment.status",
                "openclaw-environment-status",
            ),
            Self::RuntimePaths => RouteAuthorization::read(
                RUNTIME_PATHS_ENDPOINT,
                "openclaw.runtime.paths",
                "openclaw-runtime-paths",
            ),
            Self::CliCommand => RouteAuthorization::read(
                CLI_COMMAND_ENDPOINT,
                "openclaw.cli.command",
                "openclaw-cli-command",
            ),
            Self::ToolPermissionGet => RouteAuthorization::read(
                TOOL_PERMISSION_ENDPOINT,
                "openclaw.tool-permission.get",
                "openclaw-tool-permission",
            ),
            Self::ToolPermissionSet => RouteAuthorization::write(
                TOOL_PERMISSION_ENDPOINT,
                "openclaw.tool-permission.set",
                "openclaw-tool-permission",
            ),
            Self::SubagentTemplateCatalog => RouteAuthorization::read(
                SUBAGENT_TEMPLATES_ENDPOINT,
                "openclaw.subagent-templates.list",
                "openclaw-subagent-templates",
            ),
            Self::SubagentTemplateDetail => RouteAuthorization::read(
                SUBAGENT_TEMPLATE_DETAIL_ENDPOINT,
                "openclaw.subagent-templates.get",
                "openclaw-subagent-template",
            ),
        }
    }
}

struct RouteAuthorization {
    endpoint: &'static str,
    scope: &'static str,
    capability: &'static str,
    subject: &'static str,
}

impl RouteAuthorization {
    const fn read(endpoint: &'static str, capability: &'static str, subject: &'static str) -> Self {
        Self {
            endpoint,
            scope: READ_SCOPE,
            capability,
            subject,
        }
    }

    const fn write(
        endpoint: &'static str,
        capability: &'static str,
        subject: &'static str,
    ) -> Self {
        Self {
            endpoint,
            scope: WRITE_SCOPE,
            capability,
            subject,
        }
    }
}

fn operation_for(method: &str, path: &str) -> Option<Operation> {
    match (method, path) {
        ("GET", STATUS_ENDPOINT) => Some(Operation::Status),
        ("GET", RUNTIME_PATHS_ENDPOINT) => Some(Operation::RuntimePaths),
        ("GET", CLI_COMMAND_ENDPOINT) => Some(Operation::CliCommand),
        ("GET", TOOL_PERMISSION_ENDPOINT) => Some(Operation::ToolPermissionGet),
        ("POST", TOOL_PERMISSION_ENDPOINT) => Some(Operation::ToolPermissionSet),
        ("GET", SUBAGENT_TEMPLATES_ENDPOINT) => Some(Operation::SubagentTemplateCatalog),
        ("POST", SUBAGENT_TEMPLATE_DETAIL_ENDPOINT) => Some(Operation::SubagentTemplateDetail),
        _ => None,
    }
}

fn body_policy(operation: Operation) -> BodyPolicy {
    match operation {
        Operation::ToolPermissionSet | Operation::SubagentTemplateDetail => BodyPolicy::Required {
            max_bytes: MAX_REQUEST_BYTES,
        },
        _ => BodyPolicy::Empty,
    }
}

fn status_response(driver: &OpenClawDriver) -> Response {
    match driver.installation_status() {
        Some(status) => Response::json(
            200,
            project_installation_status(&crate::platform_runtime::InstallationStatus::from(status)),
        ),
        None => unavailable(),
    }
}

fn runtime_paths_response(driver: &OpenClawDriver) -> Response {
    match driver.runtime_paths() {
        Ok(paths) => Response::json(
            200,
            project_runtime_paths(crate::platform_runtime::RuntimePaths::from(paths)),
        ),
        Err(_) => unavailable(),
    }
}

fn cli_command_response(driver: &OpenClawDriver) -> Response {
    match driver.cli_command() {
        Ok(command) => Response::json(
            200,
            project_cli_command(crate::platform_runtime::CliCommand::from(command)),
        ),
        Err(_) => unavailable(),
    }
}

fn tool_permission_get_response(driver: &OpenClawDriver) -> Response {
    match driver.tool_permission_mode() {
        Ok(mode) => Response::json(
            200,
            project_mode(crate::surfaces::tooling::tool_permission::Mode::from(mode)),
        ),
        Err(_) => unavailable(),
    }
}

fn tool_permission_set_response(driver: &OpenClawDriver, body: &[u8]) -> Response {
    let value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => return invalid_request(),
    };
    let mode = match decode_set_mode_request(value) {
        Ok(request) => request.mode(),
        Err(_) => return invalid_request(),
    };
    match driver.set_tool_permission_mode(mode.into()) {
        Ok(effect) => Response::json(200, project_set_mode(mode, effect.into())),
        Err(crate::native_config::tool_permission::Error::Unavailable) => unavailable(),
        Err(crate::native_config::tool_permission::Error::Unknown) => failed(),
    }
}

fn subagent_template_catalog_response(driver: &OpenClawDriver) -> Response {
    match driver.subagent_template_catalog() {
        Ok(catalog) => Response::json(200, serde_json::to_value(catalog).unwrap_or(Value::Null)),
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateDetailRequest {
    id: String,
}

fn subagent_template_detail_response(driver: &OpenClawDriver, body: &[u8]) -> Response {
    let request = match serde_json::from_slice::<TemplateDetailRequest>(body) {
        Ok(request) if is_template_id(&request.id) => request,
        _ => return invalid_request(),
    };
    match driver.subagent_template(&request.id) {
        Ok(detail) => Response::json(200, serde_json::to_value(detail).unwrap_or(Value::Null)),
        Err(_) => unavailable(),
    }
}

fn is_template_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn invalid_request() -> Response {
    Response::error(400, "OpenClaw platform request is invalid")
}

fn unauthorized() -> Response {
    Response::error(401, "OpenClaw platform authorization is invalid")
}

fn unavailable() -> Response {
    Response::error(503, "OpenClaw platform is unavailable")
}

fn failed() -> Response {
    Response::error(500, "OpenClaw platform command failed")
}

fn timeout_response() -> Response {
    Response::error(503, "Runtime Host request deadline exceeded")
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
