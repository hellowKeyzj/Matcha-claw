use std::{path::PathBuf, sync::Arc};

use environment::{Connector, ConnectorKind, ConnectorStore, ConnectorStoreError};
use foundation::execution::{LaneRetention, OwnerSpec};
use openclaw::{
    gateway::wire::McpServerStatusList,
    lifecycle::state_dir::CanonicalStateDir,
    projection::connector::{
        catalog::discover_external_mcp_programs,
        config::{OpenClawMcpServerConfig, OpenClawMcpServerKind},
        external::{
            ConnectorProjectionEffect, connector_id_for_managed_external_server,
            managed_external_server_id,
        },
        preset::{PRESET_TEAM_RUN_MCP_SERVER_ID, PresetMcpProjection},
    },
};

use super::command::{ConnectorCommand, ConnectorOwnerKey, ConnectorQuery};
use crate::{
    external_connectors::{
        CatalogOutcome, GetOutcome, ListOutcome, MutationOutcome, OpenClawMcpServerSource,
        OpenClawMcpServerSummary, OpenClawMcpServersOutcome, ProbeOutcome,
        SessionConnectorResultType, SessionConnectorStatus, SessionConnectorStatusDetails,
        SessionEndpoint, SessionMcpServerEnabledOutcome, SessionMcpServerEnabledTarget,
        SessionStatusOutcome, SessionStatusTarget, StatusOutcome,
    },
    runtime_directory::RuntimeDriverDirectory,
};

pub(crate) struct ConnectorOwnerInput {
    pub(crate) state_dir: CanonicalStateDir,
    pub(crate) runtime_directory: Arc<RuntimeDriverDirectory>,
    pub(crate) runtime_host_mcp_executable: PathBuf,
    pub(crate) team_run_mcp_state_dir: PathBuf,
}

#[derive(Clone)]
pub(crate) struct ConnectorShared {
    runtime_directory: Arc<RuntimeDriverDirectory>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
}

pub(crate) struct ConnectorGlobalState {
    store: ConnectorStore,
    private_resolver: crate::transport::provider_accounts::private_auth::Resolver,
}

pub(crate) struct ConnectorLaneState;

pub(crate) struct ConnectorOwner {
    shared: ConnectorShared,
    global: ConnectorGlobalState,
}

impl ConnectorOwner {
    pub(crate) fn new(input: ConnectorOwnerInput) -> Result<Self, ()> {
        let store = ConnectorStore::open(
            input
                .state_dir
                .as_path()
                .join("external-connectors")
                .join("connectors.json"),
        )
        .map_err(|_| ())?;

        Ok(Self {
            shared: ConnectorShared {
                runtime_directory: input.runtime_directory,
                runtime_host_mcp_executable: input.runtime_host_mcp_executable,
                team_run_mcp_state_dir: input.team_run_mcp_state_dir,
            },
            global: ConnectorGlobalState {
                store,
                private_resolver:
                    crate::transport::provider_accounts::private_auth::Resolver::disabled(),
            },
        })
    }

    pub(crate) fn lane_retention() -> LaneRetention {
        LaneRetention::LowFrequency
    }
}

impl OwnerSpec for ConnectorOwner {
    type Command = ConnectorCommand;
    type Query = ConnectorQuery;
    type Key = ConnectorOwnerKey;
    type Shared = ConnectorShared;
    type GlobalState = ConnectorGlobalState;
    type LaneState = ConnectorLaneState;

    fn split(self) -> (Self::Shared, Self::GlobalState) {
        (self.shared, self.global)
    }

    fn route_command(command: &Self::Command) -> foundation::execution::CommandRoute<Self::Key> {
        command.route()
    }

    fn route_query(query: &Self::Query) -> foundation::execution::QueryRoute<Self::Key> {
        query.route()
    }

    fn open_lane(_shared: &Self::Shared, _key: &Self::Key) -> Self::LaneState {
        ConnectorLaneState
    }

