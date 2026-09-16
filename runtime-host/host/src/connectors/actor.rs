use std::{path::PathBuf, sync::Arc};

use environment::{
    ConnectorStore, ConnectorStoreError,
    connectors::{Connector, ConnectorCatalog, McpProgramSource, McpServerProgram},
};
use foundation::execution::{LaneRetention, OwnerSpec};
use openclaw::{
    lifecycle::state_dir::CanonicalStateDir,
    projection::connector::{
        external::{ConnectorObservation, ConnectorProjectionEffect},
        preset::PresetMcpProjection,
    },
};

use super::{
    bootstrap,
    command::{ConnectorCommand, ConnectorOwnerKey, ConnectorQuery},
    projection,
    receipt::{
        ConnectorCatalogProgram, ConnectorCatalogReceipt, ConnectorGetReceipt,
        ConnectorListReceipt, ConnectorMutationReceipt, ConnectorObservationReceipt,
        ConnectorProbeReceipt, ConnectorProjectionReceipt, ConnectorRecord,
        ConnectorSessionEndpoint, ConnectorSessionMcpServerEnabledReceipt,
        ConnectorSessionMcpServerEnabledTarget, ConnectorSessionStatusReceipt,
        ConnectorSessionTarget, ConnectorStatusReceipt, OpenClawMcpServersReceipt,
        RuntimeMcpServerSource, RuntimeMcpServerSummary,
    },
    store_open,
};
use crate::runtime::directory::RuntimeDriverDirectory;

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
    private_resolver: crate::provider::auth::Resolver,
}

pub(crate) struct ConnectorLaneState;

pub(crate) struct ConnectorOwner {
    shared: ConnectorShared,
    global: ConnectorGlobalState,
}

