use std::sync::Arc;

use crate::{domain::Connector, ports::ConnectorSecretResolverPort};
use foundation::execution::OwnerRuntimeHandle;
use platform::call::{CallId, CallReceipt, CallRecorder, CallStatus};

use crate::owner::observations::{
    ObservationReadError, ObservationResult, ObservationResults, SessionObservationSubject,
};

use crate::call::{CallResult, ConnectorCall, ConnectorCallDetail};
use tokio::sync::oneshot;

use crate::application::{
    ConnectorCommand, ConnectorQuery,
    receipts::{
        ConnectorCatalogProgram, ConnectorCatalogReceipt, ConnectorGetReceipt,
        ConnectorListReceipt, ConnectorMutationReceipt, ConnectorObservationReceipt,
        ConnectorProjectionReceipt, ConnectorRecord, ConnectorSessionEndpoint,
        ConnectorSessionMcpServerEnabledReceipt, ConnectorSessionMcpServerEnabledTarget,
        ConnectorSessionMcpServerState, ConnectorSessionMcpServerStatus,
        ConnectorSessionMcpServerStatusDetails, ConnectorSessionTarget, OpenClawMcpServersReceipt,
        RuntimeMcpServerKind, RuntimeMcpServerSource, RuntimeMcpServerSummary,
    },
};
use crate::delivery::{
    CatalogOutcome, ConnectorObservation, ConnectorProjectionEffect, ConnectorReadModel,
    ConnectorSecretReference, ConnectorSecretReferenceKind, ExternalMcpProgram, GetOutcome,
    ListOutcome, McpServerKind, MutationOutcome, OpenClawMcpServerSource, OpenClawMcpServerSummary,
    OpenClawMcpServersOutcome, SessionConnectorResultType, SessionConnectorStatus,
    SessionConnectorStatusDetails, SessionEndpoint, SessionIdentity,
    SessionMcpServerEnabledOutcome, SessionMcpServerEnabledTarget, SessionStatusTarget,
};

#[derive(Clone)]
pub struct ConnectorHandle {
    owner: OwnerRuntimeHandle<ConnectorCommand, ConnectorQuery>,
    recorder: Option<CallRecorder>,
    observations: Arc<ObservationResults>,
}

impl ConnectorHandle {
    pub(crate) fn new(
        owner: OwnerRuntimeHandle<ConnectorCommand, ConnectorQuery>,
        observations: Arc<ObservationResults>,
    ) -> Self {
        Self {
            owner,
            recorder: None,
            observations,
        }
    }

    pub(crate) fn with_call_recorder(mut self, recorder: CallRecorder) -> Self {
        self.recorder = Some(recorder);
        self
    }

    async fn begin(
        &self,
        command: &'static str,
        detail: ConnectorCallDetail,
    ) -> Result<Option<ConnectorCall>, ()> {
        let Some(recorder) = &self.recorder else {
            return Ok(None);
        };
        let context = recorder.begin(command, &detail).await.map_err(|_| ())?;
        Ok(Some(ConnectorCall::new(context, detail)))
    }

    async fn send_query(
        &self,
        query: ConnectorQuery,
        call: Option<ConnectorCall>,
    ) -> Result<(), ()> {
        if self.owner.send_query(query).await.is_err() {
            if let Some(mut call) = call {
                call.detail.result = Some(CallResult::Unavailable);
                call.finish(CallStatus::Rejected).await;
            }
            return Err(());
        }
        if let Some(call) = call {
            call.context.accepted().await.map_err(|_| ())?;
        }
        Ok(())
    }

    async fn send_command(
        &self,
        command: ConnectorCommand,
        call: Option<ConnectorCall>,
    ) -> Result<Option<CallReceipt>, ()> {
        if self.owner.try_send_command(command).is_err() {
            if let Some(mut call) = call {
                call.detail.result = Some(CallResult::Unavailable);
                call.finish(CallStatus::Rejected).await;
            }
            return Err(());
        }
        match call {
            Some(call) => call.context.accepted().await.map(Some).map_err(|_| ()),
            None => Ok(None),
        }
    }

