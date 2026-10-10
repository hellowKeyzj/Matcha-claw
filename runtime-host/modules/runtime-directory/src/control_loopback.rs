use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use platform::{
    call::{CallReceipt, CallRecorder, CallStatus},
    capability::CapabilityDecisionVerifier,
    endpoint::runtime_address::RuntimeEndpoint,
    loopback::{
        BodyPolicy, ModuleDescriptor as LoopbackModuleDescriptor, ModuleId as LoopbackModuleId,
        Request, RequestHead, Response, RouteDescriptor, RouteFuture, RouteHeadPlan,
    },
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId as CatalogModuleId},
};
use serde::{Deserialize, de};
use tokio::sync::Mutex;

use crate::{
    RuntimeControlFailure, RuntimeControlLifecycleError, RuntimeControlLifecycleStatus,
    call::{
        RuntimeControlCallContext, RuntimeControlCallDetail, RuntimeControlCallResult,
        begin_runtime_control_call, finish_runtime_control_call,
    },
};

const MODULE_ID: CatalogModuleId = CatalogModuleId::new("runtime-control");
const LOOPBACK_MODULE_ID: LoopbackModuleId = LoopbackModuleId::new("runtime-control");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("runtime.control")];
const REQUIRES: &[CapabilityKey] = &[];
const ROUTES: &[&str] = &["runtime-control.loopback"];
const EVENTS: &[&str] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::Route, EffectKind::RuntimeOperation];

const DEFAULT_REQUEST_BYTES: usize = 64 * 1024;
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

const LIFECYCLE_STATUS_ENDPOINT: &str = "/api/runtime-control/lifecycle/status";
const LIFECYCLE_START_ENDPOINT: &str = "/api/runtime-control/lifecycle/start";
const LIFECYCLE_STOP_ENDPOINT: &str = "/api/runtime-control/lifecycle/stop";
const LIFECYCLE_RESTART_ENDPOINT: &str = "/api/runtime-control/lifecycle/restart";
const LIFECYCLE_REPAIR_ENDPOINT: &str = "/api/runtime-control/lifecycle/repair";
const REPAIR_STATUS_ENDPOINT: &str = "/api/runtime-control/repair/status";
const LOGS_ENDPOINT: &str = "/api/runtime-control/logs";
const CONTROL_READY_ENDPOINT: &str = "/api/runtime-control/control/ready";
const GATEWAY_HEALTH_ENDPOINT: &str = "/api/runtime-control/gateway/health";
const GATEWAY_STATUS_ENDPOINT: &str = "/api/runtime-control/gateway/status";
const CONTROL_UI_URL_ENDPOINT: &str = "/api/runtime-control/control-ui/url";

const READ_SCOPE: &str = "runtime-control:read";
const WRITE_SCOPE: &str = "runtime-control:write";
const LIFECYCLE_STATUS_CAPABILITY: &str = "runtime.lifecycle.status";
const LIFECYCLE_START_CAPABILITY: &str = "runtime.lifecycle.start";
const LIFECYCLE_STOP_CAPABILITY: &str = "runtime.lifecycle.stop";
const LIFECYCLE_RESTART_CAPABILITY: &str = "runtime.lifecycle.restart";
const LIFECYCLE_REPAIR_CAPABILITY: &str = "runtime.lifecycle.repair";
const REPAIR_STATUS_CAPABILITY: &str = "runtime.repair.status";
const LOGS_CAPABILITY: &str = "runtime.logs";
const CONTROL_READY_CAPABILITY: &str = "runtime.control.ready";
const GATEWAY_HEALTH_CAPABILITY: &str = "runtime.gateway.health";
const GATEWAY_STATUS_CAPABILITY: &str = "runtime.gateway.status";
const CONTROL_UI_URL_CAPABILITY: &str = "runtime.control-ui.url";

