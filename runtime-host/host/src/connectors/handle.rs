use environment::connectors::{Connector, McpProgramSource as DomainMcpProgramSource};
use foundation::execution::OwnerRuntimeHandle;
use tokio::sync::oneshot;

use super::{
    command::{ConnectorCommand, ConnectorQuery},
    receipt::{
        ConnectorCatalogProgram, ConnectorCatalogReceipt, ConnectorGetReceipt,
        ConnectorListReceipt, ConnectorMutationReceipt, ConnectorObservationReceipt,
        ConnectorProbeReceipt, ConnectorProjectionReceipt, ConnectorRecord,
        ConnectorSessionEndpoint, ConnectorSessionMcpServerEnabledReceipt,
        ConnectorSessionMcpServerEnabledTarget, ConnectorSessionMcpServerState,
        ConnectorSessionMcpServerStatus, ConnectorSessionMcpServerStatusDetails,
        ConnectorSessionStatusReceipt, ConnectorSessionTarget, ConnectorStatusReceipt,
        OpenClawMcpServersReceipt, RuntimeMcpServerKind, RuntimeMcpServerSource,
        RuntimeMcpServerSummary,
    },
};
use crate::{
    provider::auth::Resolver,
    runtime::external_connectors::{
        CatalogOutcome, ConnectorObservation, ConnectorProjectionEffect, ConnectorReadModel,
        ConnectorSecretReference, ConnectorSecretReferenceKind, ExternalMcpProgram, GetOutcome,
        ListOutcome, McpProgramSource, McpServerKind, MutationOutcome, OpenClawMcpServerSource,
        OpenClawMcpServerSummary, OpenClawMcpServersOutcome, ProbeOutcome,
        SessionConnectorResultType, SessionConnectorStatus, SessionConnectorStatusDetails,
        SessionEndpoint, SessionMcpServerEnabledOutcome, SessionMcpServerEnabledTarget,
        SessionStatusOutcome, SessionStatusTarget, StatusOutcome,
    },
};

#[derive(Clone)]
pub(crate) struct ConnectorHandle {
    owner: OwnerRuntimeHandle<ConnectorCommand, ConnectorQuery>,
}

impl ConnectorHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<ConnectorCommand, ConnectorQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn list(&self) -> Result<ListOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::List { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map(map_list_receipt).map_err(|_| ())
    }

    pub(crate) async fn catalog(&self) -> Result<CatalogOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::Catalog { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map(map_catalog_receipt).map_err(|_| ())
    }

    pub(crate) async fn status(&self) -> Result<StatusOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::Status { reply })
            .await
            .map_err(|_| ())?;
        rx.await.map(map_status_receipt).map_err(|_| ())
    }

    pub(crate) async fn get(&self, id: String) -> Result<GetOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::Get { id, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map(map_get_receipt).map_err(|_| ())
    }

    pub(crate) async fn upsert(&self, connector: Connector) -> Result<MutationOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ConnectorCommand::Upsert {
                connector: Box::new(connector),
                reply,
            })
            .await
            .map_err(|_| ())?;
        rx.await.map(map_mutation_receipt).map_err(|_| ())
    }

    pub(crate) async fn remove(&self, id: String) -> Result<MutationOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ConnectorCommand::Remove { id, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map(map_mutation_receipt).map_err(|_| ())
    }

    pub(crate) async fn probe(&self, id: String) -> Result<ProbeOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::Probe { id, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map(map_probe_receipt).map_err(|_| ())
    }

    pub(crate) async fn session_status(
        &self,
        target: SessionStatusTarget,
    ) -> Result<SessionStatusOutcome, ()> {
        let Some(target) = connector_session_target(target) else {
            return Ok(SessionStatusOutcome::Unavailable);
        };
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::SessionStatus { target, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map(map_session_status_receipt).map_err(|_| ())
    }

    pub(crate) async fn openclaw_mcp_servers(&self) -> Result<OpenClawMcpServersOutcome, ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_query(ConnectorQuery::OpenClawMcpServers { reply })
            .await
            .map_err(|_| ())?;
        rx.await
            .map(map_openclaw_mcp_servers_receipt)
            .map_err(|_| ())
    }

    pub(crate) async fn set_session_mcp_server_enabled(
        &self,
        target: SessionMcpServerEnabledTarget,
    ) -> Result<SessionMcpServerEnabledOutcome, ()> {
        let Some(target) = connector_session_mcp_server_enabled_target(target) else {
            return Ok(SessionMcpServerEnabledOutcome::Unavailable);
        };
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ConnectorCommand::SetSessionMcpServerEnabled { target, reply })
            .await
            .map_err(|_| ())?;
        rx.await
            .map(map_session_mcp_server_enabled_receipt)
            .map_err(|_| ())
    }

    pub(crate) async fn configure_private_resolver(&self, resolver: Resolver) -> Result<(), ()> {
        let (reply, rx) = oneshot::channel();
        self.owner
            .send_command(ConnectorCommand::ConfigurePrivateResolver { resolver, reply })
            .await
            .map_err(|_| ())?;
        rx.await.map_err(|_| ())
    }
}

