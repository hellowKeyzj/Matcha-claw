use crate::domain::{ConnectorCatalog, ConnectorKind};

use crate::ports::{
    McpServerConfig, McpServerKind, McpServerStatusList, PRESET_TEAM_RUN_MCP_SERVER_ID,
};

use crate::application::receipts::{
    ConnectorSessionMcpServerState, ConnectorSessionMcpServerStatus,
    ConnectorSessionMcpServerStatusDetails, RuntimeMcpServerKind, RuntimeMcpServerSource,
    RuntimeMcpServerSummary,
};

const MANAGED_EXTERNAL_SERVER_PREFIX: &str = "matcha-external.";

pub(crate) fn runtime_mcp_servers(catalog: &ConnectorCatalog) -> Vec<RuntimeMcpServerSummary> {
    let mut servers = vec![team_run_preset_summary(true)];
    servers.extend(catalog.connectors().iter().filter_map(|connector| {
        let kind = match connector.kind() {
            ConnectorKind::McpStdio => RuntimeMcpServerKind::McpStdio,
            ConnectorKind::McpHttp => RuntimeMcpServerKind::McpHttp,
            ConnectorKind::Cli | ConnectorKind::Sdk | ConnectorKind::Http => return None,
        };
        Some(RuntimeMcpServerSummary {
            server_id: managed_external_server_id(connector.id()),
            connector_id: Some(connector.id().to_owned()),
            display_name: connector
                .display_name()
                .map(str::to_owned)
                .unwrap_or_else(|| connector.id().to_owned()),
            description: connector.description().map(str::to_owned),
            kind,
            source: RuntimeMcpServerSource::External,
            enabled: connector.enabled(),
            managed: true,
            editable: true,
            removable: true,
        })
    }));
    servers.sort_by(|left, right| left.server_id.cmp(&right.server_id));
    servers
}

pub(crate) fn openclaw_mcp_servers(
    servers: Vec<McpServerConfig>,
    catalog: &ConnectorCatalog,
) -> Vec<RuntimeMcpServerSummary> {
    servers
        .into_iter()
        .map(|server| openclaw_mcp_server(server, catalog))
        .collect()
}

fn openclaw_mcp_server(
    server: McpServerConfig,
    catalog: &ConnectorCatalog,
) -> RuntimeMcpServerSummary {
    if server.server_id == PRESET_TEAM_RUN_MCP_SERVER_ID {
        let mut summary = team_run_preset_summary(server.enabled);
        summary.kind = map_server_kind(server.kind);
        return summary;
    }

    if let Some(connector_id) = connector_id_for_managed_external_server(&server.server_id) {
        let connector_id = connector_id.to_owned();
        let connector = catalog
            .connectors()
            .iter()
            .find(|connector| connector.id() == connector_id);
        return RuntimeMcpServerSummary {
            server_id: server.server_id,
            connector_id: Some(connector_id.clone()),
            display_name: connector
                .and_then(|connector| connector.display_name().map(str::to_owned))
                .unwrap_or_else(|| connector_id.clone()),
            description: connector.and_then(|connector| connector.description().map(str::to_owned)),
            kind: map_server_kind(server.kind),
            source: RuntimeMcpServerSource::External,
            enabled: server.enabled,
            managed: true,
            editable: true,
            removable: true,
        };
    }

    RuntimeMcpServerSummary {
        display_name: server.server_id.clone(),
        server_id: server.server_id,
        connector_id: None,
        description: None,
        kind: map_server_kind(server.kind),
        source: RuntimeMcpServerSource::OpenClaw,
        enabled: server.enabled,
        managed: false,
        editable: false,
        removable: false,
    }
}

fn team_run_preset_summary(enabled: bool) -> RuntimeMcpServerSummary {
    RuntimeMcpServerSummary {
        server_id: PRESET_TEAM_RUN_MCP_SERVER_ID.into(),
        connector_id: None,
        display_name: "Matcha TeamRun MCP".into(),
        description: None,
        kind: RuntimeMcpServerKind::McpStdio,
        source: RuntimeMcpServerSource::Preset,
        enabled,
        managed: true,
        editable: false,
        removable: false,
    }
}

fn map_server_kind(kind: McpServerKind) -> RuntimeMcpServerKind {
    match kind {
        McpServerKind::McpStdio => RuntimeMcpServerKind::McpStdio,
        McpServerKind::McpHttp => RuntimeMcpServerKind::McpHttp,
        McpServerKind::Unknown => RuntimeMcpServerKind::Unknown,
    }
}

fn managed_external_server_id(connector_id: &str) -> String {
    if connector_id.starts_with(MANAGED_EXTERNAL_SERVER_PREFIX) {
        connector_id.to_owned()
    } else {
        format!("{MANAGED_EXTERNAL_SERVER_PREFIX}{connector_id}")
    }
}

fn connector_id_for_managed_external_server(server_id: &str) -> Option<&str> {
    server_id.strip_prefix(MANAGED_EXTERNAL_SERVER_PREFIX)
}

pub(crate) fn session_status(
    server: RuntimeMcpServerSummary,
    statuses: Option<&McpServerStatusList>,
) -> ConnectorSessionMcpServerStatus {
    let status = statuses.and_then(|statuses| {
        statuses
            .servers
            .iter()
            .find(|status| status.name == server.server_id)
    });
    let enabled_next_run = status
        .and_then(|status| status.enabled)
        .unwrap_or(server.enabled);
    let configurable = server.source == RuntimeMcpServerSource::External;
    let details = ConnectorSessionMcpServerStatusDetails {
        server_id: server.server_id.clone(),
        tool_count: status.and_then(|status| status.tool_count),
        launch_summary: status.and_then(|status| status.launch_summary.clone()),
        enabled_next_run,
        enabled_configurable: configurable,
    };

    if !server.enabled {
        return ConnectorSessionMcpServerStatus {
            server,
            state: ConnectorSessionMcpServerState::DisabledByConfiguration,
            details,
        };
    }

    let Some(status) = status else {
        return ConnectorSessionMcpServerStatus {
            server,
            state: if statuses.is_some() {
                ConnectorSessionMcpServerState::MissingFromNativeStatus
            } else {
                ConnectorSessionMcpServerState::NativeStatusUnavailable
            },
            details,
        };
    };

    let state = match status.state.as_deref() {
        Some("disabled") => ConnectorSessionMcpServerState::NativeDisabled,
        Some("not-connected") => ConnectorSessionMcpServerState::NativeNotConnected,
        Some("listing-tools") => ConnectorSessionMcpServerState::NativeListingTools,
        Some("stale-config") => ConnectorSessionMcpServerState::NativeStaleConfig,
        Some("connected") => ConnectorSessionMcpServerState::NativeConnected,
        Some("disconnected") => ConnectorSessionMcpServerState::NativeDisconnected,
        Some("error") => ConnectorSessionMcpServerState::NativeError,
        _ if status.enabled == Some(false) => ConnectorSessionMcpServerState::NativeEnabledFalse,
        _ if status.available.unwrap_or(false) => ConnectorSessionMcpServerState::NativeAvailable,
        _ => ConnectorSessionMcpServerState::NativePending,
    };
    ConnectorSessionMcpServerStatus {
        server,
        state,
        details,
    }
}
