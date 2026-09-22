use std::{
    future::Future,
    io,
    pin::Pin,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request as LoopbackRequest, RequestHead,
        Response as LoopbackResponse, RouteDescriptor, RouteFuture, RouteHeadPlan, RouteOutcome,
    },
};
use serde_json::Value;
use tokio::{net::TcpStream, sync::Mutex, time::timeout};

use crate::{
    owner::handle::FleetHandle,
    terminal_stream::{
        HostTicketPort, NativeProvider, ServerDependencies as TerminalServerDependencies,
    },
};

pub(crate) use dto::DecodeError;

mod authorization;
mod credentials;
mod dto;
mod mutation;
mod projection;
mod public_string;
mod read;
mod terminal;

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const REQUEST_READ_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub(crate) struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: FleetHandle,
    terminal: TerminalServerDependencies,
}

impl Dependencies {
    pub(crate) fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        owner: FleetHandle,
    ) -> Self {
        let terminal = TerminalServerDependencies::new(
            Arc::new(HostTicketPort::new(Arc::new(owner.clone()))),
            Arc::new(NativeProvider::new(Arc::new(owner.clone()))),
        );
        Self {
            verifier,
            owner,
            terminal,
        }
    }
}

pub(crate) fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("fleet"),
        vec![RouteDescriptor::bound(
            "fleet.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    if is_terminal_route(head.method.as_str(), head.path.as_str()) {
        return Some(RouteHeadPlan::new(
            BodyPolicy::Empty,
            REQUEST_READ_DEADLINE,
            timeout_response,
        ));
    }
    if is_credential_write_route(head.method.as_str(), head.path.as_str()) {
        return Some(RouteHeadPlan::new(
            BodyPolicy::Required {
                max_bytes: credentials::MAX_REQUEST_BYTES,
            },
            REQUEST_READ_DEADLINE,
            timeout_response,
        ));
    }
    if is_fleet_route(head.method.as_str(), head.path.as_str())
        || is_runtime_agent_ingress_route(head.path.as_str())
    {
        return Some(RouteHeadPlan::new(
            BodyPolicy::Required {
                max_bytes: MAX_REQUEST_BYTES,
            },
            REQUEST_READ_DEADLINE,
            timeout_response,
        ));
    }
    None
}

fn route(dependencies: Dependencies, request: LoopbackRequest) -> RouteFuture {
    Box::pin(async move {
        if is_terminal_route(request.method(), request.path()) {
            return handle_terminal_route(request, dependencies.terminal);
        }
        if !is_fleet_route(request.method(), request.path())
            && !is_credential_write_route(request.method(), request.path())
            && !is_runtime_agent_ingress_route(request.path())
        {
            return RouteOutcome::Response(into_loopback_response(Response::not_found()));
        }
        if request.body.len() > max_body_bytes(request.method(), request.path()) {
            return RouteOutcome::Response(into_loopback_response(Response::bad_request()));
        }
        let response = match timeout(
            REQUEST_READ_DEADLINE,
            handle(request, dependencies.verifier, dependencies.owner),
        )
        .await
        {
            Ok(response) => response,
            Err(_) => Response::bad_request(),
        };
        RouteOutcome::Response(into_loopback_response(response))
    })
}

fn handle_terminal_route(
    request: LoopbackRequest,
    terminal: TerminalServerDependencies,
) -> RouteOutcome {
    let Some(key) = request
        .head
        .websocket_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
    else {
        return RouteOutcome::Response(LoopbackResponse::json(
            400,
            serde_json::json!({"error":"invalid terminal websocket upgrade"}),
        ));
    };
    if !request.head.websocket || !request.body.is_empty() {
        return RouteOutcome::Response(LoopbackResponse::json(
            400,
            serde_json::json!({"error":"invalid terminal websocket upgrade"}),
        ));
    }
    RouteOutcome::Upgrade(platform::loopback::Upgrade::owned(FleetTerminalUpgrade {
        path: request.head.path,
        key,
        terminal,
    }))
}

struct FleetTerminalUpgrade {
    path: String,
    key: String,
    terminal: TerminalServerDependencies,
}