fn connector_session_target(target: SessionStatusTarget) -> Option<ConnectorSessionTarget> {
    if !target.is_valid() {
        return None;
    }
    Some(ConnectorSessionTarget {
        endpoint: connector_session_endpoint(target.session_identity.endpoint),
        session_key: target.session_identity.session_key,
    })
}

fn connector_session_mcp_server_enabled_target(
    target: SessionMcpServerEnabledTarget,
) -> Option<ConnectorSessionMcpServerEnabledTarget> {
    if !target.is_valid() {
        return None;
    }
    Some(ConnectorSessionMcpServerEnabledTarget {
        session: ConnectorSessionTarget {
            endpoint: connector_session_endpoint(target.session_identity.endpoint),
            session_key: target.session_identity.session_key,
        },
        server_id: target.server_id,
        enabled: target.enabled,
    })
}

fn connector_session_endpoint(endpoint: SessionEndpoint) -> ConnectorSessionEndpoint {
    match endpoint {
        SessionEndpoint::Native {
            runtime_adapter_id,
            runtime_instance_id,
        } => ConnectorSessionEndpoint::Native {
            runtime_adapter_id,
            runtime_instance_id,
        },
        SessionEndpoint::ProtocolConnector { .. } => ConnectorSessionEndpoint::ProtocolConnector,
    }
}

fn map_list_receipt(receipt: ConnectorListReceipt) -> ListOutcome {
    match receipt {
        ConnectorListReceipt::Available(connectors) => {
            ListOutcome::Available(connectors.into_iter().map(map_connector_record).collect())
        }
    }
}

fn map_get_receipt(receipt: ConnectorGetReceipt) -> GetOutcome {
    match receipt {
        ConnectorGetReceipt::Found(connector) => {
            GetOutcome::Found(Box::new(map_connector_record(*connector)))
        }
        ConnectorGetReceipt::Missing => GetOutcome::Missing,
    }
}

fn map_mutation_receipt(receipt: ConnectorMutationReceipt) -> MutationOutcome {
    match receipt {
        ConnectorMutationReceipt::Stored {
            connector,
            created,
            revision,
            configuration,
        } => MutationOutcome::Stored {
            connector: Box::new(map_connector_record(*connector)),
            created,
            revision,
            configuration: map_projection_receipt(configuration),
        },
        ConnectorMutationReceipt::Removed {
            revision,
            configuration,
        } => MutationOutcome::Removed {
            revision,
            configuration: map_projection_receipt(configuration),
        },
        ConnectorMutationReceipt::Missing => MutationOutcome::Missing,
        ConnectorMutationReceipt::Rejected => MutationOutcome::Rejected,
        ConnectorMutationReceipt::Unknown => MutationOutcome::Unknown,
        ConnectorMutationReceipt::Unavailable => MutationOutcome::Unavailable,
    }
}

fn map_probe_receipt(receipt: ConnectorProbeReceipt) -> ProbeOutcome {
    match receipt {
        ConnectorProbeReceipt::Observed(observation) => {
            ProbeOutcome::Observed(map_observation_receipt(observation))
        }
        ConnectorProbeReceipt::Missing => ProbeOutcome::Missing,
        ConnectorProbeReceipt::Unavailable => ProbeOutcome::Unavailable,
    }
}

fn map_status_receipt(receipt: ConnectorStatusReceipt) -> StatusOutcome {
    match receipt {
        ConnectorStatusReceipt::Available(statuses) => StatusOutcome::Available(
            statuses
                .into_iter()
                .map(|(id, observation)| (id, map_observation_receipt(observation)))
                .collect(),
        ),
        ConnectorStatusReceipt::Unavailable => StatusOutcome::Unavailable,
    }
}

fn map_catalog_receipt(receipt: ConnectorCatalogReceipt) -> CatalogOutcome {
    match receipt {
        ConnectorCatalogReceipt::Available(programs) => {
            CatalogOutcome::Available(programs.into_iter().map(map_catalog_program).collect())
        }
    }
}