impl ConnectorOwner {
    pub(crate) fn new(input: ConnectorOwnerInput) -> Result<Self, ()> {
        let store = store_open::open(&input.state_dir).map_err(|_| ())?;

        Ok(Self {
            shared: ConnectorShared {
                runtime_directory: input.runtime_directory,
                runtime_host_mcp_executable: input.runtime_host_mcp_executable,
                team_run_mcp_state_dir: input.team_run_mcp_state_dir,
            },
            global: ConnectorGlobalState {
                store,
                private_resolver: crate::provider::auth::Resolver::disabled(),
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
                let _ = reconcile_connector_projection(&shared, global).await;
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
            let connectors = bootstrap::connector_list(&catalog(global))
                .into_iter()
                .map(ConnectorRecord::from_domain)
                .collect();
            let _ = reply.send(ConnectorListReceipt::Available(connectors));
        }
        ConnectorQuery::Catalog { reply } => {
            let programs = catalog_programs(&catalog(global));
            let _ = reply.send(ConnectorCatalogReceipt::Available(programs));
        }
        ConnectorQuery::Status { reply } => {
            let outcome = status(&shared, bootstrap::user_connectors(&catalog(global))).await;
            let _ = reply.send(outcome);
        }
        ConnectorQuery::Get { id, reply } => {
            let outcome = bootstrap::connector(&catalog(global), &id)
                .map(ConnectorRecord::from_domain)
                .map(|connector| ConnectorGetReceipt::Found(Box::new(connector)))
                .unwrap_or(ConnectorGetReceipt::Missing);
            let _ = reply.send(outcome);
        }
        ConnectorQuery::Probe { id, reply } => {
            let connector = bootstrap::connector(&catalog(global), &id);
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

fn catalog(global: &ConnectorGlobalState) -> ConnectorCatalog {
    global.store.catalog().clone()
}

async fn upsert(
    shared: &ConnectorShared,
    global: &mut ConnectorGlobalState,
    connector: Connector,
) -> ConnectorMutationReceipt {
    if bootstrap::is_system_runtime_connector(&connector) {
        return ConnectorMutationReceipt::Rejected;
    }

    let mutation = match global.store.upsert(connector.clone()) {
        Ok(mutation) => mutation,
        Err(error) => return mutation_error(error),
    };

    let configuration = reconcile_connector_projection(shared, global).await;

    if matches!(configuration, ConnectorProjectionEffect::Written { .. }) {
        match global
            .store
            .record_applied(connector.id(), mutation.revision)
        {
            Ok(()) => {}
            Err(
                ConnectorStoreError::CommitOutcomeUnknown(_)
                | ConnectorStoreError::RecoveryRequired,
            ) => {
                return ConnectorMutationReceipt::Unknown;
            }
            Err(_) => return ConnectorMutationReceipt::Unavailable,
        }
    }

    ConnectorMutationReceipt::Stored {
        connector: Box::new(ConnectorRecord::from_domain(connector)),
        created: mutation.created,
        revision: mutation.revision,
        configuration: map_projection_effect(configuration),
    }
}

async fn remove(
    shared: &ConnectorShared,
    global: &mut ConnectorGlobalState,
    id: &str,
) -> ConnectorMutationReceipt {
    match global.store.remove(id) {
        Ok(None) => ConnectorMutationReceipt::Missing,
        Ok(Some(revision)) => {
            let configuration = reconcile_connector_projection(shared, global).await;

            if matches!(configuration, ConnectorProjectionEffect::Written { .. }) {
                match global.store.record_applied(id, revision) {
                    Ok(()) => {}
                    Err(
                        ConnectorStoreError::CommitOutcomeUnknown(_)
                        | ConnectorStoreError::RecoveryRequired,
                    ) => {
                        return ConnectorMutationReceipt::Unknown;
                    }
                    Err(_) => return ConnectorMutationReceipt::Unavailable,
                }
            }

            ConnectorMutationReceipt::Removed {
                revision,
                configuration: map_projection_effect(configuration),
            }
        }
        Err(error) => mutation_error(error),
    }
}

async fn reconcile_connector_projection(
    shared: &ConnectorShared,
    global: &ConnectorGlobalState,
) -> ConnectorProjectionEffect {
    apply_connector_projection(shared, global).await
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
    target: ConnectorSessionMcpServerEnabledTarget,
) -> ConnectorSessionMcpServerEnabledReceipt {
    if !runtime_mcp_servers(global).into_iter().any(|server| {
        server.source == RuntimeMcpServerSource::External && server.server_id == target.server_id
    }) {
        return ConnectorSessionMcpServerEnabledReceipt::Unavailable;
    }
    let ConnectorSessionEndpoint::Native {
        runtime_adapter_id,
        runtime_instance_id,
    } = &target.session.endpoint
    else {
        return ConnectorSessionMcpServerEnabledReceipt::Unavailable;
    };
    let Ok(endpoint) = platform::endpoint::runtime_address::RuntimeEndpoint::try_new(
        runtime_adapter_id.clone(),
        runtime_instance_id.clone(),
    ) else {
        return ConnectorSessionMcpServerEnabledReceipt::Unavailable;
    };
    let Some(driver) = shared.runtime_directory.lookup(&endpoint) else {
        return ConnectorSessionMcpServerEnabledReceipt::Unavailable;
    };
    let Some(ops) = driver.connector_ops() else {
        return ConnectorSessionMcpServerEnabledReceipt::Unavailable;
    };
    match ops
        .set_mcp_session_server_enabled(
            target.session.session_key,
            target.server_id,
            target.enabled,
        )
        .await
    {
        Ok(()) => ConnectorSessionMcpServerEnabledReceipt::Applied,
        Err(_) => ConnectorSessionMcpServerEnabledReceipt::Unavailable,
    }
}

async fn openclaw_mcp_servers(
    shared: &ConnectorShared,
    global: &ConnectorGlobalState,
) -> OpenClawMcpServersReceipt {
    let Some(driver) = shared.runtime_directory.connector_driver() else {
        return OpenClawMcpServersReceipt::Unavailable;
    };
    let Some(ops) = driver.connector_ops() else {
        return OpenClawMcpServersReceipt::Unavailable;
    };
    let Ok(servers) = ops.list_mcp_servers().await else {
        return OpenClawMcpServersReceipt::Unavailable;
    };
    OpenClawMcpServersReceipt::Available(projection::openclaw_mcp_servers(
        servers,
        &catalog(global),
    ))
}

fn runtime_mcp_servers(global: &ConnectorGlobalState) -> Vec<RuntimeMcpServerSummary> {
    projection::runtime_mcp_servers(&catalog(global))
}

async fn status(shared: &ConnectorShared, connectors: Vec<Connector>) -> ConnectorStatusReceipt {
    let Some(driver) = shared.runtime_directory.connector_driver() else {
        return ConnectorStatusReceipt::Unavailable;
    };
    let Some(ops) = driver.connector_ops() else {
        return ConnectorStatusReceipt::Unavailable;
    };
    let statuses = futures_util::future::join_all(connectors.into_iter().map(|connector| {
        let id = connector.id().to_owned();
        async move {
            (
                id,
                map_observation(ops.probe_external_connector(connector).await),
            )
        }
    }))
    .await;
    ConnectorStatusReceipt::Available(statuses)
}

async fn probe(shared: &ConnectorShared, connector: Option<Connector>) -> ConnectorProbeReceipt {
    let Some(connector) = connector else {
        return ConnectorProbeReceipt::Missing;
    };
    if bootstrap::is_system_runtime_connector(&connector) {
        return ConnectorProbeReceipt::Missing;
    }
    let Some(driver) = shared.runtime_directory.connector_driver() else {
        return ConnectorProbeReceipt::Unavailable;
    };
    let Some(ops) = driver.connector_ops() else {
        return ConnectorProbeReceipt::Unavailable;
    };
    ConnectorProbeReceipt::Observed(map_observation(
        ops.probe_external_connector(connector).await,
    ))
}

async fn session_connector_status(
    shared: &ConnectorShared,
    global: &ConnectorGlobalState,
    target: ConnectorSessionTarget,
) -> ConnectorSessionStatusReceipt {
    let target_endpoint = match &target.endpoint {
        ConnectorSessionEndpoint::Native {
            runtime_adapter_id,
            runtime_instance_id,
        } => platform::endpoint::runtime_address::RuntimeEndpoint::try_new(
            runtime_adapter_id,
            runtime_instance_id,
        )
        .ok(),
        ConnectorSessionEndpoint::ProtocolConnector => None,
    };

    let Some(endpoint) = target_endpoint else {
        return ConnectorSessionStatusReceipt::Available(Vec::new());
    };

    let driver = shared.runtime_directory.lookup(&endpoint);
    let Some(driver) = driver.filter(|driver| driver.connector_ops().is_some()) else {
        return ConnectorSessionStatusReceipt::Available(Vec::new());
    };
    let ops = driver
        .connector_ops()
        .expect("connector driver advertised ops");

    let servers = runtime_mcp_servers(global);
    let statuses = ops
        .observe_mcp_server_status(target.session_key.clone())
        .await;

    match statuses {
        Ok(statuses) => ConnectorSessionStatusReceipt::Available(
            servers
                .into_iter()
                .map(|server| projection::session_status(server, Some(&statuses)))
                .collect(),
        ),
        Err(_) => ConnectorSessionStatusReceipt::Available(
            servers
                .into_iter()
                .map(|server| projection::session_status(server, None))
                .collect(),
        ),
    }
}

fn catalog_programs(catalog: &ConnectorCatalog) -> Vec<ConnectorCatalogProgram> {
    let mut programs = catalog
        .connectors()
        .iter()
        .filter_map(|connector| match connector.kind() {
            environment::connectors::ConnectorKind::McpStdio => Some(ConnectorCatalogProgram {
                id: program_id(connector),
                source: program_source(connector),
                display_name: display_name(connector),
                connector_kinds: vec![crate::runtime::external_connectors::ConnectorKind::McpStdio],
                transport: None,
                command: connector.command().map(str::to_owned),
                args: connector.args().map(<[_]>::to_vec),
                url: None,
                root_path: connector.cwd().map(str::to_owned),
                env_keys: string_map_keys(connector.env()),
                header_keys: None,
            }),
            environment::connectors::ConnectorKind::McpHttp => Some(ConnectorCatalogProgram {
                id: program_id(connector),
                source: program_source(connector),
                display_name: display_name(connector),
                connector_kinds: vec![crate::runtime::external_connectors::ConnectorKind::McpHttp],
                transport: connector.transport().map(map_mcp_transport),
                command: None,
                args: None,
                url: connector.url().map(str::to_owned),
                root_path: None,
                env_keys: None,
                header_keys: string_map_keys(connector.headers()),
            }),
            environment::connectors::ConnectorKind::Cli
            | environment::connectors::ConnectorKind::Sdk
            | environment::connectors::ConnectorKind::Http => None,
        })
        .collect::<Vec<_>>();
    programs.sort_by(|left, right| left.id.cmp(&right.id));
    programs.dedup_by(|left, right| left.id == right.id);
    programs
}

fn program_id(connector: &Connector) -> String {
    connector
        .mcp_server_program()
        .and_then(|program| program.program_id().map(str::to_owned))
        .unwrap_or_else(|| format!("managed-local:{}", connector.id()))
}

fn program_source(connector: &Connector) -> McpProgramSource {
    connector
        .mcp_server_program()
        .map(McpServerProgram::source)
        .unwrap_or(McpProgramSource::ManagedLocal)
}

fn display_name(connector: &Connector) -> String {
    connector
        .display_name()
        .map(str::to_owned)
        .unwrap_or_else(|| connector.id().to_owned())
}

fn string_map_keys(
    map: Option<&std::collections::BTreeMap<String, String>>,
) -> Option<Vec<String>> {
    let keys = map.map(|map| map.keys().cloned().collect::<Vec<_>>())?;
    (!keys.is_empty()).then_some(keys)
}

fn map_mcp_transport(
    transport: environment::connectors::McpTransport,
) -> crate::runtime::external_connectors::McpTransport {
    match transport {
        environment::connectors::McpTransport::StreamableHttp => {
            crate::runtime::external_connectors::McpTransport::StreamableHttp
        }
        environment::connectors::McpTransport::Sse => {
            crate::runtime::external_connectors::McpTransport::Sse
        }
    }
}

fn map_projection_effect(effect: ConnectorProjectionEffect) -> ConnectorProjectionReceipt {
    match effect {
        ConnectorProjectionEffect::Written { changed } => {
            ConnectorProjectionReceipt::Written { changed }
        }
        ConnectorProjectionEffect::Unknown => ConnectorProjectionReceipt::Unknown,
        ConnectorProjectionEffect::Unavailable => ConnectorProjectionReceipt::Unavailable,
    }
}

fn map_observation(observation: ConnectorObservation) -> ConnectorObservationReceipt {
    match observation {
        ConnectorObservation::Connected => ConnectorObservationReceipt::Connected,
        ConnectorObservation::Disconnected => ConnectorObservationReceipt::Disconnected,
        ConnectorObservation::Disabled => ConnectorObservationReceipt::Disabled,
        ConnectorObservation::Unsupported => ConnectorObservationReceipt::Unsupported,
        ConnectorObservation::Unknown => ConnectorObservationReceipt::Unknown,
    }
}

fn mutation_error(error: ConnectorStoreError) -> ConnectorMutationReceipt {
    match error {
        ConnectorStoreError::CommitOutcomeUnknown(_) | ConnectorStoreError::RecoveryRequired => {
            ConnectorMutationReceipt::Unknown
        }
        ConnectorStoreError::Connector(_)
        | ConnectorStoreError::Commit(_)
        | ConnectorStoreError::Decode
        | ConnectorStoreError::Encode
        | ConnectorStoreError::RecordTooLarge
        | ConnectorStoreError::RevisionMismatch
        | ConnectorStoreError::RevisionOverflow
        | ConnectorStoreError::WriterBusy => ConnectorMutationReceipt::Rejected,
    }
}