    async fn handle_keyed_command(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _command: Self::Command,
    ) {
    }

    async fn handle_global_command(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        command: Self::Command,
    ) {
        match command {
            ConnectorCommand::Upsert { connector, reply } => {
                let outcome = upsert(&shared, global, *connector).await;
                let _ = reply.send(outcome);
            }
            ConnectorCommand::Remove { id, reply } => {
                let outcome = remove(&shared, global, &id).await;
                let _ = reply.send(outcome);
            }
            ConnectorCommand::ConfigurePrivateResolver { resolver, reply } => {
                global.private_resolver = resolver;
                let _ = apply_connector_projection(&shared, global).await;
                let _ = reply.send(());
            }
            ConnectorCommand::SetSessionMcpServerEnabled { target, reply } => {
                let outcome = set_session_mcp_server_enabled(&shared, global, target).await;
                let _ = reply.send(outcome);
            }
        }
    }

    async fn handle_direct_query(_shared: Self::Shared, _query: Self::Query) {}

    async fn handle_keyed_query(
        _shared: Self::Shared,
        _key: Self::Key,
        _lane: &mut Self::LaneState,
        _query: Self::Query,
    ) {
    }

    async fn handle_global_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_connector_query(shared, global, query).await;
    }

    async fn handle_exclusive_query(
        shared: Self::Shared,
        global: &mut Self::GlobalState,
        query: Self::Query,
    ) {
        handle_connector_query(shared, global, query).await;
    }
}

async fn handle_connector_query(
    shared: ConnectorShared,
    global: &ConnectorGlobalState,
    query: ConnectorQuery,
) {
    match query {
        ConnectorQuery::List { reply } => {
            let _ = reply.send(ListOutcome::Available(connectors(global)));
        }
        ConnectorQuery::Catalog { reply } => {
            let programs = discover_external_mcp_programs(&catalog(global));
            let _ = reply.send(CatalogOutcome::Available(programs));
        }
        ConnectorQuery::Status { reply } => {
            let connectors = connectors(global)
                .into_iter()
                .filter(|connector| !is_private_system_runtime_connector(connector))
                .collect::<Vec<_>>();
            let outcome = status(&shared, connectors).await;
            let _ = reply.send(outcome);
        }
        ConnectorQuery::Get { id, reply } => {
            let outcome = get(global, &id)
                .map(|connector| GetOutcome::Found(Box::new(connector)))
                .unwrap_or(GetOutcome::Missing);
            let _ = reply.send(outcome);
        }
        ConnectorQuery::Probe { id, reply } => {
            let connector = get(global, &id);
            let outcome = probe(&shared, connector).await;
            let _ = reply.send(outcome);
        }
        ConnectorQuery::SessionStatus { target, reply } => {
            let outcome = session_connector_status(&shared, global, target).await;
            let _ = reply.send(outcome);
        }
        ConnectorQuery::OpenClawMcpServers { reply } => {
            let outcome = openclaw_mcp_servers(&shared, global).await;
            let _ = reply.send(outcome);
        }
    }
}

fn catalog(global: &ConnectorGlobalState) -> environment::ConnectorCatalog {
    global.store.catalog().clone()
}

fn connectors(global: &ConnectorGlobalState) -> Vec<Connector> {
    let mut connectors = catalog(global)
        .connectors()
        .iter()
        .filter(|connector| connector.id != "matcha")
        .cloned()
        .collect::<Vec<_>>();
    connectors.push(Connector::system_runtime());
    connectors.sort_by(|left, right| left.id.cmp(&right.id));
    connectors
}

fn get(global: &ConnectorGlobalState, id: &str) -> Option<Connector> {
    if id == "matcha" {
        return Some(Connector::system_runtime());
    }
    connectors(global)
        .into_iter()
        .find(|connector| connector.id == id)
}

