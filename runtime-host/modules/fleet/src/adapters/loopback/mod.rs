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
use tokio::{net::TcpStream, sync::Mutex};

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
            let call = match begin_call(
                &dependencies.owner,
                "fleet.terminals.stream",
                Default::default(),
            )
            .await
            {
                Ok(call) => call,
                Err(response) => return RouteOutcome::Response(into_loopback_response(response)),
            };
            return handle_terminal_route(request, dependencies.terminal, call).await;
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
        let response = handle(request, dependencies.verifier, dependencies.owner).await;
        RouteOutcome::Response(into_loopback_response(response))
    })
}

async fn handle_terminal_route(
    request: LoopbackRequest,
    terminal: TerminalServerDependencies,
    call: Option<crate::call::FleetCall>,
) -> RouteOutcome {
    let Some(key) = request
        .head
        .websocket_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
    else {
        if let Some(call) = &call {
            call.outcome("rejected", platform::call::CallStatus::Rejected)
                .await;
        }
        return RouteOutcome::Response(LoopbackResponse::json(
            400,
            serde_json::json!({"error":"invalid terminal websocket upgrade"}),
        ));
    };
    if !request.head.websocket || !request.body.is_empty() {
        if let Some(call) = &call {
            call.outcome("rejected", platform::call::CallStatus::Rejected)
                .await;
        }
        return RouteOutcome::Response(LoopbackResponse::json(
            400,
            serde_json::json!({"error":"invalid terminal websocket upgrade"}),
        ));
    }
    RouteOutcome::Upgrade(platform::loopback::Upgrade::owned(FleetTerminalUpgrade {
        path: request.head.path,
        key,
        terminal,
        call,
    }))
}

struct FleetTerminalUpgrade {
    path: String,
    key: String,
    terminal: TerminalServerDependencies,
    call: Option<crate::call::FleetCall>,
}