const LIFECYCLE_STATUS_SUBJECT: &str = "runtime-lifecycle-status";
const LIFECYCLE_START_SUBJECT: &str = "runtime-lifecycle-start";
const LIFECYCLE_STOP_SUBJECT: &str = "runtime-lifecycle-stop";
const LIFECYCLE_RESTART_SUBJECT: &str = "runtime-lifecycle-restart";
const LIFECYCLE_REPAIR_SUBJECT: &str = "runtime-lifecycle-repair";
const REPAIR_STATUS_SUBJECT: &str = "runtime-repair-status";
const LOGS_SUBJECT: &str = "runtime-logs";
const CONTROL_READY_SUBJECT: &str = "runtime-control-ready";
const GATEWAY_HEALTH_SUBJECT: &str = "runtime-gateway-health";
const GATEWAY_STATUS_SUBJECT: &str = "runtime-gateway-status";
const CONTROL_UI_URL_SUBJECT: &str = "runtime-control-ui-url";

pub type RuntimeControlRouteFuture = Pin<Box<dyn Future<Output = Response> + Send>>;
pub type RuntimeControlLifecycleFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeControlOperation {
    LifecycleStatus,
    LifecycleStart,
    LifecycleStop,
    LifecycleRestart,
    LifecycleRepair,
    RepairStatus,
    Logs,
    ControlReady,
    GatewayHealth,
    GatewayStatus,
    ControlUiUrl,
}

impl RuntimeControlOperation {
    pub const fn command(self) -> &'static str {
        match self {
            Self::LifecycleStatus => "lifecycle.status",
            Self::LifecycleStart => "lifecycle.start",
            Self::LifecycleStop => "lifecycle.stop",
            Self::LifecycleRestart => "lifecycle.restart",
            Self::LifecycleRepair => "lifecycle.repair",
            Self::RepairStatus => "repair.status",
            Self::Logs => "logs",
            Self::ControlReady => "control.ready",
            Self::GatewayHealth => "gateway.health",
            Self::GatewayStatus => "gateway.status",
            Self::ControlUiUrl => "control-ui.url",
        }
    }
}

#[derive(Clone)]
pub struct RuntimeControlRequest {
    pub endpoint: RuntimeEndpoint,
    pub cursor: Option<u64>,
    pub probe: Option<bool>,
    pub include_channel_summary: Option<bool>,
    pub call: Option<RuntimeControlCallContext>,
}

pub trait RuntimeControlRouteFragment: Send + Sync {
    fn endpoint(&self) -> RuntimeEndpoint;

    fn handle(
        &self,
        operation: RuntimeControlOperation,
        request: RuntimeControlRequest,
    ) -> Option<RuntimeControlRouteFuture>;
}

pub trait RuntimeControlLifecyclePort: Send + Sync {
    fn repair_status<'a>(
        &'a self,
        endpoint: RuntimeEndpoint,
    ) -> RuntimeControlLifecycleFuture<'a, Result<crate::RuntimeRepairSnapshot, RuntimeControlLifecycleError>>;

    fn admit_lifecycle_repair<'a>(
        &'a self,
        endpoint: RuntimeEndpoint,
        call: RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<'a, Result<CallReceipt, RuntimeControlLifecycleError>>;

    fn lifecycle_status<'a>(
        &'a self,
        endpoint: RuntimeEndpoint,
    ) -> RuntimeControlLifecycleFuture<
        'a,
        Result<RuntimeControlLifecycleStatus, RuntimeControlLifecycleError>,
    >;

    fn admit_lifecycle_start<'a>(
        &'a self,
        endpoint: RuntimeEndpoint,
        call: RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<'a, Result<CallReceipt, RuntimeControlLifecycleError>>;

    fn admit_lifecycle_stop<'a>(
        &'a self,
        endpoint: RuntimeEndpoint,
        call: RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<'a, Result<CallReceipt, RuntimeControlLifecycleError>>;

    fn admit_lifecycle_restart<'a>(
        &'a self,
        endpoint: RuntimeEndpoint,
        call: RuntimeControlCallContext,
    ) -> RuntimeControlLifecycleFuture<'a, Result<CallReceipt, RuntimeControlLifecycleError>>;
}

