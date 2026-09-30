use std::{path::PathBuf, sync::Arc};

use foundation::execution::{LaneRetention, OwnerSpec};
use platform::call::CallStatus;

use crate::call::{
    CallResult, ConnectorCall, ConnectorCallDetail, ObservationSummary, observation_status,
};

use crate::{
    adapters::store::{self, ConnectorStore, ConnectorStoreError},
    application::{
        ConnectorCommand, ConnectorOwnerKey, ConnectorQuery,
        receipts::{
            ConnectorCatalogProgram, ConnectorCatalogReceipt, ConnectorGetReceipt,
            ConnectorListReceipt, ConnectorMutationReceipt, ConnectorObservationReceipt,
            ConnectorProbeReceipt, ConnectorProjectionReceipt, ConnectorRecord,
            ConnectorSessionEndpoint, ConnectorSessionMcpServerEnabledReceipt,
            ConnectorSessionMcpServerEnabledTarget, ConnectorSessionStatusReceipt,
            ConnectorSessionTarget, ConnectorStatusReceipt, OpenClawMcpServersReceipt,
            RuntimeMcpServerSource, RuntimeMcpServerSummary,
        },
    },
    delivery::{ConnectorKind, McpProgramSource, McpTransport},
    domain::{
        self, Connector, ConnectorCatalog, ConnectorKind as DomainConnectorKind,
        McpProgramSource as DomainMcpProgramSource, McpServerProgram,
        McpTransport as DomainMcpTransport,
    },
    ports::{
        ConnectorObservation, ConnectorProjectionEffect, ConnectorRuntimeDirectory,
        ConnectorSecretResolverPort, TeamRunMcpPreset, unavailable_connector_secret_authority,
    },
    projection,
};

use super::observations::{ObservationResult, ObservationResults};

pub struct ConnectorOwnerInput {
    pub state_dir: PathBuf,
    pub runtime_directory: Arc<dyn ConnectorRuntimeDirectory>,
    pub runtime_host_mcp_executable: PathBuf,
    pub team_run_mcp_state_dir: PathBuf,
}

#[derive(Clone)]
pub(crate) struct ConnectorShared {
    observations: Arc<ObservationResults>,
    runtime_directory: Arc<dyn ConnectorRuntimeDirectory>,
    runtime_host_mcp_executable: PathBuf,
    team_run_mcp_state_dir: PathBuf,
}

pub(crate) struct ConnectorGlobalState {
    store: ConnectorStore,
    private_resolver: Arc<dyn ConnectorSecretResolverPort>,
}

pub(crate) struct ConnectorLaneState;

pub(crate) struct ConnectorOwner {
    shared: ConnectorShared,
    global: ConnectorGlobalState,
}

impl ConnectorOwner {
    pub fn new(input: ConnectorOwnerInput) -> Result<Self, ()> {
        let store = store::open(&input.state_dir).map_err(|_| ())?;

        Ok(Self {
            shared: ConnectorShared {
                observations: Arc::new(ObservationResults::default()),
                runtime_directory: input.runtime_directory,
                runtime_host_mcp_executable: input.runtime_host_mcp_executable,
                team_run_mcp_state_dir: input.team_run_mcp_state_dir,
            },
            global: ConnectorGlobalState {
                store,
                private_resolver: Arc::new(unavailable_connector_secret_authority()),
            },
        })
    }

    pub(crate) fn observations(&self) -> Arc<ObservationResults> {
        self.shared.observations.clone()
    }

