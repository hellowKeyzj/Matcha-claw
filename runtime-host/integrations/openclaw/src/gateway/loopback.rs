use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor as LoopbackModuleDescriptor, ModuleId as LoopbackModuleId,
        Request, RequestHead, Response, RouteDescriptor, RouteFuture, RouteHeadPlan,
    },
    module::{CapabilityKey, EffectKind, ModuleDescriptor, ModuleId as CatalogModuleId},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    gateway::request::{
        OpenClawBrowserGatewayRequest, OpenClawMcpAppGatewayRequest, decode_browser_request,
        decode_mcp_app_request,
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
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);
const MAX_EXECUTE_BYTES: usize = 1_000_000;
const BROWSER_SCOPE: &str = "openclaw.browser";
const MCP_APP_SCOPE: &str = "openclaw.mcpApp";
const BROWSER_OPERATION: &str = "browser.request";
const BROWSER_SUBJECT: &str = "openclaw-browser";
const MCP_APP_SUBJECT: &str = "openclaw-mcp-app";

pub type OpenClawGatewayCapabilityFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub trait OpenClawGatewayCapabilityPort: Send + Sync {
    fn browser_request(
        &self,
        request: OpenClawBrowserGatewayRequest,
    ) -> OpenClawGatewayCapabilityFuture<Result<OpenClawGatewayRequestOutcome, ()>>;

    fn mcp_app_request(
        &self,
        request: OpenClawMcpAppGatewayRequest,
    ) -> OpenClawGatewayCapabilityFuture<Result<OpenClawGatewayRequestOutcome, ()>>;
}

pub fn descriptor(
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    gateway: Arc<dyn OpenClawGatewayCapabilityPort>,
) -> ModuleDescriptor {
    ModuleDescriptor::with_capabilities(
        MODULE_ID,
        PROVIDES,
        REQUIRES,
        EFFECTS,
        ROUTES,
        EVENTS,
        Some(loopback_descriptor(Dependencies::new(verifier, gateway))),
        Some(super::capability::DESCRIPTOR_PROVIDER),
    )
}

#[derive(Clone)]
struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    gateway: Arc<dyn OpenClawGatewayCapabilityPort>,
}

impl Dependencies {
    fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        gateway: Arc<dyn OpenClawGatewayCapabilityPort>,
    ) -> Self {
        Self { verifier, gateway }
    }
}

fn loopback_descriptor(dependencies: Dependencies) -> LoopbackModuleDescriptor {
    LoopbackModuleDescriptor::new(
        LOOPBACK_MODULE_ID,
        vec![RouteDescriptor::bound(
            "openclaw-gateway.loopback",
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
            decoded.authorization.subject,
        )
        .is_err()
    {
        return unauthorized();
    }

    let outcome = match decoded.invocation {
        Invocation::Browser(request) => dependencies.gateway.browser_request(request).await,
        Invocation::McpApp(request) => dependencies.gateway.mcp_app_request(request).await,
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
    subject: &'static str,
}

enum Invocation {
    Browser(OpenClawBrowserGatewayRequest),
    McpApp(OpenClawMcpAppGatewayRequest),
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
                    subject: BROWSER_SUBJECT,
                },
                invocation: Invocation::Browser(
                    decode_browser_request(wire.input).map_err(|_| DecodeError)?,
                ),
            }),
            ("openclaw.mcpApp", operation_id) if operation_id.starts_with("mcp.app.") => {
                let mut input = wire.input.as_object().cloned().ok_or(DecodeError)?;
                if input.contains_key("operationId") {
                    return Err(DecodeError);
                }
                input.insert(
                    "operationId".to_owned(),
                    Value::String(wire.operation_id.clone()),
                );
                Ok(Self {
                    authorization: RouteAuthorization {
                        scope: MCP_APP_SCOPE,
                        capability: wire.operation_id,
                        subject: MCP_APP_SUBJECT,
                    },
                    invocation: Invocation::McpApp(
                        decode_mcp_app_request(Value::Object(input)).map_err(|_| DecodeError)?,
                    ),
                })
            }
            _ => Err(DecodeError),
        }
    }
}

fn response_for_outcome(outcome: OpenClawGatewayRequestOutcome) -> Response {
    match outcome {
        OpenClawGatewayRequestOutcome::Succeeded(payload) => Response::json(200, payload),
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
