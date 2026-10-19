use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use platform::{
    call::{CallContext, CallDetail, CallLogError, CallRecorder, CallStatus},
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor as LoopbackModuleDescriptor, ModuleId as LoopbackModuleId,
        Request, RequestHead, Response, RouteDescriptor, RouteFuture, RouteHeadPlan, RoutePath,
    },
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId as CatalogModuleId},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    gateway::request::{
        OpenClawBrowserGatewayRequest, OpenClawMcpAppGatewayRequest, OpenClawCanvasGatewayRequest, OpenClawProgressCardGatewayRequest,
        OpenClawQuestionListGatewayRequest, OpenClawQuestionResolveGatewayRequest,
        decode_browser_request, decode_mcp_app_request, decode_canvas_request, decode_progress_card_request, is_mcp_app_operation_id,
        decode_question_list_request, decode_question_resolve_request,
    },
    port::OpenClawGatewayRequestOutcome,
};

const MODULE_ID: CatalogModuleId = CatalogModuleId::new("openclaw-gateway");
const LOOPBACK_MODULE_ID: LoopbackModuleId = LoopbackModuleId::new("openclaw-gateway");
const PROVIDES: &[CapabilityKey] = &[CapabilityKey::new("openclaw.gateway")];
const REQUIRES: &[CapabilityKey] = &[];
const EFFECTS: &[EffectKind] = &[EffectKind::Route, EffectKind::RuntimeOperation];
const ROUTES: &[&str] = &["openclaw-gateway.loopback"];
const EVENTS: &[&str] = &[];

const EXECUTE_ENDPOINT: &str = "/api/capabilities/execute";
const PATHS: &[RoutePath] = &[RoutePath::ExactWithQuery(EXECUTE_ENDPOINT)];
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);
const MAX_EXECUTE_BYTES: usize = 1_000_000;
const BROWSER_SCOPE: &str = "openclaw.browser";
const MCP_APP_SCOPE: &str = "openclaw.mcpApp";
const CANVAS_SCOPE: &str = "openclaw.canvas";
const CANVAS_OPERATION: &str = "canvas.document.view";
const QUESTION_SCOPE: &str = "openclaw.question";
const BROWSER_OPERATION: &str = "browser.request";
const QUESTION_LIST_OPERATION: &str = "question.list";
const QUESTION_RESOLVE_OPERATION: &str = "question.resolve";
const BROWSER_SUBJECT: &str = "openclaw-browser";
const QUESTION_SUBJECT: &str = "openclaw-question";

#[derive(Clone, Copy, Serialize)]
pub enum GatewayOperation {
    #[serde(rename = "browser.request")]
    BrowserRequest,
    #[serde(rename = "mcp.app.request")]
    McpAppRequest,
    #[serde(rename = "canvas.document.view")]
    CanvasRequest,
    #[serde(rename = "question.resolve")]
    QuestionResolve,
}

#[derive(Clone, Serialize)]
pub struct GatewayCallDetail {
    runtime: &'static str,
    operation: GatewayOperation,
}

impl CallDetail for GatewayCallDetail {
    const MODULE: &'static str = "openclaw-gateway";
}

pub type GatewayCallContext = CallContext<GatewayCallDetail>;

pub async fn begin_gateway_call(
    calls: &CallRecorder,
    operation: GatewayOperation,
) -> Result<GatewayCallContext, CallLogError> {
    let command = match operation {
        GatewayOperation::BrowserRequest => "browser.request",
        GatewayOperation::McpAppRequest => "mcp.app.request",
        GatewayOperation::CanvasRequest => "canvas.document.view",
        GatewayOperation::QuestionResolve => "question.resolve",
    };
    calls.begin(command, &GatewayCallDetail { runtime: "openclaw", operation }).await
}

pub async fn finish_gateway_call(
    call: &GatewayCallContext,
    operation: GatewayOperation,
    outcome: &OpenClawGatewayRequestOutcome,
) -> Result<(), CallLogError> {
    let status = match outcome {
        OpenClawGatewayRequestOutcome::Succeeded(_) => CallStatus::Succeeded,
        OpenClawGatewayRequestOutcome::Rejected
        | OpenClawGatewayRequestOutcome::CapacityExhausted
        | OpenClawGatewayRequestOutcome::Unavailable => CallStatus::Rejected,
        OpenClawGatewayRequestOutcome::OutcomeUnknown => CallStatus::Unknown,
        OpenClawGatewayRequestOutcome::SurfaceRejected(failure) => {
            if *failure == crate::port::OpenClawSurfaceFailure::OutcomeUnknown {
                CallStatus::Unknown
            } else {
                CallStatus::Rejected
            }
        },
    };
    finish_gateway_call_status(call, operation, status).await
}