    pub(crate) async fn list(&self) -> Result<ListOutcome, ()> {
        let call = self
            .begin("externalConnectors.list", ConnectorCallDetail::default())
            .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(
            ConnectorQuery::List {
                call: call.clone(),
                reply,
            },
            call,
        )
        .await?;
        rx.await.map(map_list_receipt).map_err(|_| ())
    }

    pub(crate) async fn catalog(&self) -> Result<CatalogOutcome, ()> {
        let call = self
            .begin("externalConnectors.catalog", ConnectorCallDetail::default())
            .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(
            ConnectorQuery::Catalog {
                call: call.clone(),
                reply,
            },
            call,
        )
        .await?;
        rx.await.map(map_catalog_receipt).map_err(|_| ())
    }

    pub(crate) async fn admit_status(&self) -> Result<CallReceipt, ()> {
        let call = self
            .begin("externalConnectors.status", ConnectorCallDetail::default())
            .await?
            .ok_or(())?;
        self.admit_observation(ConnectorQuery::Status { call: call.clone() }, call, None)
            .await
    }

    async fn admit_observation(
        &self,
        query: ConnectorQuery,
        mut call: ConnectorCall,
        session: Option<SessionObservationSubject>,
    ) -> Result<CallReceipt, ()> {
        if self
            .observations
            .reserve(call.context.id(), session)
            .is_err()
        {
            call.detail.result = Some(CallResult::Unavailable);
            call.finish(CallStatus::Rejected).await;
            return Err(());
        }
        if self.owner.try_send_query(query).is_err() {
            self.observations.discard(call.context.id());
            call.detail.result = Some(CallResult::Unavailable);
            call.finish(CallStatus::Rejected).await;
            return Err(());
        }
        call.accepted().await
    }

    pub(crate) fn observation_result(
        &self,
        call_id: &CallId,
        principal: &str,
        session_identity: Option<&SessionIdentity>,
    ) -> Result<ObservationResult, ObservationReadError> {
        self.observations.read(call_id, principal, session_identity)
    }

    pub(crate) async fn get(&self, id: String) -> Result<GetOutcome, ()> {
        let call = self
            .begin(
                "externalConnectors.get",
                ConnectorCallDetail::connector(&id),
            )
            .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(
            ConnectorQuery::Get {
                id,
                call: call.clone(),
                reply,
            },
            call,
        )
        .await?;
        rx.await.map(map_get_receipt).map_err(|_| ())
    }

    async fn enqueue_upsert(
        &self,
        connector: Connector,
    ) -> Result<
        (
            oneshot::Receiver<ConnectorMutationReceipt>,
            Option<CallReceipt>,
        ),
        (),
    > {
        let call = self
            .begin(
                "externalConnectors.upsert",
                ConnectorCallDetail::connector(connector.id()),
            )
            .await?;
        let (reply, rx) = oneshot::channel();
        let receipt = self
            .send_command(
                ConnectorCommand::Upsert {
                    connector: Box::new(connector),
                    call: call.clone(),
                    reply,
                },
                call,
            )
            .await?;
        Ok((rx, receipt))
    }

    pub(crate) async fn upsert(&self, connector: Connector) -> Result<MutationOutcome, ()> {
        let (rx, _) = self.enqueue_upsert(connector).await?;
        rx.await.map(map_mutation_receipt).map_err(|_| ())
    }

    pub(crate) async fn admit_upsert(&self, connector: Connector) -> Result<CallReceipt, ()> {
        self.recorder.as_ref().ok_or(())?;
        self.enqueue_upsert(connector).await?.1.ok_or(())
    }

    async fn enqueue_remove(
        &self,
        id: String,
    ) -> Result<
        (
            oneshot::Receiver<ConnectorMutationReceipt>,
            Option<CallReceipt>,
        ),
        (),
    > {
        let call = self
            .begin(
                "externalConnectors.remove",
                ConnectorCallDetail::connector(&id),
            )
            .await?;
        let (reply, rx) = oneshot::channel();
        let receipt = self
            .send_command(
                ConnectorCommand::Remove {
                    id,
                    call: call.clone(),
                    reply,
                },
                call,
            )
            .await?;
        Ok((rx, receipt))
    }

    pub(crate) async fn remove(&self, id: String) -> Result<MutationOutcome, ()> {
        let (rx, _) = self.enqueue_remove(id).await?;
        rx.await.map(map_mutation_receipt).map_err(|_| ())
    }

