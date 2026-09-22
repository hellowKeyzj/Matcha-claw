use connectors::{Connector, ConnectorCatalog, ports};

use crate::{
    gateway::wire,
    lifecycle::state_dir::CanonicalStateDir,
    projection::connector::{config, external, preset::PresetMcpProjection},
};

pub fn apply_runtime_mcp_projection(
    state_dir: CanonicalStateDir,
    preset: Option<ports::TeamRunMcpPreset<'_>>,
    catalog: &ConnectorCatalog,
    secrets: &dyn ports::ConnectorSecretResolverPort,
) -> ports::ConnectorProjectionEffect {
    let preset = preset.map(|preset| {
        PresetMcpProjection::new(
            preset.runtime_host_mcp_executable(),
            preset.team_run_mcp_state_dir(),
        )
    });
    external::project_runtime_mcp_connectors(state_dir, preset, catalog, secrets)
        .map(|(effect, _)| map_projection_effect(effect))
        .unwrap_or(ports::ConnectorProjectionEffect::Unavailable)
}

pub async fn probe_external_connector(connector: &Connector) -> ports::ConnectorObservation {
    map_observation(external::probe_external_connector(connector).await)
}

pub fn read_mcp_servers(
    state_dir: CanonicalStateDir,
) -> Result<Vec<ports::McpServerConfig>, ports::ConnectorOperationFailure> {
    config::read_mcp_servers(state_dir)
        .map(|servers| servers.into_iter().map(map_mcp_server_config).collect())
        .map_err(|_| ports::ConnectorOperationFailure::Unknown)
}

pub async fn observe_mcp_server_status(
    gateway: &mut crate::port::OpenClawGateway,
    session_key: String,
) -> Result<ports::McpServerStatusList, ports::ConnectorOperationFailure> {
    gateway
        .observe_mcp_server_status(session_key)
        .await
        .map(map_mcp_server_status_list)
        .map_err(|_| ports::ConnectorOperationFailure::Unknown)
}

pub async fn set_mcp_session_server_enabled(
    gateway: &mut crate::port::OpenClawGateway,
    session_key: String,
    server_name: String,
    enabled: bool,
) -> Result<(), ports::ConnectorOperationFailure> {
    gateway
        .set_mcp_session_server_enabled(session_key, server_name, enabled)
        .await
        .map_err(|_| ports::ConnectorOperationFailure::Unknown)
}

fn map_projection_effect(
    effect: external::ConnectorProjectionEffect,
) -> ports::ConnectorProjectionEffect {
    match effect {
        external::ConnectorProjectionEffect::Written { changed } => {
            ports::ConnectorProjectionEffect::Written { changed }
        }
        external::ConnectorProjectionEffect::Unknown => ports::ConnectorProjectionEffect::Unknown,
        external::ConnectorProjectionEffect::Unavailable => {
            ports::ConnectorProjectionEffect::Unavailable
        }
    }
}

fn map_observation(observation: external::ConnectorObservation) -> ports::ConnectorObservation {
    match observation {
        external::ConnectorObservation::Connected => ports::ConnectorObservation::Connected,
        external::ConnectorObservation::Disconnected => ports::ConnectorObservation::Disconnected,
        external::ConnectorObservation::Disabled => ports::ConnectorObservation::Disabled,
        external::ConnectorObservation::Unsupported => ports::ConnectorObservation::Unsupported,
        external::ConnectorObservation::Unknown => ports::ConnectorObservation::Unknown,
    }
}

fn map_mcp_server_config(server: config::OpenClawMcpServerConfig) -> ports::McpServerConfig {
    ports::McpServerConfig {
        server_id: server.server_id,
        kind: map_mcp_server_kind(server.kind),
        enabled: server.enabled,
    }
}

fn map_mcp_server_kind(kind: config::OpenClawMcpServerKind) -> ports::McpServerKind {
    match kind {
        config::OpenClawMcpServerKind::McpStdio => ports::McpServerKind::McpStdio,
        config::OpenClawMcpServerKind::McpHttp => ports::McpServerKind::McpHttp,
        config::OpenClawMcpServerKind::Unknown => ports::McpServerKind::Unknown,
    }
}

fn map_mcp_server_status_list(statuses: wire::McpServerStatusList) -> ports::McpServerStatusList {
    ports::McpServerStatusList {
        servers: statuses
            .servers
            .into_iter()
            .map(map_mcp_server_status_entry)
            .collect(),
        next_cursor: statuses.next_cursor,
    }
}

fn map_mcp_server_status_entry(status: wire::McpServerStatusEntry) -> ports::McpServerStatusEntry {
    ports::McpServerStatusEntry {
        name: status.name,
        launch_summary: status.launch_summary,
        tool_count: status.tool_count,
        available: status.available,
        enabled: status.enabled,
        state: status.state,
    }
}