fn map_connector_record(connector: ConnectorRecord) -> ConnectorReadModel {
    ConnectorReadModel {
        id: connector.id,
        kind: connector.kind,
        display_name: connector.display_name,
        description: connector.description,
        enabled: connector.enabled,
        workspace_id: connector.workspace_id,
        source_id: connector.source_id,
        mcp_server_program: connector.mcp_server_program,
        tags: connector.tags,
        command: connector.command,
        args: connector.args,
        cwd: connector.cwd,
        env: connector.env,
        url: connector.url,
        transport: connector.transport,
        connection_timeout_ms: connector.connection_timeout_ms,
        headers: connector.headers,
        base_url: connector.base_url,
        provider: connector.provider,
        package_name: connector.package_name,
        config: connector.config,
        secret_env: secret_reference_map(connector.secret_env),
        secret_headers: secret_reference_map(connector.secret_headers),
        secret_config_refs: secret_reference_map(connector.secret_config_refs),
    }
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

fn secret_reference_map(
    references: std::collections::BTreeMap<String, String>,
) -> Option<std::collections::BTreeMap<String, ConnectorSecretReference>> {
    if references.is_empty() {
        return None;
    }
    Some(
        references
            .into_iter()
            .map(|(key, reference)| {
                (
                    key,
                    ConnectorSecretReference {
                        kind: ConnectorSecretReferenceKind::SecretRef,
                        reference,
                    },
                )
            })
            .collect(),
    )
}

fn map_catalog_program(program: ConnectorCatalogProgram) -> ExternalMcpProgram {
    ExternalMcpProgram {
        id: program.id,
        source: map_mcp_program_source(program.source),
        display_name: program.display_name,
        connector_kinds: program.connector_kinds,
        transport: program.transport,
        command: program.command,
        args: program.args,
        url: program.url,
        root_path: program.root_path,
        env_keys: program.env_keys,
        header_keys: program.header_keys,
    }
}

fn map_projection_receipt(receipt: ConnectorProjectionReceipt) -> ConnectorProjectionEffect {
    match receipt {
        ConnectorProjectionReceipt::Written { changed } => {
            ConnectorProjectionEffect::Written { changed }
        }
        ConnectorProjectionReceipt::Unknown => ConnectorProjectionEffect::Unknown,
        ConnectorProjectionReceipt::Unavailable => ConnectorProjectionEffect::Unavailable,
    }
}

fn map_observation_receipt(receipt: ConnectorObservationReceipt) -> ConnectorObservation {
    match receipt {
        ConnectorObservationReceipt::Connected => ConnectorObservation::Connected,
        ConnectorObservationReceipt::Disconnected => ConnectorObservation::Disconnected,
        ConnectorObservationReceipt::Disabled => ConnectorObservation::Disabled,
        ConnectorObservationReceipt::Unsupported => ConnectorObservation::Unsupported,
        ConnectorObservationReceipt::Unknown => ConnectorObservation::Unknown,
    }
}

fn map_openclaw_mcp_servers_receipt(
    receipt: OpenClawMcpServersReceipt,
) -> OpenClawMcpServersOutcome {
    match receipt {
        OpenClawMcpServersReceipt::Available(servers) => OpenClawMcpServersOutcome::Available(
            servers
                .into_iter()
                .map(map_runtime_mcp_server_summary)
                .collect(),
        ),
        OpenClawMcpServersReceipt::Unavailable => OpenClawMcpServersOutcome::Unavailable,
    }
}

fn map_session_status_receipt(receipt: ConnectorSessionStatusReceipt) -> SessionStatusOutcome {
    match receipt {
        ConnectorSessionStatusReceipt::Available(statuses) => SessionStatusOutcome::Available(
            statuses
                .into_iter()
                .map(map_session_mcp_server_status)
                .collect(),
        ),
    }
}

fn map_session_mcp_server_enabled_receipt(
    receipt: ConnectorSessionMcpServerEnabledReceipt,
) -> SessionMcpServerEnabledOutcome {
    match receipt {
        ConnectorSessionMcpServerEnabledReceipt::Applied => SessionMcpServerEnabledOutcome::Applied,
        ConnectorSessionMcpServerEnabledReceipt::Unavailable => {
            SessionMcpServerEnabledOutcome::Unavailable
        }
    }
}

fn map_runtime_mcp_server_summary(server: RuntimeMcpServerSummary) -> OpenClawMcpServerSummary {
    OpenClawMcpServerSummary {
        server_id: server.server_id,
        connector_id: server.connector_id,
        display_name: server.display_name,
        description: server.description,
        kind: map_runtime_mcp_server_kind(server.kind),
        source: map_runtime_mcp_server_source(server.source),
        enabled: server.enabled,
        managed: server.managed,
        editable: server.editable,
        removable: server.removable,
    }
}

fn map_runtime_mcp_server_kind(kind: RuntimeMcpServerKind) -> McpServerKind {
    match kind {
        RuntimeMcpServerKind::McpStdio => McpServerKind::McpStdio,
        RuntimeMcpServerKind::McpHttp => McpServerKind::McpHttp,
        RuntimeMcpServerKind::Unknown => McpServerKind::Unknown,
    }
}

fn map_runtime_mcp_server_source(source: RuntimeMcpServerSource) -> OpenClawMcpServerSource {
    match source {
        RuntimeMcpServerSource::Preset => OpenClawMcpServerSource::Preset,
        RuntimeMcpServerSource::External => OpenClawMcpServerSource::External,
        RuntimeMcpServerSource::OpenClaw => OpenClawMcpServerSource::Openclaw,
    }
}

fn map_session_mcp_server_status(
    status: ConnectorSessionMcpServerStatus,
) -> SessionConnectorStatus {
    let connector_id = status
        .server
        .connector_id
        .clone()
        .unwrap_or_else(|| status.server.server_id.clone());
    SessionConnectorStatus {
        connector_id,
        display_name: Some(status.server.display_name),
        adapter_id: "openclaw".into(),
        target_kind: "session",
        result_type: session_result_type(status.state),
        reason: Some(session_status_reason(status.state).into()),
        details: Some(map_session_status_details(status.details)),
    }
}

fn map_session_status_details(
    details: ConnectorSessionMcpServerStatusDetails,
) -> SessionConnectorStatusDetails {
    SessionConnectorStatusDetails {
        server_id: Some(details.server_id),
        session_key: None,
        tool_count: details.tool_count,
        launch_summary: details.launch_summary,
        enabled_next_run: Some(details.enabled_next_run),
        enabled_configurable: Some(details.enabled_configurable),
    }
}

fn session_result_type(state: ConnectorSessionMcpServerState) -> SessionConnectorResultType {
    match state {
        ConnectorSessionMcpServerState::DisabledByConfiguration
        | ConnectorSessionMcpServerState::NativeDisabled
        | ConnectorSessionMcpServerState::NativeEnabledFalse => {
            SessionConnectorResultType::Disabled
        }
        ConnectorSessionMcpServerState::NativeConnected
        | ConnectorSessionMcpServerState::NativeAvailable => SessionConnectorResultType::Connected,
        ConnectorSessionMcpServerState::MissingFromNativeStatus
        | ConnectorSessionMcpServerState::NativeDisconnected
        | ConnectorSessionMcpServerState::NativeError => SessionConnectorResultType::Disconnected,
        ConnectorSessionMcpServerState::NativeStatusUnavailable => {
            SessionConnectorResultType::Unknown
        }
        ConnectorSessionMcpServerState::NativeNotConnected
        | ConnectorSessionMcpServerState::NativeListingTools
        | ConnectorSessionMcpServerState::NativeStaleConfig
        | ConnectorSessionMcpServerState::NativePending => SessionConnectorResultType::Pending,
    }
}

fn session_status_reason(state: ConnectorSessionMcpServerState) -> &'static str {
    match state {
        ConnectorSessionMcpServerState::DisabledByConfiguration => {
            "OpenClaw MCP server is disabled"
        }
        ConnectorSessionMcpServerState::MissingFromNativeStatus => {
            "OpenClaw MCP status did not include this server"
        }
        ConnectorSessionMcpServerState::NativeStatusUnavailable => {
            "OpenClaw MCP status is unavailable for this session"
        }
        ConnectorSessionMcpServerState::NativeDisabled => {
            "OpenClaw MCP server is disabled for this session"
        }
        ConnectorSessionMcpServerState::NativeNotConnected => {
            "OpenClaw MCP server is configured but not connected for this session yet"
        }
        ConnectorSessionMcpServerState::NativeListingTools => {
            "OpenClaw MCP server is connected but has not finished listing tools yet"
        }
        ConnectorSessionMcpServerState::NativeStaleConfig => {
            "OpenClaw MCP server configuration changed; the next run will refresh it"
        }
        ConnectorSessionMcpServerState::NativeConnected => {
            "OpenClaw MCP server is connected for this session"
        }
        ConnectorSessionMcpServerState::NativeDisconnected => {
            "OpenClaw MCP server is disconnected for this session"
        }
        ConnectorSessionMcpServerState::NativeError => {
            "OpenClaw MCP server reported an error for this session"
        }
        ConnectorSessionMcpServerState::NativeEnabledFalse => {
            "OpenClaw MCP server is disabled for this session"
        }
        ConnectorSessionMcpServerState::NativeAvailable => {
            "OpenClaw MCP server is connected for this session"
        }
        ConnectorSessionMcpServerState::NativePending => {
            "OpenClaw MCP status is pending for this session"
        }
    }
}