impl platform::loopback::UpgradeHandler for FleetTerminalUpgrade {
    fn serve(
        self: Box<Self>,
        stream: TcpStream,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
        Box::pin(async move {
            crate::terminal_stream::serve_upgrade(stream, self.path, self.key, true, self.terminal)
                .await
        })
    }
}

async fn handle(
    request: LoopbackRequest,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    owner: FleetHandle,
) -> Response {
    if is_runtime_agent_ingress_route(request.path()) {
        return match crate::runtime_agent_ingress::handle(
            request.method(),
            request.path(),
            request.headers(),
            &request.body,
            &owner,
        )
        .await
        {
            Some((status, body)) => Response { status, body },
            None => Response::not_found(),
        };
    }
    let Some(authorization) = request.bearer_authorization().map(str::to_owned) else {
        return Response::unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::bad_request(),
    };
    if is_credential_write_route(request.method(), request.path()) {
        let mut verifier = verifier.lock().await;
        if verifier
            .verify(
                &authorization,
                now_millis(),
                credentials::PATH,
                credentials::SCOPE,
                credentials::CAPABILITY,
                credentials::SUBJECT,
            )
            .is_err()
        {
            return Response::unauthorized();
        }
        drop(verifier);
        return credentials::handle(&owner, value).await;
    }
    let mut verifier = verifier.lock().await;
    let request = match dto::Request::decode(value, &authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    Response::from_delivery(read::read(&owner, request).await)
}

fn timeout_response() -> LoopbackResponse {
    into_loopback_response(Response::bad_request())
}

fn into_loopback_response(response: Response) -> LoopbackResponse {
    LoopbackResponse::json(response.status, response.body)
}

pub(super) struct Response {
    status: u16,
    body: Value,
}

impl Response {
    pub(super) fn bad_request() -> Self {
        Self::fixed(400, "Fleet request is invalid")
    }

    fn unauthorized() -> Self {
        Self::fixed(401, "Fleet authorization is invalid")
    }

    fn not_found() -> Self {
        Self::fixed(404, "Fleet route is not available")
    }

    pub(super) fn fixed(status: u16, error: &'static str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "success": false, "error": error }),
        }
    }

    fn from_delivery(delivery: projection::Delivery) -> Self {
        Self {
            status: delivery.status_code(),
            body: delivery.body(),
        }
    }
}

fn is_fleet_route(method: &str, path: &str) -> bool {
    method == "POST" && path == "/api/fleet"
}

fn max_body_bytes(method: &str, path: &str) -> usize {
    if is_credential_write_route(method, path) {
        credentials::MAX_REQUEST_BYTES
    } else {
        MAX_REQUEST_BYTES
    }
}

fn is_credential_write_route(method: &str, path: &str) -> bool {
    method == "POST" && path == credentials::PATH
}

fn is_terminal_route(method: &str, path: &str) -> bool {
    method == "GET"
        && (path == crate::terminal_stream::TERMINAL_WEBSOCKET_PATH
            || path == crate::terminal_stream::PRIVATE_TERMINAL_WEBSOCKET_PATH)
}

fn is_runtime_agent_ingress_route(path: &str) -> bool {
    path == crate::runtime_agent_ingress::PATH
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_is_exact() {
        assert!(is_fleet_route("POST", "/api/fleet"));
        assert!(!is_fleet_route("GET", "/api/fleet"));
        assert!(!is_fleet_route("POST", "/api/fleet?x=1"));
        assert!(is_credential_write_route("POST", credentials::PATH));
        assert!(!is_credential_write_route("GET", credentials::PATH));
        assert!(is_terminal_route(
            "GET",
            crate::terminal_stream::TERMINAL_WEBSOCKET_PATH
        ));
        assert!(is_terminal_route(
            "GET",
            crate::terminal_stream::PRIVATE_TERMINAL_WEBSOCKET_PATH
        ));
        assert!(!is_terminal_route(
            "POST",
            crate::terminal_stream::TERMINAL_WEBSOCKET_PATH
        ));
        assert!(is_runtime_agent_ingress_route(
            crate::runtime_agent_ingress::PATH
        ));
    }
}