pub trait RuntimeControlAdmission: Send + Sync {
    fn admit_runtime_control(&self) -> bool;
}

#[derive(Clone)]
pub struct RuntimeControlModule {
    fragments: Arc<[Arc<dyn RuntimeControlRouteFragment>]>,
    call_recorder: Option<CallRecorder>,
}

impl RuntimeControlModule {
    pub fn new(fragments: Vec<Arc<dyn RuntimeControlRouteFragment>>) -> Self {
        Self {
            fragments: fragments.into(),
            call_recorder: None,
        }
    }

    pub fn with_call_recorder(mut self, call_recorder: CallRecorder) -> Self {
        self.call_recorder = Some(call_recorder);
        self
    }

    pub fn descriptor(&self, verifier: Arc<Mutex<CapabilityDecisionVerifier>>) -> ModuleDescriptor {
        ModuleDescriptor::new(
            MODULE_ID,
            PROVIDES,
            REQUIRES,
            EFFECTS,
            ROUTES,
            EVENTS,
            Some(descriptor(Dependencies::new(
                verifier,
                Arc::clone(&self.fragments),
                self.call_recorder.clone(),
            ))),
        )
    }
}

#[derive(Clone)]
struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    fragments: Arc<[Arc<dyn RuntimeControlRouteFragment>]>,
    call_recorder: Option<CallRecorder>,
}

impl Dependencies {
    fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        fragments: Arc<[Arc<dyn RuntimeControlRouteFragment>]>,
        call_recorder: Option<CallRecorder>,
    ) -> Self {
        Self {
            verifier,
            fragments,
            call_recorder,
        }
    }
}