    pub const fn lane_retention() -> LaneRetention {
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
            ConnectorCommand::Upsert {
                connector,
                mut call,
                reply,
            } => {
                if let Some(call) = &call {
                    call.running().await;
                }
                let outcome = upsert(&shared, global, *connector, call.as_mut()).await;
                if let Some(mut call) = call {
                    let status = call.detail.mutation(&outcome);
                    call.finish(status).await;
                }
                let _ = reply.send(outcome);
            }
            ConnectorCommand::Remove {
                id,
                mut call,
                reply,
            } => {
                if let Some(call) = &call {
                    call.running().await;
                }
                let outcome = remove(&shared, global, &id, call.as_mut()).await;
                if let Some(mut call) = call {
                    let status = call.detail.mutation(&outcome);
                    call.finish(status).await;
                }
                let _ = reply.send(outcome);
            }
            ConnectorCommand::ConfigurePrivateResolver { resolver, reply } => {
                global.private_resolver = resolver;
                let _ = reconcile_connector_projection(&shared, global).await;
                let _ = reply.send(());
            }
            ConnectorCommand::SetSessionMcpServerEnabled {
                target,
                call,
                reply,
            } => {
                if let Some(call) = &call {
                    call.running().await;
                }
                let outcome = set_session_mcp_server_enabled(&shared, global, target).await;
                if let Some(mut call) = call {
                    let status = match outcome {
                        ConnectorSessionMcpServerEnabledReceipt::Applied => {
                            call.detail.result = Some(CallResult::AppliedNextRun);
                            CallStatus::Succeeded
                        }
                        ConnectorSessionMcpServerEnabledReceipt::Unavailable => {
                            call.detail.result = Some(CallResult::Unavailable);
                            CallStatus::Failed
                        }
                    };
                    call.finish(status).await;
                }
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
        ConnectorQuery::List { call, reply } => {
            if let Some(call) = &call {
                call.running().await;
            }
            let connectors: Vec<_> = domain::connector_list(&catalog(global))
                .into_iter()
                .map(ConnectorRecord::from_domain)
                .collect();
            if let Some(mut call) = call {
                call.detail.count = Some(
                    connectors
                        .iter()
                        .filter(|connector| {
                            !connector
                                .mcp_server_program
                                .as_ref()
                                .is_some_and(|program| {
                                    matches!(program.source, McpProgramSource::SystemRuntime)
                                })
                        })
                        .count(),
                );
                call.detail.result = Some(CallResult::Available);
                call.finish(CallStatus::Succeeded).await;
            }
            let _ = reply.send(ConnectorListReceipt::Available(connectors));
        }
        ConnectorQuery::Catalog { call, reply } => {
            if let Some(call) = &call {
                call.running().await;
            }
            let programs = catalog_programs(&catalog(global));
            if let Some(mut call) = call {
                call.detail.count = Some(programs.len());
                call.detail.result = Some(CallResult::Available);
                call.finish(CallStatus::Succeeded).await;
            }
            let _ = reply.send(ConnectorCatalogReceipt::Available(programs));
        }
        ConnectorQuery::Status { mut call } => {
            if call.start().await.is_err() {
                shared.observations.discard(call.context.id());
                call.detail.result = Some(CallResult::Unavailable);
                call.finish(CallStatus::Failed).await;
                return;
            }
            let outcome = status(&shared, domain::user_connectors(&catalog(global))).await;
            let status = match outcome {
                ConnectorStatusReceipt::Available(statuses) => {
                    call.detail.observations(&statuses);
                    call.detail.result = Some(CallResult::Available);
                    shared
                        .observations
                        .complete(call.context.id(), ObservationResult::Status(statuses));
                    CallStatus::Succeeded
                }
                ConnectorStatusReceipt::Unavailable => {
                    shared.observations.discard(call.context.id());
                    call.detail.result = Some(CallResult::Unavailable);
                    CallStatus::Failed
                }
            };
            call.finish(status).await;
        }
        ConnectorQuery::Get { id, call, reply } => {
            if let Some(call) = &call {
                call.running().await;
            }
            let outcome = domain::connector(&catalog(global), &id)
                .map(ConnectorRecord::from_domain)
                .map(|connector| ConnectorGetReceipt::Found(Box::new(connector)))
                .unwrap_or(ConnectorGetReceipt::Missing);
            if let Some(mut call) = call {
                revision_detail(global, &id, &mut call.detail);
                call.detail.result = Some(match &outcome {
                    ConnectorGetReceipt::Found(connector)
                        if connector
                            .mcp_server_program
                            .as_ref()
                            .is_some_and(|program| {
                                matches!(program.source, McpProgramSource::SystemRuntime)
                            }) =>
                    {
                        CallResult::Missing
                    }
                    ConnectorGetReceipt::Found(_) => CallResult::Found,
                    ConnectorGetReceipt::Missing => CallResult::Missing,
                });
                call.finish(CallStatus::Succeeded).await;
            }
            let _ = reply.send(outcome);
        }
        ConnectorQuery::Probe { id, mut call } => {
            if call.start().await.is_err() {
                shared.observations.discard(call.context.id());
                call.detail.result = Some(CallResult::Unavailable);
                call.finish(CallStatus::Failed).await;
                return;
            }
            let connector = domain::connector(&catalog(global), &id);
            let outcome = probe(&shared, connector).await;
            let status = match outcome {
                ConnectorProbeReceipt::Observed(observation) => {
                    call.detail.observations.push(ObservationSummary {
                        connector_id: id.clone(),
                        result_type: observation_status(&observation),
                    });
                    call.detail.result = Some(CallResult::Available);
                    shared
                        .observations
                        .complete(call.context.id(), ObservationResult::Probe(id, observation));
                    CallStatus::Succeeded
                }
                ConnectorProbeReceipt::Missing => {
                    shared.observations.discard(call.context.id());
                    call.detail.result = Some(CallResult::Missing);
                    CallStatus::Succeeded
                }
                ConnectorProbeReceipt::Unavailable => {
                    shared.observations.discard(call.context.id());
                    call.detail.result = Some(CallResult::Unavailable);
                    CallStatus::Failed
                }
            };
            call.finish(status).await;
        }
        ConnectorQuery::SessionStatus {
            target,
            session_identity,
            mut call,
        } => {
            if call.start().await.is_err() {
                shared.observations.discard(call.context.id());
                call.detail.result = Some(CallResult::Unavailable);
                call.finish(CallStatus::Failed).await;
                return;
            }
            let ConnectorSessionStatusReceipt::Available(mut statuses) =
                session_connector_status(&shared, global, target).await;
            statuses.retain(|status| status.server.connector_id.as_deref() != Some("matcha"));
            call.detail.servers(&statuses);
            call.detail.result = Some(CallResult::Available);
            shared.observations.complete(
                call.context.id(),
                ObservationResult::SessionStatus {
                    session_identity,
                    statuses: statuses
                        .into_iter()
                        .map(crate::api::map_session_mcp_server_status)
                        .collect(),
                },
            );
            call.finish(CallStatus::Succeeded).await;
        }
        ConnectorQuery::OpenClawMcpServers { call, reply } => {
            if let Some(call) = &call {
                call.running().await;
            }
            let outcome = openclaw_mcp_servers(&shared, global).await;
            if let Some(mut call) = call {
                let status = match &outcome {
                    OpenClawMcpServersReceipt::Available(servers) => {
                        call.detail.count = Some(servers.len());
                        call.detail.result = Some(CallResult::Available);
                        CallStatus::Succeeded
                    }
                    OpenClawMcpServersReceipt::Unavailable => {
                        call.detail.result = Some(CallResult::Unavailable);
                        CallStatus::Failed
                    }
                };
                call.finish(status).await;
            }
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
    mut call: Option<&mut ConnectorCall>,
) -> ConnectorMutationReceipt {
    if domain::is_system_runtime_connector(&connector) {
        return ConnectorMutationReceipt::Rejected;
    }

    let mutation = match global.store.upsert(connector.clone()) {
        Ok(mutation) => mutation,
        Err(error) => return mutation_error(error),
    };

    if let Some(call) = call.as_deref_mut() {
        call.detail.created = Some(mutation.created);
    }
    record_revision(global, connector.id(), call.as_deref_mut()).await;
    let configuration = reconcile_connector_projection(shared, global).await;
    if let Some(call) = call.as_deref_mut() {
        call.detail
            .projection(&map_projection_effect(configuration));
    }

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

    record_revision(global, connector.id(), call).await;
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
    mut call: Option<&mut ConnectorCall>,
) -> ConnectorMutationReceipt {
    match global.store.remove(id) {
        Ok(None) => ConnectorMutationReceipt::Missing,
        Ok(Some(revision)) => {
            record_revision(global, id, call.as_deref_mut()).await;
            let configuration = reconcile_connector_projection(shared, global).await;
            if let Some(call) = call.as_deref_mut() {
                call.detail
                    .projection(&map_projection_effect(configuration));
            }

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

            record_revision(global, id, call).await;
            ConnectorMutationReceipt::Removed {
                revision,
                configuration: map_projection_effect(configuration),
            }
        }
        Err(error) => mutation_error(error),
    }
}

fn revision_detail(global: &ConnectorGlobalState, id: &str, detail: &mut ConnectorCallDetail) {
    detail.revision = global.store.revision(id);
    detail.applied_revision = global.store.applied_revision(id);
    detail.tombstoned = global.store.tombstoned(id);
}

async fn record_revision(
    global: &ConnectorGlobalState,
    id: &str,
    call: Option<&mut ConnectorCall>,
) {
    if let Some(call) = call {
        revision_detail(global, id, &mut call.detail);
        if let Err(error) = call.context.update(&call.detail).await {
            eprintln!("connector revision could not be recorded: {error}");
        }
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
    let Some(ops) = shared.runtime_directory.connector_ops() else {
        return ConnectorProjectionEffect::Unavailable;
    };
    ops.apply_runtime_mcp_projection(
        Some(TeamRunMcpPreset::new(
            &shared.runtime_host_mcp_executable,
            &shared.team_run_mcp_state_dir,
        )),
        catalog(global),
        global.private_resolver.as_ref(),
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
    let Some(ops) = shared
        .runtime_directory
        .connector_ops_for_endpoint(&endpoint)
    else {
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
    let Some(ops) = shared.runtime_directory.connector_ops() else {
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
    let Some(ops) = shared.runtime_directory.connector_ops() else {
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
    if domain::is_system_runtime_connector(&connector) {
        return ConnectorProbeReceipt::Missing;
    }
    let Some(ops) = shared.runtime_directory.connector_ops() else {
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

    let Some(ops) = shared
        .runtime_directory
        .connector_ops_for_endpoint(&endpoint)
    else {
        return ConnectorSessionStatusReceipt::Available(Vec::new());
    };

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
            DomainConnectorKind::McpStdio => Some(ConnectorCatalogProgram {
                id: program_id(connector),
                source: program_source(connector),
                display_name: display_name(connector),
                connector_kinds: vec![ConnectorKind::McpStdio],
                transport: None,
                command: connector.command().map(str::to_owned),
                args: connector.args().map(<[_]>::to_vec),
                url: None,
                root_path: connector.cwd().map(str::to_owned),
                env_keys: string_map_keys(connector.env()),
                header_keys: None,
            }),
            DomainConnectorKind::McpHttp => Some(ConnectorCatalogProgram {
                id: program_id(connector),
                source: program_source(connector),
                display_name: display_name(connector),
                connector_kinds: vec![ConnectorKind::McpHttp],
                transport: connector.transport().map(map_mcp_transport),
                command: None,
                args: None,
                url: connector.url().map(str::to_owned),
                root_path: None,
                env_keys: None,
                header_keys: string_map_keys(connector.headers()),
            }),
            DomainConnectorKind::Cli | DomainConnectorKind::Sdk | DomainConnectorKind::Http => None,
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
        .map(map_mcp_program_source)
        .unwrap_or(McpProgramSource::ManagedLocal)
}

fn map_mcp_program_source(source: DomainMcpProgramSource) -> McpProgramSource {
    match source {
        DomainMcpProgramSource::SystemRuntime => McpProgramSource::SystemRuntime,
        DomainMcpProgramSource::ExternalCommand => McpProgramSource::ExternalCommand,
        DomainMcpProgramSource::ExternalUrl => McpProgramSource::ExternalUrl,
        DomainMcpProgramSource::BundledPlugin => McpProgramSource::BundledPlugin,
        DomainMcpProgramSource::BundledMcpApp => McpProgramSource::BundledMcpApp,
        DomainMcpProgramSource::ManagedLocal => McpProgramSource::ManagedLocal,
    }
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

fn map_mcp_transport(transport: DomainMcpTransport) -> McpTransport {
    match transport {
        DomainMcpTransport::StreamableHttp => McpTransport::StreamableHttp,
        DomainMcpTransport::Sse => McpTransport::Sse,
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
