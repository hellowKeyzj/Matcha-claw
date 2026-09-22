use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use platform::{
    capability::CapabilityDecisionVerifier,
    loopback::{
        BodyPolicy, ModuleDescriptor, ModuleId, Request, RequestHead, Response, RouteDescriptor,
        RouteFuture, RouteHeadPlan,
    },
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{api::ConnectorHandle, delivery};

pub mod external;
pub mod openclaw_mcp_servers;

const CONNECTOR_REQUEST_BYTES: usize = 64 * 1024;
const SHORT_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Dependencies {
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    connector: ConnectorHandle,
}

impl Dependencies {
    pub fn new(
        verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
        connector: ConnectorHandle,
    ) -> Self {
        Self {
            verifier,
            connector,
        }
    }
}

pub fn descriptor(dependencies: Dependencies) -> ModuleDescriptor {
    ModuleDescriptor::new(
        ModuleId::new("connectors"),
        vec![RouteDescriptor::bound(
            "connectors.loopback",
            head_plan,
            move |request| route(dependencies.clone(), request),
        )],
    )
}

fn head_plan(head: &RequestHead) -> Option<RouteHeadPlan> {
    let path = pathname(&head.path);
    matches!(path, external::ENDPOINT | openclaw_mcp_servers::ENDPOINT).then(|| {
        RouteHeadPlan::new(
            body_policy_for_method(head.method.as_str(), CONNECTOR_REQUEST_BYTES),
            SHORT_DEADLINE,
            timeout_response,
        )
    })
}

fn route(dependencies: Dependencies, request: Request) -> RouteFuture {
    Box::pin(async move {
        let response = match pathname(request.path()) {
            external::ENDPOINT if request.method() == "POST" => {
                handle_external_connectors(request, dependencies).await
            }
            openclaw_mcp_servers::ENDPOINT if request.method() == "POST" => {
                handle_openclaw_mcp_servers(request, dependencies).await
            }
            _ => Response::not_found(),
        };
        response.into()
    })
}

async fn handle_external_connectors(request: Request, dependencies: Dependencies) -> Response {
    let Some(authorization) = request.bearer_authorization() else {
        return fixed(401, "External connector authorization is invalid");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return fixed(400, "External connector request is invalid"),
    };
    let command = {
        let mut verifier = dependencies.verifier.lock().await;
        match external::Request::decode(value, authorization, &mut verifier, now_millis()) {
            Ok(request) => request.into_command(),
            Err(external::RequestError::Invalid) => {
                return fixed(400, "External connector request is invalid");
            }
            Err(external::RequestError::Unauthorized) => {
                return fixed(401, "External connector authorization is invalid");
            }
        }
    };
    let delivery = match command {
        external::Command::List => dependencies
            .connector
            .list()
            .await
            .map(|outcome| match outcome {
                delivery::ListOutcome::Available(connectors) => external::Delivery::List(
                    delivery::ListOutcome::Available(public_connectors(connectors)),
                ),
                delivery::ListOutcome::Unavailable => external::Delivery::Unavailable,
            })
            .unwrap_or(external::Delivery::Unavailable),
        external::Command::Catalog => dependencies
            .connector
            .catalog()
            .await
            .map(external::Delivery::Catalog)
            .unwrap_or(external::Delivery::Unavailable),
        external::Command::Status => dependencies
            .connector
            .status()
            .await
            .map(|outcome| match outcome {
                delivery::StatusOutcome::Available(statuses) => {
                    external::Delivery::Status(statuses)
                }
                delivery::StatusOutcome::Unavailable => external::Delivery::Unavailable,
            })
            .unwrap_or(external::Delivery::Unavailable),
        external::Command::SessionStatus(identity) => dependencies
            .connector
            .session_status(identity)
            .await
            .map(|outcome| match outcome {
                delivery::SessionStatusOutcome::Available(statuses) => {
                    external::Delivery::SessionStatus(public_session_statuses(statuses))
                }
                delivery::SessionStatusOutcome::Unavailable => external::Delivery::Unavailable,
            })
            .unwrap_or(external::Delivery::Unavailable),
        external::Command::SessionMcpServerEnabled(target) => dependencies
            .connector
            .set_session_mcp_server_enabled(target)
            .await
            .map(external::Delivery::SessionMcpServerEnabled)
            .unwrap_or(external::Delivery::Unavailable),
        external::Command::Probe(id) => dependencies
            .connector
            .probe(id.clone())
            .await
            .map(|outcome| match outcome {
                delivery::ProbeOutcome::Observed(observation) => {
                    external::Delivery::Probe(id, observation)
                }
                delivery::ProbeOutcome::Missing => external::Delivery::Missing,
                delivery::ProbeOutcome::Unavailable => external::Delivery::Unavailable,
            })
            .unwrap_or(external::Delivery::Unavailable),
        external::Command::Get(id) => dependencies
            .connector
            .get(id)
            .await
            .map(|outcome| match outcome {
                delivery::GetOutcome::Found(connector)
                    if is_system_runtime_connector(&connector) =>
                {
                    external::Delivery::Missing
                }
                outcome => external::Delivery::Get(outcome),
            })
            .unwrap_or(external::Delivery::Unavailable),
        external::Command::Upsert(connector) => dependencies
            .connector
            .upsert(*connector)
            .await
            .map(external::Delivery::Mutation)
            .unwrap_or(external::Delivery::Unavailable),
        external::Command::Remove(id) => dependencies
            .connector
            .remove(id)
            .await
            .map(external::Delivery::Mutation)
            .unwrap_or(external::Delivery::Unavailable),
    };
    Response::json(delivery.status_code(), delivery.body())
}

async fn handle_openclaw_mcp_servers(request: Request, dependencies: Dependencies) -> Response {
    let Some(authorization) = request.bearer_authorization() else {
        return fixed(401, "OpenClaw MCP servers authorization is invalid");
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return fixed(400, "OpenClaw MCP servers request is invalid"),
    };
    let command = {
        let mut verifier = dependencies.verifier.lock().await;
        match openclaw_mcp_servers::Request::decode(
            value,
            authorization,
            &mut verifier,
            now_millis(),
        ) {
            Ok(request) => request.into_command(),
            Err(openclaw_mcp_servers::RequestError::Invalid) => {
                return fixed(400, "OpenClaw MCP servers request is invalid");
            }
            Err(openclaw_mcp_servers::RequestError::Unauthorized) => {
                return fixed(401, "OpenClaw MCP servers authorization is invalid");
            }
        }
    };
    let delivery = match command {
        openclaw_mcp_servers::Command::List => dependencies
            .connector
            .openclaw_mcp_servers()
            .await
            .map(openclaw_mcp_servers::Delivery::List)
            .unwrap_or(openclaw_mcp_servers::Delivery::Unavailable),
    };
    Response::json(delivery.status_code(), delivery.body())
}

fn public_connectors(
    connectors: Vec<delivery::ConnectorReadModel>,
) -> Vec<delivery::ConnectorReadModel> {
    connectors
        .into_iter()
        .filter(|connector| !is_system_runtime_connector(connector))
        .collect()
}

fn public_session_statuses(
    statuses: Vec<delivery::SessionConnectorStatus>,
) -> Vec<delivery::SessionConnectorStatus> {
    statuses
        .into_iter()
        .filter(|status| status.connector_id != "matcha")
        .collect()
}

fn is_system_runtime_connector(connector: &delivery::ConnectorReadModel) -> bool {
    connector
        .mcp_server_program
        .as_ref()
        .is_some_and(|program| matches!(program.source, delivery::McpProgramSource::SystemRuntime))
}

fn body_policy_for_method(method: &str, max_bytes: usize) -> BodyPolicy {
    if method == "GET" {
        BodyPolicy::Empty
    } else if method == "POST" {
        BodyPolicy::Required { max_bytes }
    } else {
        BodyPolicy::Optional {
            max_bytes: 64 * 1024,
        }
    }
}

fn fixed(status: u16, error: &'static str) -> Response {
    Response::json(status, json!({ "success": false, "error": error }))
}

fn timeout_response() -> Response {
    fixed(503, "Runtime Host request deadline exceeded")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn pathname(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}
