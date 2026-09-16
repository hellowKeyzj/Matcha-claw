use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::transport::{
    common::authorization::CapabilityDecisionVerifier, connectors::external as external_connectors,
    runtime::openclaw_mcp_servers,
};

use super::server::{AUTHORIZATION_HEADER, BEARER_PREFIX, Request, Response, now_millis};

pub(super) async fn handle_external_connectors(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    connector_handle: crate::connectors::ConnectorHandle,
) -> Response {
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::external_connectors_unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::external_connectors_bad_request(),
    };
    let command = {
        let mut verifier = verifier.lock().await;
        match external_connectors::Request::decode(
            value,
            authorization,
            &mut verifier,
            now_millis(),
        ) {
            Ok(request) => request.into_command(),
            Err(external_connectors::RequestError::Invalid) => {
                return Response::external_connectors_bad_request();
            }
            Err(external_connectors::RequestError::Unauthorized) => {
                return Response::external_connectors_unauthorized();
            }
        }
    };
    let delivery = match command {
        external_connectors::Command::List => connector_handle
            .list()
            .await
            .map(|outcome| match outcome {
                crate::runtime::external_connectors::ListOutcome::Available(connectors) => {
                    external_connectors::Delivery::List(
                        crate::runtime::external_connectors::ListOutcome::Available(
                            public_connectors(connectors),
                        ),
                    )
                }
                crate::runtime::external_connectors::ListOutcome::Unavailable => {
                    external_connectors::Delivery::Unavailable
                }
            })
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Catalog => connector_handle
            .catalog()
            .await
            .map(external_connectors::Delivery::Catalog)
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Status => connector_handle
            .status()
            .await
            .map(|outcome| match outcome {
                crate::runtime::external_connectors::StatusOutcome::Available(statuses) => {
                    external_connectors::Delivery::Status(statuses)
                }
                crate::runtime::external_connectors::StatusOutcome::Unavailable => {
                    external_connectors::Delivery::Unavailable
                }
            })
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::SessionStatus(identity) => connector_handle
            .session_status(identity)
            .await
            .map(|outcome| match outcome {
                crate::runtime::external_connectors::SessionStatusOutcome::Available(statuses) => {
                    external_connectors::Delivery::SessionStatus(public_session_statuses(statuses))
                }
                crate::runtime::external_connectors::SessionStatusOutcome::Unavailable => {
                    external_connectors::Delivery::Unavailable
                }
            })
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::SessionMcpServerEnabled(target) => connector_handle
            .set_session_mcp_server_enabled(target)
            .await
            .map(external_connectors::Delivery::SessionMcpServerEnabled)
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Probe(id) => connector_handle
            .probe(id.clone())
            .await
            .map(|outcome| match outcome {
                crate::runtime::external_connectors::ProbeOutcome::Observed(observation) => {
                    external_connectors::Delivery::Probe(id, observation)
                }
                crate::runtime::external_connectors::ProbeOutcome::Missing => {
                    external_connectors::Delivery::Missing
                }
                crate::runtime::external_connectors::ProbeOutcome::Unavailable => {
                    external_connectors::Delivery::Unavailable
                }
            })
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Get(id) => connector_handle
            .get(id)
            .await
            .map(|outcome| match outcome {
                crate::runtime::external_connectors::GetOutcome::Found(connector)
                    if is_system_runtime_connector(&connector) =>
                {
                    external_connectors::Delivery::Missing
                }
                outcome => external_connectors::Delivery::Get(outcome),
            })
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Upsert(connector) => connector_handle
            .upsert(*connector)
            .await
            .map(external_connectors::Delivery::Mutation)
            .unwrap_or(external_connectors::Delivery::Unavailable),
        external_connectors::Command::Remove(id) => connector_handle
            .remove(id)
            .await
            .map(external_connectors::Delivery::Mutation)
            .unwrap_or(external_connectors::Delivery::Unavailable),
    };
    Response::from_external_connectors_delivery(delivery)
}

fn public_connectors(
    connectors: Vec<crate::runtime::external_connectors::ConnectorReadModel>,
) -> Vec<crate::runtime::external_connectors::ConnectorReadModel> {
    connectors
        .into_iter()
        .filter(|connector| !is_system_runtime_connector(connector))
        .collect()
}

fn public_session_statuses(
    statuses: Vec<crate::runtime::external_connectors::SessionConnectorStatus>,
) -> Vec<crate::runtime::external_connectors::SessionConnectorStatus> {
    statuses
        .into_iter()
        .filter(|status| status.connector_id != "matcha")
        .collect()
}

fn is_system_runtime_connector(
    connector: &crate::runtime::external_connectors::ConnectorReadModel,
) -> bool {
    connector
        .mcp_server_program
        .as_ref()
        .is_some_and(|program| {
            matches!(
                program.source,
                crate::runtime::external_connectors::McpProgramSource::SystemRuntime
            )
        })
}

pub(super) async fn handle_openclaw_mcp_servers(
    request: Request,
    verifier: Arc<Mutex<CapabilityDecisionVerifier>>,
    connector_handle: crate::connectors::ConnectorHandle,
) -> Response {
    let Some(authorization) = request
        .headers
        .iter()
        .find(|(name, _)| name == AUTHORIZATION_HEADER)
        .and_then(|(_, value)| value.strip_prefix(BEARER_PREFIX))
    else {
        return Response::openclaw_mcp_servers_unauthorized();
    };
    let value = match serde_json::from_slice::<Value>(&request.body) {
        Ok(value) => value,
        Err(_) => return Response::openclaw_mcp_servers_bad_request(),
    };
    let command = {
        let mut verifier = verifier.lock().await;
        match openclaw_mcp_servers::Request::decode(
            value,
            authorization,
            &mut verifier,
            now_millis(),
        ) {
            Ok(request) => request.into_command(),
            Err(openclaw_mcp_servers::RequestError::Invalid) => {
                return Response::openclaw_mcp_servers_bad_request();
            }
            Err(openclaw_mcp_servers::RequestError::Unauthorized) => {
                return Response::openclaw_mcp_servers_unauthorized();
            }
        }
    };
    let delivery = match command {
        openclaw_mcp_servers::Command::List => connector_handle
            .openclaw_mcp_servers()
            .await
            .map(openclaw_mcp_servers::Delivery::List)
            .unwrap_or(openclaw_mcp_servers::Delivery::Unavailable),
    };
    Response::from_openclaw_mcp_servers_delivery(delivery)
}