fn descriptor(dependencies: Dependencies) -> LoopbackModuleDescriptor {
    LoopbackModuleDescriptor::new(
        LOOPBACK_MODULE_ID,
        vec![RouteDescriptor::bound(
            "runtime-control.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    operation_for(head.method.as_str(), pathname(&head.path)).map(|_| {
        RouteHeadPlan::new(
            BodyPolicy::Required {
                max_bytes: DEFAULT_REQUEST_BYTES,
            },
            DEFAULT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        let Some((operation, authorization)) =
            route_authorization(request.method(), pathname(request.path()))
        else {
            return Response::not_found().into();
        };
        let mut input = match authorized_input(request, dependencies.verifier, authorization).await
        {
            Ok(input) => input,
            Err(response) => return response.into(),
        };
        input.call = match begin_runtime_control_call(
            dependencies.call_recorder.as_ref(),
            operation,
            &input.endpoint,
        )
        .await
        {
            Ok(call) => call,
            Err(error) => {
                eprintln!("[runtime-control] call could not be recorded: {error}");
                return unavailable().into();
            }
        };
        let call = input.call.clone();
        if !matches!(
            operation,
            RuntimeControlOperation::LifecycleStart
                | RuntimeControlOperation::LifecycleStop
                | RuntimeControlOperation::LifecycleRestart
                | RuntimeControlOperation::LifecycleRepair
        ) {
            if let Some(call) = &call {
                if let Err(error) = call.running().await {
                    eprintln!("[runtime-control] call start could not be recorded: {error}");
                }
            }
        }
        let mut detail = RuntimeControlCallDetail::new(&input.endpoint);
        let response = dependencies
            .fragments
            .iter()
            .find(|fragment| fragment.endpoint() == input.endpoint)
            .and_then(|fragment| fragment.handle(operation, input));
        match response {
            Some(response) => response.await.into(),
            None => {
                detail.result = Some(RuntimeControlCallResult::Unsupported);
                finish_runtime_control_call(call, CallStatus::Rejected, &detail).await;
                unsupported().into()
            }
        }
    })
}

struct RouteAuthorization {
    endpoint: &'static str,
    scope: &'static str,
    capability: &'static str,
    subject: &'static str,
}

fn route_authorization(
    method: &str,
    path: &str,
) -> Option<(RuntimeControlOperation, RouteAuthorization)> {
    let operation = operation_for(method, path)?;
    let authorization = match operation {
        RuntimeControlOperation::LifecycleStatus => RouteAuthorization {
            endpoint: LIFECYCLE_STATUS_ENDPOINT,
            scope: READ_SCOPE,
            capability: LIFECYCLE_STATUS_CAPABILITY,
            subject: LIFECYCLE_STATUS_SUBJECT,
        },
        RuntimeControlOperation::LifecycleStart => RouteAuthorization {
            endpoint: LIFECYCLE_START_ENDPOINT,
            scope: WRITE_SCOPE,
            capability: LIFECYCLE_START_CAPABILITY,
            subject: LIFECYCLE_START_SUBJECT,
        },
        RuntimeControlOperation::LifecycleStop => RouteAuthorization {
            endpoint: LIFECYCLE_STOP_ENDPOINT,
            scope: WRITE_SCOPE,
            capability: LIFECYCLE_STOP_CAPABILITY,
            subject: LIFECYCLE_STOP_SUBJECT,
        },
        RuntimeControlOperation::LifecycleRestart => RouteAuthorization {
            endpoint: LIFECYCLE_RESTART_ENDPOINT,
            scope: WRITE_SCOPE,
            capability: LIFECYCLE_RESTART_CAPABILITY,
            subject: LIFECYCLE_RESTART_SUBJECT,
        },
        RuntimeControlOperation::LifecycleRepair => RouteAuthorization {
            endpoint: LIFECYCLE_REPAIR_ENDPOINT,
            scope: WRITE_SCOPE,
            capability: LIFECYCLE_REPAIR_CAPABILITY,
            subject: LIFECYCLE_REPAIR_SUBJECT,
        },
        RuntimeControlOperation::RepairStatus => RouteAuthorization {
            endpoint: REPAIR_STATUS_ENDPOINT,
            scope: READ_SCOPE,
            capability: REPAIR_STATUS_CAPABILITY,
            subject: REPAIR_STATUS_SUBJECT,
        },
        RuntimeControlOperation::Logs => RouteAuthorization {
            endpoint: LOGS_ENDPOINT,
            scope: READ_SCOPE,
            capability: LOGS_CAPABILITY,
            subject: LOGS_SUBJECT,
        },
        RuntimeControlOperation::ControlReady => RouteAuthorization {
            endpoint: CONTROL_READY_ENDPOINT,
            scope: READ_SCOPE,
            capability: CONTROL_READY_CAPABILITY,
            subject: CONTROL_READY_SUBJECT,
        },
        RuntimeControlOperation::GatewayHealth => RouteAuthorization {
            endpoint: GATEWAY_HEALTH_ENDPOINT,
            scope: READ_SCOPE,
            capability: GATEWAY_HEALTH_CAPABILITY,
            subject: GATEWAY_HEALTH_SUBJECT,
        },
        RuntimeControlOperation::GatewayStatus => RouteAuthorization {
            endpoint: GATEWAY_STATUS_ENDPOINT,
            scope: READ_SCOPE,
            capability: GATEWAY_STATUS_CAPABILITY,
            subject: GATEWAY_STATUS_SUBJECT,
        },
        RuntimeControlOperation::ControlUiUrl => RouteAuthorization {
            endpoint: CONTROL_UI_URL_ENDPOINT,
            scope: READ_SCOPE,
            capability: CONTROL_UI_URL_CAPABILITY,
            subject: CONTROL_UI_URL_SUBJECT,
        },
    };
    Some((operation, authorization))
}

fn operation_for(method: &str, path: &str) -> Option<RuntimeControlOperation> {
    match (method, path) {
        ("POST", LIFECYCLE_STATUS_ENDPOINT) => Some(RuntimeControlOperation::LifecycleStatus),
        ("POST", LIFECYCLE_START_ENDPOINT) => Some(RuntimeControlOperation::LifecycleStart),
        ("POST", LIFECYCLE_STOP_ENDPOINT) => Some(RuntimeControlOperation::LifecycleStop),
        ("POST", LIFECYCLE_RESTART_ENDPOINT) => Some(RuntimeControlOperation::LifecycleRestart),
        ("POST", LIFECYCLE_REPAIR_ENDPOINT) => Some(RuntimeControlOperation::LifecycleRepair),
        ("POST", REPAIR_STATUS_ENDPOINT) => Some(RuntimeControlOperation::RepairStatus),
        ("POST", LOGS_ENDPOINT) => Some(RuntimeControlOperation::Logs),
        ("POST", CONTROL_READY_ENDPOINT) => Some(RuntimeControlOperation::ControlReady),
        ("POST", GATEWAY_HEALTH_ENDPOINT) => Some(RuntimeControlOperation::GatewayHealth),
        ("POST", GATEWAY_STATUS_ENDPOINT) => Some(RuntimeControlOperation::GatewayStatus),
        ("POST", CONTROL_UI_URL_ENDPOINT) => Some(RuntimeControlOperation::ControlUiUrl),
        _ => None,
    }
}

async fn authorized_input(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    authorization: RouteAuthorization,
) -> Result<RuntimeControlRequest, Response> {
    let Some(token) = request.bearer_authorization() else {
        return Err(unauthorized());
    };
    if verifier
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
        return Err(unauthorized());
    }
    decode_request(&request.body).map_err(|_| Response::bad_request())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestBody {
    #[serde(deserialize_with = "deserialize_endpoint")]
    endpoint: RuntimeEndpoint,
    cursor: Option<u64>,
    probe: Option<bool>,
    include_channel_summary: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EndpointBody {
    kind: String,
    runtime_adapter_id: String,
    runtime_instance_id: String,
}

fn decode_request(body: &[u8]) -> Result<RuntimeControlRequest, serde_json::Error> {
    let body = serde_json::from_slice::<RequestBody>(body)?;
    Ok(RuntimeControlRequest {
        endpoint: body.endpoint,
        cursor: body.cursor,
        probe: body.probe,
        include_channel_summary: body.include_channel_summary,
        call: None,
    })
}

fn deserialize_endpoint<'de, D>(deserializer: D) -> Result<RuntimeEndpoint, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let endpoint = EndpointBody::deserialize(deserializer)?;
    if endpoint.kind != "native-runtime" {
        return Err(de::Error::custom("runtime endpoint kind is invalid"));
    }
    RuntimeEndpoint::try_new(endpoint.runtime_adapter_id, endpoint.runtime_instance_id)
        .map_err(|_| de::Error::custom("runtime endpoint identity is invalid"))
}

pub fn lifecycle_error_response(error: RuntimeControlLifecycleError) -> Response {
    match error {
        RuntimeControlLifecycleError::Busy => Response::error(409, "Runtime control is busy"),
        RuntimeControlLifecycleError::Unsupported => unsupported(),
        RuntimeControlLifecycleError::Unavailable => unavailable(),
        RuntimeControlLifecycleError::CommandFailed => internal_error(),
    }
}

pub fn runtime_control_error_response(error: RuntimeControlFailure) -> Response {
    match error {
        RuntimeControlFailure::Unsupported => unsupported(),
        RuntimeControlFailure::Unavailable => unavailable(),
        RuntimeControlFailure::Unknown => internal_error(),
    }
}

pub fn unavailable_response() -> Response {
    unavailable()
}

fn timeout_response() -> Response {
    Response::error(503, "Runtime Host request deadline exceeded")
}

fn unauthorized() -> Response {
    Response::error(401, "Runtime control authorization is invalid")
}

fn unsupported() -> Response {
    Response::error(422, "Runtime control operation is unsupported")
}

fn unavailable() -> Response {
    Response::error(503, "Runtime control is unavailable")
}

fn internal_error() -> Response {
    Response::error(500, "Runtime Host command failed")
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