    pub(crate) async fn admit_remove(&self, id: String) -> Result<CallReceipt, ()> {
        self.recorder.as_ref().ok_or(())?;
        self.enqueue_remove(id).await?.1.ok_or(())
    }

    pub(crate) async fn admit_probe(&self, id: String) -> Result<CallReceipt, ()> {
        let call = self
            .begin(
                "externalConnectors.probe",
                ConnectorCallDetail::connector(&id),
            )
            .await?
            .ok_or(())?;
        self.admit_observation(
            ConnectorQuery::Probe {
                id,
                call: call.clone(),
            },
            call,
            None,
        )
        .await
    }

    pub(crate) async fn admit_session_status(
        &self,
        target: SessionStatusTarget,
        principal: String,
    ) -> Result<CallReceipt, ()> {
        let session_identity = target.session_identity.clone();
        let target = connector_session_target(target).ok_or(())?;
        let call = self
            .begin(
                "externalConnectors.sessionStatus",
                ConnectorCallDetail::default(),
            )
            .await?
            .ok_or(())?;
        self.admit_observation(
            ConnectorQuery::SessionStatus {
                target,
                session_identity: session_identity.clone(),
                call: call.clone(),
            },
            call,
            Some(SessionObservationSubject {
                principal,
                session_identity,
            }),
        )
        .await
    }

    pub(crate) async fn openclaw_mcp_servers(&self) -> Result<OpenClawMcpServersOutcome, ()> {
        let call = self
            .begin("openClawMcpServers.list", ConnectorCallDetail::default())
            .await?;
        let (reply, rx) = oneshot::channel();
        self.send_query(
            ConnectorQuery::OpenClawMcpServers {
                call: call.clone(),
                reply,
            },
            call,
        )
        .await?;
        rx.await
            .map(map_openclaw_mcp_servers_receipt)
            .map_err(|_| ())
    }

    async fn enqueue_session_mcp_server_enabled(
        &self,
        target: SessionMcpServerEnabledTarget,
    ) -> Result<
        (
            oneshot::Receiver<ConnectorSessionMcpServerEnabledReceipt>,
            Option<CallReceipt>,
        ),
        (),
    > {
        let target = connector_session_mcp_server_enabled_target(target).ok_or(())?;
        let detail = ConnectorCallDetail {
            server_id: Some(target.server_id.clone()),
            enabled: Some(target.enabled),
            ..ConnectorCallDetail::default()
        };
        let call = self
            .begin("externalConnectors.sessionMcpServerEnabled", detail)
            .await?;
        let (reply, rx) = oneshot::channel();
        let receipt = self
            .send_command(
                ConnectorCommand::SetSessionMcpServerEnabled {
                    target,
                    call: call.clone(),
                    reply,
                },
                call,
            )
            .await?;
        Ok((rx, receipt))
    }

    pub(crate) async fn set_session_mcp_server_enabled(
        &self,
        target: SessionMcpServerEnabledTarget,
    ) -> Result<SessionMcpServerEnabledOutcome, ()> {
        if !target.is_valid() {
            return Ok(SessionMcpServerEnabledOutcome::Unavailable);
        }
        let (rx, _) = self.enqueue_session_mcp_server_enabled(target).await?;
        rx.await
            .map(map_session_mcp_server_enabled_receipt)
            .map_err(|_| ())
    }

    pub(crate) async fn admit_session_mcp_server_enabled(
        &self,
        target: SessionMcpServerEnabledTarget,
    ) -> Result<CallReceipt, ()> {
        self.recorder.as_ref().ok_or(())?;
        self.enqueue_session_mcp_server_enabled(target)
            .await?
            .1
            .ok_or(())
    }

    pub(crate) async fn configure_private_resolver(
        &self,
        resolver: Arc<dyn ConnectorSecretResolverPort>,
    ) -> Result<(), ()> {
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
        source: program.source,
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

pub(crate) fn map_observation_receipt(
    receipt: ConnectorObservationReceipt,
) -> ConnectorObservation {
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

pub(crate) fn map_session_mcp_server_status(
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

pub(crate) fn session_result_type(
    state: ConnectorSessionMcpServerState,
) -> SessionConnectorResultType {
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