pub async fn finish_gateway_call_status(
    call: &GatewayCallContext,
    operation: GatewayOperation,
    status: CallStatus,
) -> Result<(), CallLogError> {
    call.finish(status, &GatewayCallDetail { runtime: "openclaw", operation }).await
}

pub type OpenClawGatewayCapabilityFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub trait OpenClawGatewayCapabilityPort: Send + Sync {
    fn browser_request(
        &self,
        request: OpenClawBrowserGatewayRequest,
        call: Option<GatewayCallContext>,
    ) -> OpenClawGatewayCapabilityFuture<Result<OpenClawGatewayRequestOutcome, ()>>;

    fn mcp_app_request(
        &self,
        request: OpenClawMcpAppGatewayRequest,
        call: Option<GatewayCallContext>,
    ) -> OpenClawGatewayCapabilityFuture<Result<OpenClawGatewayRequestOutcome, ()>>;

    fn canvas_request(
        &self,
        request: OpenClawCanvasGatewayRequest,
        call: Option<GatewayCallContext>,
    ) -> OpenClawGatewayCapabilityFuture<Result<OpenClawGatewayRequestOutcome, ()>>;

    fn progress_card_request(
        &self,
        request: OpenClawProgressCardGatewayRequest,
    ) -> OpenClawGatewayCapabilityFuture<Result<OpenClawGatewayRequestOutcome, ()>>;

    fn question_list(
        &self,
        request: OpenClawQuestionListGatewayRequest,
    ) -> OpenClawGatewayCapabilityFuture<Result<OpenClawGatewayRequestOutcome, ()>>;

    fn question_resolve(
        &self,
        request: OpenClawQuestionResolveGatewayRequest,
        call: Option<GatewayCallContext>,
    ) -> OpenClawGatewayCapabilityFuture<Result<OpenClawGatewayRequestOutcome, ()>>;
}

pub fn descriptor(
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    gateway: Arc<dyn OpenClawGatewayCapabilityPort>,
) -> ModuleDescriptor {
    build_descriptor(verifier, gateway, None)
}

pub fn descriptor_with_calls(
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    gateway: Arc<dyn OpenClawGatewayCapabilityPort>,
    calls: CallRecorder,
) -> ModuleDescriptor {
    build_descriptor(verifier, gateway, Some(calls))
}

fn build_descriptor(
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    gateway: Arc<dyn OpenClawGatewayCapabilityPort>,
    calls: Option<CallRecorder>,
) -> ModuleDescriptor {
    ModuleDescriptor::with_capabilities(
        MODULE_ID,
        PROVIDES,
        REQUIRES,
        EFFECTS,
        ROUTES,
        EVENTS,
        Some(loopback_descriptor(Dependencies { verifier, gateway, calls })),
        Some(super::capability::DESCRIPTOR_PROVIDER),
    )
}

#[derive(Clone)]
struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    gateway: Arc<dyn OpenClawGatewayCapabilityPort>,
    calls: Option<CallRecorder>,
}

