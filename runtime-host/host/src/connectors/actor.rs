use std::sync::Arc;

use environment::{Connector, ConnectorStore, ConnectorStoreError};
use foundation::execution::{LaneRetention, OwnerSpec};
use openclaw::{
    gateway::wire::McpServerStatusList,
    lifecycle::state_dir::CanonicalStateDir,
    projection::connector::{
        catalog::discover_external_mcp_programs,
        external::{ConnectorProjectionEffect, managed_external_server_id},
    },
};

use super::command::{ConnectorCommand, ConnectorOwnerKey, ConnectorQuery};
use crate::{
    external_connectors::{
        CatalogOutcome, GetOutcome, ListOutcome, MutationOutcome, ProbeOutcome,
        SessionConnectorResultType, SessionConnectorStatus, SessionConnectorStatusDetails,
        SessionEndpoint, SessionIdentity, SessionStatusOutcome, StatusOutcome,
    },
    runtime_directory::RuntimeDriverDirectory,
};

pub(crate) struct ConnectorOwnerInput {
    pub(crate) state_dir: CanonicalStateDir,
    pub(crate) runtime_directory: Arc<RuntimeDriverDirectory>,
}

#[derive(Clone)]
pub(crate) struct ConnectorShared {
    runtime_directory: Arc<RuntimeDriverDirectory>,
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
                let _ = reply.send(());
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
        ConnectorQuery::SessionStatus { identity, reply } => {
            let connectors = connectors(global)
                .into_iter()
                .filter(|connector| !is_private_system_runtime_connector(connector))
                .collect::<Vec<_>>();
            let outcome = session_connector_status(&shared, connectors, identity).await;
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
    ops.apply_external_connector_projection(catalog(global), &global.private_resolver)
        .await
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
    connectors: Vec<Connector>,
    identity: SessionIdentity,
) -> SessionStatusOutcome {
    if !identity.is_valid() {
        return SessionStatusOutcome::Unavailable;
    }

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
        return SessionStatusOutcome::Available(
            connectors
                .into_iter()
                .map(|connector| SessionConnectorStatus {
                    connector_id: connector.id,
                    display_name: connector.display_name,
                    adapter_id: "openclaw".into(),
                    target_kind: "session",
                    result_type: SessionConnectorResultType::Unsupported,
                    reason: Some(
                        "protocol connector session status is unsupported by the OpenClaw Gateway"
                            .into(),
                    ),
                    details: Some(SessionConnectorStatusDetails {
                        server_id: None,
                        session_key: Some(identity.session_key.clone()),
                        tool_count: None,
                        launch_summary: None,
                    }),
                })
                .collect(),
        );
    };

    let driver = shared.runtime_directory.lookup(&endpoint);
    let Some(driver) = driver.filter(|driver| driver.connector_ops().is_some()) else {
        return SessionStatusOutcome::Available(
            connectors
                .into_iter()
                .map(|connector| SessionConnectorStatus {
                    connector_id: connector.id,
                    display_name: connector.display_name,
                    adapter_id: endpoint.runtime_adapter_id().to_owned(),
                    target_kind: "session",
                    result_type: SessionConnectorResultType::Unsupported,
                    reason: Some(
                        "connector session status is only supported by OpenClaw runtime".into(),
                    ),
                    details: Some(SessionConnectorStatusDetails {
                        server_id: None,
                        session_key: Some(identity.session_key.clone()),
                        tool_count: None,
                        launch_summary: None,
                    }),
                })
                .collect(),
        );
    };
    let ops = driver
        .connector_ops()
        .expect("connector driver advertised ops");

    let statuses = ops
        .observe_mcp_server_status(identity.session_key.clone(), None)
        .await;

    let statuses = match statuses {
        Ok(statuses) => statuses,
        Err(_) => {
            return SessionStatusOutcome::Available(unknown_session_statuses(
                connectors,
                &identity.session_key,
            ));
        }
    };

    SessionStatusOutcome::Available(
        connectors
            .into_iter()
            .map(|connector| {
                session_status_for_connector(connector, &identity.session_key, &statuses)
            })
            .collect(),
    )
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

fn unknown_session_statuses(
    connectors: Vec<Connector>,
    session_key: &str,
) -> Vec<SessionConnectorStatus> {
    connectors
        .into_iter()
        .map(|connector| SessionConnectorStatus {
            connector_id: connector.id,
            display_name: connector.display_name,
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: SessionConnectorResultType::Unknown,
            reason: Some("OpenClaw MCP status is unavailable for this session".into()),
            details: Some(SessionConnectorStatusDetails {
                server_id: None,
                session_key: Some(session_key.to_owned()),
                tool_count: None,
                launch_summary: None,
            }),
        })
        .collect()
}

fn session_status_for_connector(
    connector: Connector,
    session_key: &str,
    statuses: &McpServerStatusList,
) -> SessionConnectorStatus {
    let connector_id = connector.id.clone();
    let server_id = managed_external_server_id(&connector_id);
    let details = SessionConnectorStatusDetails {
        server_id: Some(server_id.clone()),
        session_key: Some(session_key.to_owned()),
        tool_count: None,
        launch_summary: None,
    };

    if !connector.enabled() {
        return SessionConnectorStatus {
            connector_id,
            display_name: connector.display_name,
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: SessionConnectorResultType::Disabled,
            reason: Some("connector is disabled".into()),
            details: Some(details),
        };
    }

    if !matches!(
        connector.kind,
        environment::ConnectorKind::McpHttp | environment::ConnectorKind::McpStdio
    ) {
        return SessionConnectorStatus {
            connector_id,
            display_name: connector.display_name,
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: SessionConnectorResultType::Unsupported,
            reason: Some("connector has no OpenClaw MCP session projection".into()),
            details: Some(details),
        };
    }

    let Some(server) = statuses
        .servers
        .iter()
        .find(|server| server.name == server_id)
    else {
        return SessionConnectorStatus {
            connector_id,
            display_name: connector.display_name,
            adapter_id: "openclaw".into(),
            target_kind: "session",
            result_type: SessionConnectorResultType::Disconnected,
            reason: Some("OpenClaw MCP status did not include the projected connector".into()),
            details: Some(details),
        };
    };

    let available = server.available.unwrap_or(true);
    let details = SessionConnectorStatusDetails {
        server_id: Some(server_id),
        session_key: Some(session_key.to_owned()),
        tool_count: server.tool_count,
        launch_summary: None,
    };

    SessionConnectorStatus {
        connector_id,
        display_name: connector.display_name,
        adapter_id: "openclaw".into(),
        target_kind: "session",
        result_type: if available {
            SessionConnectorResultType::Connected
        } else {
            SessionConnectorResultType::Disconnected
        },
        reason: Some(if available {
            "OpenClaw MCP status reported the server as available".into()
        } else {
            "OpenClaw MCP status reported the server as unavailable".into()
        }),
        details: Some(details),
    }
}
