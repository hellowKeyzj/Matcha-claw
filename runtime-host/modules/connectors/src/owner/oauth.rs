use std::sync::{Arc, RwLock};

use platform::{call::CallStatus, endpoint::runtime_address::RuntimeEndpoint};

use crate::{
    adapters::store::ConnectorStoreSnapshot,
    call::{CallResult, ConnectorCall},
    domain::{self, Connector, ConnectorCatalog, ConnectorKind, McpAuth},
    ports::{ConnectorOperationFailure, ConnectorRuntimeDirectory, McpOAuthRequest},
    projection,
};

use super::observations::{ObservationResult, ObservationResults};

pub(super) async fn execute(
    snapshot: &RwLock<Arc<ConnectorStoreSnapshot>>,
    observations: &ObservationResults,
    runtime_directory: &dyn ConnectorRuntimeDirectory,
    endpoint: RuntimeEndpoint,
    connector_id: String,
    request: McpOAuthRequest,
    mut call: ConnectorCall,
) {
    if call.start().await.is_err() {
        observations.discard(call.context.id());
        call.detail.result = Some(CallResult::Unavailable);
        call.finish(CallStatus::Failed).await;
        return;
    }
    let snapshot = Arc::clone(&snapshot.read().expect("connector snapshot lock"));
    let Some(connector) = oauth_connector(snapshot.catalog(), &connector_id) else {
        observations.discard(call.context.id());
        call.detail.result = Some(CallResult::Rejected);
        call.finish(CallStatus::Rejected).await;
        return;
    };
    let outcome = match runtime_directory.connector_ops_for_endpoint(&endpoint) {
        Some(ops) => ops.mcp_oauth(connector, request).await,
        None => Err(ConnectorOperationFailure::Unavailable),
    };
    let status = match outcome {
        Ok(oauth) => {
            observations.complete(
                call.context.id(),
                ObservationResult::OAuth { connector_id, oauth },
            );
            call.detail.result = Some(CallResult::Available);
            CallStatus::Succeeded
        }
        Err(ConnectorOperationFailure::Unknown) => {
            observations.discard(call.context.id());
            call.detail.result = Some(CallResult::Unknown);
            CallStatus::Unknown
        }
        Err(ConnectorOperationFailure::Unavailable) => {
            observations.discard(call.context.id());
            call.detail.result = Some(CallResult::Unavailable);
            CallStatus::Failed
        }
    };
    call.finish(status).await;
}

fn oauth_connector(catalog: &ConnectorCatalog, connector_id: &str) -> Option<Connector> {
    let connector = catalog.get(connector_id)?;
    if connector.id() == "matcha"
        || domain::is_system_runtime_connector(connector)
        || connector.kind() != ConnectorKind::McpHttp
        || connector.auth() != Some(McpAuth::OAuth)
        || !connector.enabled()
    {
        return None;
    }
    let servers = projection::runtime_mcp_servers(catalog);
    let server = servers
        .iter()
        .find(|server| server.connector_id.as_deref() == Some(connector_id))?;
    // The forward mapping can alias foo and matcha-external.foo; never strip a native name.
    if servers
        .iter()
        .filter(|candidate| candidate.server_id == server.server_id)
        .count() != 1
    {
        return None;
    }
    Some(connector.clone())
}