impl platform::loopback::UpgradeHandler for FleetTerminalUpgrade {
    fn serve(
        self: Box<Self>,
        stream: TcpStream,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send>> {
        Box::pin(async move {
            if let Some(call) = &self.call {
                if call.running().await.is_err() {
                    return Err(io::Error::other("Fleet call audit is unavailable"));
                }
            }
            let result = crate::terminal_stream::serve_upgrade(
                stream,
                self.path,
                self.key,
                true,
                self.terminal,
            )
            .await;
            if let Some(call) = &self.call {
                call.finish(&result).await;
            }
            result
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
        let call = match begin_call(&owner, "fleet.credentials.write", Default::default()).await {
            Ok(call) => call,
            Err(response) => return response,
        };
        let response = credentials::handle(&owner.recording(call.clone()), value).await;
        if let Some(call) = &call {
            if !call.admitted.load(std::sync::atomic::Ordering::Acquire) {
                call.outcome("rejected", platform::call::CallStatus::Rejected)
                    .await;
            }
        }
        return response;
    }
    let detail = call_detail(&value);
    let mut verifier = verifier.lock().await;
    let request = match dto::Request::decode(value, &authorization, &mut verifier, now_millis()) {
        Ok(request) => request,
        Err(DecodeError::Unauthorized) => return Response::unauthorized(),
        Err(DecodeError::Invalid) => return Response::bad_request(),
    };
    drop(verifier);
    let command = operation_name(request.operation);
    let call = match begin_call(&owner, command, detail).await {
        Ok(call) => call,
        Err(response) => return response,
    };
    let mut delivery = read::read(&owner.recording(call.clone()), request).await;
    if let Some(call) = &call {
        if let projection::Delivery::Mutation(body) = &mut delivery {
            if body["outcome"] == "accepted"
                && call.admitted.load(std::sync::atomic::Ordering::Acquire)
            {
                if let Some(body) = body.as_object_mut() {
                    body.insert(
                        "callId".to_owned(),
                        serde_json::json!(call.context.id().as_str()),
                    );
                    body.insert("accepted".to_owned(), serde_json::json!(true));
                }
            }
        }
        if !call.admitted.load(std::sync::atomic::Ordering::Acquire) {
            let (outcome, status) = match &delivery {
                projection::Delivery::Invalid => ("rejected", platform::call::CallStatus::Rejected),
                projection::Delivery::Unavailable => {
                    ("unavailable", platform::call::CallStatus::Unknown)
                }
                _ => ("completed", platform::call::CallStatus::Succeeded),
            };
            call.outcome(outcome, status).await;
        }
    }
    let mut response = Response::from_delivery(delivery);
    if command == "fleet.resources.register"
        && response.body["outcome"] == "accepted"
        && response.body["accepted"] == true
    {
        response.status = 202;
    }
    response
}

async fn begin_call(
    owner: &FleetHandle,
    command: &'static str,
    detail: crate::call::FleetCallDetail,
) -> Result<Option<crate::call::FleetCall>, Response> {
    match owner.recorder() {
        Some(recorder) => recorder
            .begin(command, &detail)
            .await
            .map(|context| {
                Some(crate::call::FleetCall {
                    context,
                    detail,
                    command,
                    started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    admitted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                })
            })
            .map_err(|_| Response::fixed(503, "Fleet call recording is unavailable")),
        None => Ok(None),
    }
}

fn operation_name(operation: dto::Operation) -> &'static str {
    use dto::Operation;
    match operation {
        Operation::TargetsList => "fleet.targets.list",
        Operation::TargetPut => "fleet.targets.put",
        Operation::TargetRemove => "fleet.targets.remove",
        Operation::TopologyGet => "fleet.topology.get",
        Operation::CommandSubmit => "fleet.commands.submit",
        Operation::NodeCommandSubmit => "fleet.commands.submit.node",
        Operation::CommandBegin => "fleet.commands.begin",
        Operation::CommandAccept => "fleet.commands.accept",
        Operation::CommandReject => "fleet.commands.reject",
        Operation::CommandUnknown => "fleet.commands.unknown",
        Operation::CommandReplay => "fleet.commands.replay",
        Operation::ConnectionUpsert => "fleet.connections.upsert",
        Operation::ConnectionRemove => "fleet.connections.remove",
        Operation::EnvironmentRegister => "fleet.environments.register",
        Operation::ResourceRegister => "fleet.resources.register",
        Operation::NodeUpsert => "fleet.nodes.upsert",
        Operation::AgentUpsert => "fleet.agents.upsert",
        Operation::AgentRevoke => "fleet.agents.revoke",
        Operation::RuntimeUpsert => "fleet.runtimes.upsert",
        Operation::EndpointUpsert => "fleet.endpoints.upsert",
        Operation::ConnectionProbeBegin => "fleet.connections.probe.begin",
        Operation::ConnectionProbeComplete => "fleet.connections.probe.complete",
        Operation::EnvironmentDeployBegin => "fleet.environments.deploy.begin",
        Operation::EnvironmentDeployComplete => "fleet.environments.deploy.complete",
        Operation::EnvironmentDeployFail => "fleet.environments.deploy.fail",
        Operation::EnvironmentDeleteBegin => "fleet.environments.delete.begin",
        Operation::EnvironmentDeleteComplete => "fleet.environments.delete.complete",
        Operation::EnvironmentDeleteFail => "fleet.environments.delete.fail",
        Operation::ResourceProvisionBegin => "fleet.resources.provision.begin",
        Operation::ResourceProvisionComplete => "fleet.resources.provision.complete",
        Operation::ResourceDeleteBegin => "fleet.resources.delete.begin",
        Operation::ResourceDeleteComplete => "fleet.resources.delete.complete",
        Operation::ResourceDeleteFail => "fleet.resources.delete.fail",
        Operation::NodeRetire => "fleet.nodes.retire",
        Operation::RuntimeStartBegin => "fleet.runtimes.start.begin",
        Operation::RuntimeStartComplete => "fleet.runtimes.start.complete",
        Operation::RuntimeStopBegin => "fleet.runtimes.stop.begin",
        Operation::RuntimeStopComplete => "fleet.runtimes.stop.complete",
        Operation::RuntimeRetire => "fleet.runtimes.retire",
        Operation::EndpointDrain => "fleet.endpoints.drain",
        Operation::EndpointRetire => "fleet.endpoints.retire",
        Operation::EndpointProbeBegin => "fleet.endpoints.probe.begin",
        Operation::CapabilitySyncBegin => "fleet.capabilities.sync.begin",
        Operation::CapabilitySyncComplete => "fleet.capabilities.sync.complete",
        Operation::TerminalOpen => "fleet.terminals.open",
        Operation::TerminalReconnect => "fleet.terminals.reconnect",
        Operation::TerminalBeginClose => "fleet.terminals.close.begin",
        Operation::TerminalFinishClose => "fleet.terminals.close.complete",
        Operation::TerminalClose => "fleet.terminals.close",
        Operation::TerminalList => "fleet.terminals.list",
        Operation::ConnectionsList => "fleet.connections.list",
        Operation::CapabilitiesList => "fleet.capabilities.list",
        Operation::EnvironmentsList => "fleet.environments.list",
        Operation::ResourcesList => "fleet.resources.list",
        Operation::CommandsList => "fleet.commands.list",
        Operation::AuditList => "fleet.audit.list",
        Operation::LeasesList => "fleet.leases.list",
        Operation::MetricsGet => "fleet.metrics.get",
        Operation::SnapshotGet => "fleet.snapshot.get",
        Operation::SelectorPreview => "fleet.selector.preview",
    }
}

fn call_detail(value: &Value) -> crate::call::FleetCallDetail {
    let payload = &value["input"]["payload"];
    let reference = |key: &str| {
        payload[key]
            .as_str()
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 128
                    && value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':')
                    })
            })
            .map(str::to_owned)
    };
    crate::call::FleetCallDetail {
        target_id: payload["selector"]["targetId"].as_str().and_then(|value| {
            (!value.is_empty()
                && value.len() <= 128
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':')
                }))
            .then(|| value.to_owned())
        }),
        entity_id: reference("id")
            .or_else(|| reference("nodeId"))
            .or_else(|| reference("sessionId")),
        command_id: reference("commandId"),
        dispatch_id: reference("dispatchId"),
        attempt: payload["attempt"]
            .as_u64()
            .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991),
        outcome: None,
    }
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