async fn upsert(
    shared: &ConnectorShared,
    global: &mut ConnectorGlobalState,
    connector: Connector,
) -> MutationOutcome {
    if is_private_system_runtime_connector(&connector) {
        return MutationOutcome::Rejected;
    }

    let mutation = match global.store.upsert(connector.clone()) {
        Ok(mutation) => mutation,
        Err(error) => return mutation_error(error),
    };

    let configuration = apply_connector_projection(shared, global).await;

    if matches!(configuration, ConnectorProjectionEffect::Written { .. }) {
        match global
            .store
            .record_applied(&connector.id, mutation.revision)
        {
            Ok(()) => {}
            Err(
                ConnectorStoreError::CommitOutcomeUnknown(_)
                | ConnectorStoreError::RecoveryRequired,
            ) => {
                return MutationOutcome::Unknown;
            }
            Err(_) => return MutationOutcome::Unavailable,
        }
    }

    MutationOutcome::Stored {
        connector: Box::new(connector),
        created: mutation.created,
        revision: mutation.revision,
        configuration,
    }
}

async fn remove(
    shared: &ConnectorShared,
    global: &mut ConnectorGlobalState,
    id: &str,
) -> MutationOutcome {
    match global.store.remove(id) {
        Ok(None) => MutationOutcome::Missing,
        Ok(Some(revision)) => {
            let configuration = apply_connector_projection(shared, global).await;

            if matches!(configuration, ConnectorProjectionEffect::Written { .. }) {
                match global.store.record_applied(id, revision) {
                    Ok(()) => {}
                    Err(
                        ConnectorStoreError::CommitOutcomeUnknown(_)
                        | ConnectorStoreError::RecoveryRequired,
                    ) => {
                        return MutationOutcome::Unknown;
                    }
                    Err(_) => return MutationOutcome::Unavailable,
                }
            }

            MutationOutcome::Removed {
                revision,
                configuration,
            }
        }
        Err(error) => mutation_error(error),
    }
}

async fn apply_connector_projection(
    shared: &ConnectorShared,
    global: &ConnectorGlobalState,
) -> ConnectorProjectionEffect {
    let Some(driver) = shared.runtime_directory.connector_driver() else {
        return ConnectorProjectionEffect::Unavailable;
    };
    let Some(ops) = driver.connector_ops() else {
        return ConnectorProjectionEffect::Unavailable;
    };
    ops.apply_runtime_mcp_projection(
        Some(PresetMcpProjection::new(
            &shared.runtime_host_mcp_executable,
            &shared.team_run_mcp_state_dir,
        )),
        catalog(global),
        &global.private_resolver,
    )
    .await
}

async fn set_session_mcp_server_enabled(
    shared: &ConnectorShared,
    global: &ConnectorGlobalState,
    target: SessionMcpServerEnabledTarget,
) -> SessionMcpServerEnabledOutcome {
    if !runtime_mcp_servers(global).into_iter().any(|server| {
        server.source == OpenClawMcpServerSource::External && server.server_id == target.server_id
    }) {
        return SessionMcpServerEnabledOutcome::Unavailable;
    }
    let SessionEndpoint::Native {
        runtime_adapter_id,
        runtime_instance_id,
    } = &target.session_identity.endpoint
    else {
        return SessionMcpServerEnabledOutcome::Unavailable;
    };
    let Ok(endpoint) = platform::endpoint::runtime_address::RuntimeEndpoint::try_new(
        runtime_adapter_id.clone(),
        runtime_instance_id.clone(),
    ) else {
        return SessionMcpServerEnabledOutcome::Unavailable;
    };
    let Some(driver) = shared.runtime_directory.lookup(&endpoint) else {
        return SessionMcpServerEnabledOutcome::Unavailable;
    };
    let Some(ops) = driver.connector_ops() else {
        return SessionMcpServerEnabledOutcome::Unavailable;
    };
    match ops
        .set_mcp_session_server_enabled(
            target.session_identity.session_key,
            target.server_id,
            target.enabled,
        )
        .await
    {
        Ok(()) => SessionMcpServerEnabledOutcome::Applied,
        Err(_) => SessionMcpServerEnabledOutcome::Unavailable,
    }
}

