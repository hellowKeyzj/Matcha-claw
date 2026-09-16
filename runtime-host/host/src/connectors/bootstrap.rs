use environment::connectors::{Connector, ConnectorCatalog, McpProgramSource};

const SYSTEM_RUNTIME_CONNECTOR_ID: &str = "matcha";

pub(super) fn connector_list(catalog: &ConnectorCatalog) -> Vec<Connector> {
    let mut connectors = user_connectors(catalog);
    connectors.push(system_runtime_connector());
    connectors.sort_by(|left, right| left.id().cmp(right.id()));
    connectors
}

pub(super) fn user_connectors(catalog: &ConnectorCatalog) -> Vec<Connector> {
    catalog
        .connectors()
        .iter()
        .filter(|connector| {
            connector.id() != SYSTEM_RUNTIME_CONNECTOR_ID && !is_system_runtime_connector(connector)
        })
        .cloned()
        .collect()
}

pub(super) fn connector(catalog: &ConnectorCatalog, id: &str) -> Option<Connector> {
    if id == SYSTEM_RUNTIME_CONNECTOR_ID {
        return Some(system_runtime_connector());
    }
    user_connectors(catalog)
        .into_iter()
        .find(|connector| connector.id() == id)
}

pub(super) fn is_system_runtime_connector(connector: &Connector) -> bool {
    connector
        .mcp_server_program()
        .is_some_and(|program| matches!(program.source(), McpProgramSource::SystemRuntime))
}

pub(crate) fn system_runtime_connector() -> Connector {
    Connector::system_runtime()
}