fn loopback_descriptor(dependencies: Dependencies) -> LoopbackModuleDescriptor {
    LoopbackModuleDescriptor::new(
        LOOPBACK_MODULE_ID,
        vec![RouteDescriptor::bound(
            "openclaw-gateway.loopback",
            PATHS,
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    (pathname(&head.path) == EXECUTE_ENDPOINT).then(|| {
        RouteHeadPlan::new(
            if head.method == "POST" {
                BodyPolicy::Required {
                    max_bytes: MAX_EXECUTE_BYTES,
                }
            } else {
                BodyPolicy::Optional {
                    max_bytes: MAX_EXECUTE_BYTES,
                }
            },
            DEFAULT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move { handle(dependencies, request).await.into() })
}

async fn handle(dependencies: Dependencies, request: Request) -> Response {
    if request.method() != "POST" || pathname(request.path()) != EXECUTE_ENDPOINT {
        return Response::not_found();
    }
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return invalid_request(),
    };
    let decoded = match DecodeRequest::decode(value) {
        Ok(decoded) => decoded,
        Err(_) => return invalid_request(),
    };
    let Some(authorization) = request.bearer_authorization() else {
        return unauthorized();
    };
    if dependencies
        .verifier
        .lock()
        .await
        .verify(
            authorization,
            now_millis(),
            EXECUTE_ENDPOINT,
            decoded.authorization.scope,
            decoded.authorization.capability.as_str(),
            &decoded.authorization.subject,
        )
        .is_err()
    {
        return unauthorized();
    }

    if let Invocation::ProgressCard(request) = decoded.invocation {
        return match dependencies.gateway.progress_card_request(request).await {
            Ok(outcome) => response_for_outcome(outcome),
            Err(_) => response_for_outcome(OpenClawGatewayRequestOutcome::SurfaceRejected(crate::port::OpenClawSurfaceFailure::Unavailable)),
        };
    }
    if let Invocation::QuestionList(request) = decoded.invocation {
        return match dependencies.gateway.question_list(request).await {
            Ok(outcome) => response_for_outcome(outcome),
            Err(_) => unavailable(),
        };
    }
    let operation = match &decoded.invocation {
        Invocation::Browser(_) => GatewayOperation::BrowserRequest,
        Invocation::McpApp(_) => GatewayOperation::McpAppRequest,
        Invocation::Canvas(_) => GatewayOperation::CanvasRequest,
        Invocation::QuestionResolve(_) => GatewayOperation::QuestionResolve,
        Invocation::QuestionList(_) | Invocation::ProgressCard(_) => unreachable!("reads return before mutation audit"),
    };
    let call = match &dependencies.calls {
        Some(calls) => match begin_gateway_call(calls, operation).await {
            Ok(call) => Some(call),
            Err(_) => return unavailable(),
        },
        None => None,
    };
    let outcome = match decoded.invocation {
        Invocation::Browser(request) => dependencies.gateway.browser_request(request, call).await,
        Invocation::McpApp(request) => dependencies.gateway.mcp_app_request(request, call).await,
        Invocation::Canvas(request) => dependencies.gateway.canvas_request(request, call).await,
        Invocation::QuestionResolve(request) => dependencies.gateway.question_resolve(request, call).await,
        Invocation::QuestionList(_) | Invocation::ProgressCard(_) => unreachable!("reads return before mutation audit"),
    };
    match outcome {
        Ok(outcome) => response_for_outcome(outcome),
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecuteWire {
    id: String,
    operation_id: String,
    scope: Value,
    target: Value,
    input: Value,
}

struct DecodeRequest {
    authorization: RouteAuthorization,
    invocation: Invocation,
}

struct RouteAuthorization {
    scope: &'static str,
    capability: String,
    subject: String,
}

enum Invocation {
    Browser(OpenClawBrowserGatewayRequest),
    McpApp(OpenClawMcpAppGatewayRequest),
    Canvas(OpenClawCanvasGatewayRequest),
    ProgressCard(OpenClawProgressCardGatewayRequest),
    QuestionList(OpenClawQuestionListGatewayRequest),
    QuestionResolve(OpenClawQuestionResolveGatewayRequest),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DecodeError;

impl DecodeRequest {
    fn decode(value: Value) -> Result<Self, DecodeError> {
        let wire = serde_json::from_value::<ExecuteWire>(value).map_err(|_| DecodeError)?;
        if wire.scope != native_runtime_instance_scope() || !wire.target.is_null() {
            return Err(DecodeError);
        }
        match (wire.id.as_str(), wire.operation_id.as_str()) {
            ("openclaw.browser", BROWSER_OPERATION) => Ok(Self {
                authorization: RouteAuthorization {
                    scope: BROWSER_SCOPE,
                    capability: BROWSER_OPERATION.to_owned(),
                    subject: BROWSER_SUBJECT.to_owned(),
                },
                invocation: Invocation::Browser(
                    decode_browser_request(wire.input).map_err(|_| DecodeError)?,
                ),
            }),
            ("openclaw.mcpApp", operation_id) if is_mcp_app_operation_id(operation_id) => {
                let request = decode_mcp_app_request(surface_input(wire.input, &wire.operation_id)?)
                    .map_err(|_| DecodeError)?;
                Ok(Self {
                    authorization: RouteAuthorization {
                        scope: MCP_APP_SCOPE,
                        capability: wire.operation_id,
                        subject: surface_subject(&request.session_identity)?,
                    },
                    invocation: Invocation::McpApp(request),
                })
            }
            ("openclaw.canvas", CANVAS_OPERATION) => {
                let request = decode_canvas_request(surface_input(wire.input, &wire.operation_id)?)
                    .map_err(|_| DecodeError)?;
                Ok(Self {
                    authorization: RouteAuthorization {
                        scope: CANVAS_SCOPE,
                        capability: wire.operation_id,
                        subject: surface_subject(&request.session_identity)?,
                    },
                    invocation: Invocation::Canvas(request),
                })
            }
            ("openclaw.progress", "progressCard.get") => {
                let request = decode_progress_card_request(surface_input(wire.input, &wire.operation_id)?)
                    .map_err(|_| DecodeError)?;
                Ok(Self {
                    authorization: RouteAuthorization {
                        scope: "openclaw.progress",
                        capability: wire.operation_id,
                        subject: surface_subject(&request.session_identity)?,
                    },
                    invocation: Invocation::ProgressCard(request),
                })
            }
            ("openclaw.question", QUESTION_LIST_OPERATION) => Ok(Self {
                authorization: RouteAuthorization {
                    scope: QUESTION_SCOPE,
                    capability: QUESTION_LIST_OPERATION.to_owned(),
                    subject: QUESTION_SUBJECT.to_owned(),
                },
                invocation: Invocation::QuestionList(
                    decode_question_list_request(wire.input).map_err(|_| DecodeError)?,
                ),
            }),
            ("openclaw.question", QUESTION_RESOLVE_OPERATION) => Ok(Self {
                authorization: RouteAuthorization {
                    scope: QUESTION_SCOPE,
                    capability: QUESTION_RESOLVE_OPERATION.to_owned(),
                    subject: QUESTION_SUBJECT.to_owned(),
                },
                invocation: Invocation::QuestionResolve(
                    decode_question_resolve_request(wire.input).map_err(|_| DecodeError)?,
                ),
            }),
            _ => Err(DecodeError),
        }
    }
}

fn surface_input(input: Value, operation_id: &str) -> Result<Value, DecodeError> {
    let input = input.as_object().ok_or(DecodeError)?;
    if input.get("operationId").and_then(Value::as_str) != Some(operation_id) { return Err(DecodeError); }
    Ok(Value::Object(input.clone()))
}

fn surface_subject(identity: &sessions_module::state::SessionIdentity) -> Result<String, DecodeError> {
    use platform::endpoint::runtime_address::{RuntimeEndpoint, SessionIdentity};
    let endpoint = RuntimeEndpoint::try_new("openclaw", "local").map_err(|_| DecodeError)?;
    Ok(SessionIdentity::try_new(endpoint, &identity.agent_id, &identity.session_key)
        .map_err(|_| DecodeError)?.canonical_key())
}

fn response_for_outcome(outcome: OpenClawGatewayRequestOutcome) -> Response {
    match outcome {
        OpenClawGatewayRequestOutcome::Succeeded(payload) => Response::json(200, payload),
        OpenClawGatewayRequestOutcome::SurfaceRejected(failure) => Response::json(
            failure.http_status(), json!({ "error": failure.public_error() }),
        ),
        OpenClawGatewayRequestOutcome::CapacityExhausted => Response::json(
            409,
            json!({ "success": false, "error": "OpenClaw Gateway request capacity is exhausted" }),
        ),
        OpenClawGatewayRequestOutcome::Rejected
        | OpenClawGatewayRequestOutcome::Unavailable
        | OpenClawGatewayRequestOutcome::OutcomeUnknown => unavailable(),
    }
}

fn invalid_request() -> Response {
    Response::error(400, "OpenClaw gateway capability request is invalid")
}

fn unauthorized() -> Response {
    Response::error(401, "OpenClaw gateway capability authorization is invalid")
}

fn unavailable() -> Response {
    Response::error(503, "OpenClaw gateway capability is unavailable")
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

fn native_runtime_instance_scope() -> Value {
    json!({
        "kind": "runtime-instance",
        "endpoint": {
            "kind": "native-runtime",
            "runtimeAdapterId": "openclaw",
            "runtimeInstanceId": "local",
        },
    })
}