async fn openclaw_mcp_servers(
    shared: &ConnectorShared,
    global: &ConnectorGlobalState,
) -> OpenClawMcpServersOutcome {
    let Some(driver) = shared.runtime_directory.connector_driver() else {
        return OpenClawMcpServersOutcome::Unavailable;
    };
    let Some(ops) = driver.connector_ops() else {
        return OpenClawMcpServersOutcome::Unavailable;
    };
    let Ok(servers) = ops.list_mcp_servers().await else {
        return OpenClawMcpServersOutcome::Unavailable;
    };
    OpenClawMcpServersOutcome::Available(project_openclaw_mcp_servers(servers, &catalog(global)))
}

fn project_openclaw_mcp_servers(
    servers: Vec<OpenClawMcpServerConfig>,
    catalog: &environment::ConnectorCatalog,
) -> Vec<OpenClawMcpServerSummary> {
    servers
        .into_iter()
        .map(|server| project_openclaw_mcp_server(server, catalog))
        .collect()
}

fn runtime_mcp_servers(global: &ConnectorGlobalState) -> Vec<OpenClawMcpServerSummary> {
    let mut servers = vec![OpenClawMcpServerSummary {
        server_id: PRESET_TEAM_RUN_MCP_SERVER_ID.into(),
        connector_id: None,
        display_name: "Matcha TeamRun MCP".into(),
        description: None,
        kind: OpenClawMcpServerKind::McpStdio,
        source: OpenClawMcpServerSource::Preset,
        enabled: true,
        managed: true,
        editable: false,
        removable: false,
    }];
    servers.extend(catalog(global).connectors().iter().filter_map(|connector| {
        let kind = match connector.kind {
            ConnectorKind::McpStdio => OpenClawMcpServerKind::McpStdio,
            ConnectorKind::McpHttp => OpenClawMcpServerKind::McpHttp,
            ConnectorKind::Cli | ConnectorKind::Sdk | ConnectorKind::Http => return None,
        };
        Some(OpenClawMcpServerSummary {
            server_id: managed_external_server_id(&connector.id),
            connector_id: Some(connector.id.clone()),
            display_name: connector
                .display_name
                .clone()
                .unwrap_or_else(|| connector.id.clone()),
            description: connector.description.clone(),
            kind,
            source: OpenClawMcpServerSource::External,
            enabled: connector.enabled(),
            managed: true,
            editable: true,
            removable: true,
        })
    }));
    servers.sort_by(|left, right| left.server_id.cmp(&right.server_id));
    servers
}

fn project_openclaw_mcp_server(
    server: OpenClawMcpServerConfig,
    catalog: &environment::ConnectorCatalog,
) -> OpenClawMcpServerSummary {
    if server.server_id == PRESET_TEAM_RUN_MCP_SERVER_ID {
        return OpenClawMcpServerSummary {
            server_id: server.server_id,
            connector_id: None,
            display_name: "Matcha TeamRun MCP".into(),
            description: None,
            kind: server.kind,
            source: OpenClawMcpServerSource::Preset,
            enabled: server.enabled,
            managed: true,
            editable: false,
            removable: false,
        };
    }

    if let Some(connector_id) = connector_id_for_managed_external_server(&server.server_id) {
        let connector_id = connector_id.to_owned();
        let connector = catalog
            .connectors()
            .iter()
            .find(|connector| connector.id == connector_id);
        return OpenClawMcpServerSummary {
            server_id: server.server_id,
            connector_id: Some(connector_id.clone()),
            display_name: connector
                .and_then(|connector| connector.display_name.clone())
                .unwrap_or_else(|| connector_id.clone()),
            description: connector.and_then(|connector| connector.description.clone()),
            kind: server.kind,
            source: OpenClawMcpServerSource::External,
            enabled: server.enabled,
            managed: true,
            editable: true,
            removable: true,
        };
    }

    OpenClawMcpServerSummary {
        display_name: server.server_id.clone(),
        server_id: server.server_id,
        connector_id: None,
        description: None,
        kind: server.kind,
        source: OpenClawMcpServerSource::Openclaw,
        enabled: server.enabled,
        managed: false,
        editable: false,
        removable: false,
    }
}

async fn status(shared: &ConnectorShared, connectors: Vec<Connector>) -> StatusOutcome {
    let Some(driver) = shared.runtime_directory.connector_driver() else {
        return StatusOutcome::Unavailable;
    };
    let Some(ops) = driver.connector_ops() else {
        return StatusOutcome::Unavailable;
    };
    let statuses = futures_util::future::join_all(connectors.into_iter().map(|connector| {
        let id = connector.id.clone();
        async move { (id, ops.probe_external_connector(connector).await) }
    }))
    .await;
    StatusOutcome::Available(statuses)
}

async fn probe(shared: &ConnectorShared, connector: Option<Connector>) -> ProbeOutcome {
    let Some(connector) = connector else {
        return ProbeOutcome::Missing;
    };
    if is_private_system_runtime_connector(&connector) {
        return ProbeOutcome::Missing;
    }
    let Some(driver) = shared.runtime_directory.connector_driver() else {
        return ProbeOutcome::Unavailable;
    };
    let Some(ops) = driver.connector_ops() else {
        return ProbeOutcome::Unavailable;
    };
    ProbeOutcome::Observed(ops.probe_external_connector(connector).await)
}

async fn session_connector_status(
    shared: &ConnectorShared,
    global: &ConnectorGlobalState,
    target: SessionStatusTarget,
) -> SessionStatusOutcome {
    if !target.is_valid() {
        return SessionStatusOutcome::Unavailable;
    }
    let SessionStatusTarget {
        session_identity: identity,
        ..
    } = target;

    let target_endpoint = match &identity.endpoint {
        SessionEndpoint::Native {
            runtime_adapter_id,
            runtime_instance_id,
        } => platform::endpoint::runtime_address::RuntimeEndpoint::try_new(
            runtime_adapter_id,
            runtime_instance_id,
        )
        .ok(),
        SessionEndpoint::ProtocolConnector { .. } => None,
    };

    let Some(endpoint) = target_endpoint else {
        return SessionStatusOutcome::Available(Vec::new());
    };

    let driver = shared.runtime_directory.lookup(&endpoint);
    let Some(driver) = driver.filter(|driver| driver.connector_ops().is_some()) else {
        return SessionStatusOutcome::Available(Vec::new());
    };
    let ops = driver
        .connector_ops()
        .expect("connector driver advertised ops");

    let servers = runtime_mcp_servers(global);
    let statuses = ops
        .observe_mcp_server_status(identity.session_key.clone())
        .await;

    match statuses {
        Ok(statuses) => SessionStatusOutcome::Available(
            servers
                .into_iter()
                .map(|server| mcp_server_session_status(server, Some(&statuses)))
                .collect(),
        ),
        Err(_) => SessionStatusOutcome::Available(
            servers
                .into_iter()
                .map(|server| mcp_server_session_status(server, None))
                .collect(),
        ),
    }
}

fn mutation_error(error: ConnectorStoreError) -> MutationOutcome {
    match error {
        ConnectorStoreError::CommitOutcomeUnknown(_) | ConnectorStoreError::RecoveryRequired => {
            MutationOutcome::Unknown
        }
        ConnectorStoreError::Connector(_)
        | ConnectorStoreError::Commit(_)
        | ConnectorStoreError::Decode
        | ConnectorStoreError::Encode
        | ConnectorStoreError::RecordTooLarge
        | ConnectorStoreError::RevisionMismatch
        | ConnectorStoreError::RevisionOverflow
        | ConnectorStoreError::WriterBusy => MutationOutcome::Rejected,
    }
}

fn is_private_system_runtime_connector(connector: &Connector) -> bool {
    connector
        .mcp_server_program
        .as_ref()
        .is_some_and(|program| {
            matches!(program.source, environment::McpProgramSource::SystemRuntime)
        })
}

fn mcp_server_session_status(
    server: OpenClawMcpServerSummary,
    statuses: Option<&McpServerStatusList>,
) -> SessionConnectorStatus {
    let status = statuses.and_then(|statuses| {
        statuses
            .servers
            .iter()
            .find(|status| status.name == server.server_id)
    });
    let enabled_next_run = status
        .and_then(|status| status.enabled)
        .unwrap_or(server.enabled);
    let configurable = server.source == OpenClawMcpServerSource::External;
    let details = SessionConnectorStatusDetails {
        server_id: Some(server.server_id.clone()),
        session_key: None,
        tool_count: status.and_then(|status| status.tool_count),
        launch_summary: status.and_then(|status| status.launch_summary.clone()),
        enabled_next_run: Some(enabled_next_run),
        enabled_configurable: Some(configurable),
    };

    if !server.enabled {
        return SessionConnectorStatus {
            connector_id: server
                .connector_id
                .unwrap_or_else(|| server.server_id.clone()),
            display_name: Some(server.display_name),
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: SessionConnectorResultType::Disabled,
            reason: Some("OpenClaw MCP server is disabled".into()),
            details: Some(details),
        };
    }

    let Some(status) = status else {
        return SessionConnectorStatus {
            connector_id: server
                .connector_id
                .unwrap_or_else(|| server.server_id.clone()),
            display_name: Some(server.display_name),
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: if statuses.is_some() {
                SessionConnectorResultType::Disconnected
            } else {
                SessionConnectorResultType::Unknown
            },
            reason: Some(if statuses.is_some() {
                "OpenClaw MCP status did not include this server".into()
            } else {
                "OpenClaw MCP status is unavailable for this session".into()
            }),
            details: Some(details),
        };
    };

    let result_type = match status.state.as_deref() {
        Some("disabled") => SessionConnectorResultType::Disabled,
        Some("not-connected") | Some("listing-tools") | Some("stale-config") => {
            SessionConnectorResultType::Pending
        }
        Some("connected") => SessionConnectorResultType::Connected,
        Some("disconnected") | Some("error") => SessionConnectorResultType::Disconnected,
        _ if status.enabled == Some(false) => SessionConnectorResultType::Disabled,
        _ if status.available.unwrap_or(false) => SessionConnectorResultType::Connected,
        _ => SessionConnectorResultType::Pending,
    };
    let reason = match status.state.as_deref() {
        Some("disabled") => "OpenClaw MCP server is disabled for this session",
        Some("not-connected") => "OpenClaw MCP server is configured but not connected for this session yet",
        Some("listing-tools") => "OpenClaw MCP server is connected but has not finished listing tools yet",
        Some("stale-config") => "OpenClaw MCP server configuration changed; the next run will refresh it",
        Some("connected") => "OpenClaw MCP server is connected for this session",
        Some("disconnected") => "OpenClaw MCP server is disconnected for this session",
        Some("error") => "OpenClaw MCP server reported an error for this session",
        _ => "OpenClaw MCP status is pending for this session",
    };
    SessionConnectorStatus {
        connector_id: server
            .connector_id
            .unwrap_or_else(|| server.server_id.clone()),
        display_name: Some(server.display_name),
        adapter_id: "openclaw".into(),
        target_kind: "session",
        result_type,
        reason: Some(reason.into()),
        details: Some(details),
    }
}
