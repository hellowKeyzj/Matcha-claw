use std::sync::Arc;

use platform::call::{CallContext, CallDetail, CallLogError, CallReceipt, CallStatus};
use serde::Serialize;
use tokio::sync::OnceCell;

use crate::application::receipts::{
    ConnectorMutationReceipt, ConnectorObservationReceipt, ConnectorProjectionReceipt,
    ConnectorSessionMcpServerState, ConnectorSessionMcpServerStatus,
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCallDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tombstoned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection: Option<ProjectionStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<CallResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub observations: Vec<ObservationSummary>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub servers: Vec<SessionServerSummary>,
    pub summaries_truncated: bool,
}

impl CallDetail for ConnectorCallDetail {
    const MODULE: &'static str = "connectors";
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectionStatus {
    Written,
    Unknown,
    Unavailable,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CallResult {
    Available,
    Found,
    Missing,
    Stored,
    Removed,
    Rejected,
    Unknown,
    Unavailable,
    AppliedNextRun,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationSummary {
    pub connector_id: String,
    pub result_type: ObservationStatus,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ObservationStatus {
    Connected,
    Disconnected,
    Disabled,
    Unsupported,
    Unknown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionServerSummary {
    pub server_id: String,
    pub state: SessionServerState,
    pub result_type: crate::delivery::SessionConnectorResultType,
    pub tool_count: Option<u64>,
    pub enabled_next_run: bool,
    pub enabled_configurable: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionServerState {
    DisabledByConfiguration,
    MissingFromNativeStatus,
    NativeStatusUnavailable,
    NativeDisabled,
    NativeNotConnected,
    NativeListingTools,
    NativeStaleConfig,
    NativeConnected,
    NativeDisconnected,
    NativeError,
    NativeEnabledFalse,
    NativeAvailable,
    NativePending,
}

#[derive(Clone)]
pub(crate) struct ConnectorCall {
    pub(crate) context: CallContext<ConnectorCallDetail>,
    pub(crate) detail: ConnectorCallDetail,
    admission: Arc<OnceCell<Result<CallReceipt, CallLogError>>>,
}

impl ConnectorCall {
    pub(crate) fn new(context: CallContext<ConnectorCallDetail>, detail: ConnectorCallDetail) -> Self {
        Self { context, detail, admission: Arc::new(OnceCell::new()) }
    }

    pub(crate) async fn accepted(&self) -> Result<CallReceipt, ()> {
        self.admission.get_or_init(|| self.context.accepted()).await.clone().map_err(|error| {
            eprintln!("connector call acceptance could not be recorded: {error}");
        })
    }

    pub(crate) async fn start(&self) -> Result<(), ()> {
        self.accepted().await?;
        self.context.running().await.map_err(|error| {
            eprintln!("connector call running could not be recorded: {error}");
        })
    }

    pub(crate) async fn running(&self) {
        if let Err(error) = self.context.running().await {
            eprintln!("connector call running could not be recorded: {error}");
        }
    }

    pub(crate) async fn finish(self, status: CallStatus) {
        if let Err(error) = self.context.finish(status, &self.detail).await {
            eprintln!("connector call completion could not be recorded: {error}");
        }
    }
}

impl ConnectorCallDetail {
    pub(crate) fn connector(id: &str) -> Self {
        Self { connector_id: Some(id.to_owned()), ..Self::default() }
    }

    pub(crate) fn mutation(&mut self, outcome: &ConnectorMutationReceipt) -> CallStatus {
        let (result, status) = match outcome {
            ConnectorMutationReceipt::Stored { created, configuration, .. } => {
                self.created = Some(*created);
                self.projection(configuration);
                (CallResult::Stored, projection_status(configuration))
            }
            ConnectorMutationReceipt::Removed { configuration, .. } => {
                self.projection(configuration);
                (CallResult::Removed, projection_status(configuration))
            }
            ConnectorMutationReceipt::Missing => (CallResult::Missing, CallStatus::Rejected),
            ConnectorMutationReceipt::Rejected => (CallResult::Rejected, CallStatus::Rejected),
            ConnectorMutationReceipt::Unknown => (CallResult::Unknown, CallStatus::Unknown),
            ConnectorMutationReceipt::Unavailable => (CallResult::Unavailable, CallStatus::Failed),
        };
        self.result = Some(result);
        status
    }

    pub(crate) fn projection(&mut self, projection: &ConnectorProjectionReceipt) {
        self.projection = Some(match projection {
            ConnectorProjectionReceipt::Written { changed } => {
                self.changed = Some(*changed);
                ProjectionStatus::Written
            }
            ConnectorProjectionReceipt::Unknown => ProjectionStatus::Unknown,
            ConnectorProjectionReceipt::Unavailable => ProjectionStatus::Unavailable,
        });
    }

    pub(crate) fn observations(&mut self, statuses: &[(String, ConnectorObservationReceipt)]) {
        self.count = Some(statuses.len());
        // ponytail: audit is bounded; the module retains this call's complete observations separately.
        self.summaries_truncated = statuses.len() > 16;
        self.observations = statuses.iter().take(16).map(|(id, observation)| ObservationSummary {
            connector_id: id.clone(),
            result_type: observation_status(observation),
        }).collect();
    }

    pub(crate) fn servers(&mut self, statuses: &[ConnectorSessionMcpServerStatus]) {
        self.count = Some(statuses.len());
        self.summaries_truncated = statuses.len() > 8;
        self.servers = statuses.iter().take(8).map(|status| SessionServerSummary {
            server_id: status.details.server_id.clone(),
            state: session_state(status.state),
            result_type: crate::api::session_result_type(status.state),
            tool_count: status.details.tool_count,
            enabled_next_run: status.details.enabled_next_run,
            enabled_configurable: status.details.enabled_configurable,
        }).collect();
    }
}

fn projection_status(projection: &ConnectorProjectionReceipt) -> CallStatus {
    match projection {
        ConnectorProjectionReceipt::Written { .. } => CallStatus::Succeeded,
        ConnectorProjectionReceipt::Unknown => CallStatus::Unknown,
        ConnectorProjectionReceipt::Unavailable => CallStatus::Failed,
    }
}

pub(crate) fn observation_status(observation: &ConnectorObservationReceipt) -> ObservationStatus {
    match observation {
        ConnectorObservationReceipt::Connected => ObservationStatus::Connected,
        ConnectorObservationReceipt::Disconnected => ObservationStatus::Disconnected,
        ConnectorObservationReceipt::Disabled => ObservationStatus::Disabled,
        ConnectorObservationReceipt::Unsupported => ObservationStatus::Unsupported,
        ConnectorObservationReceipt::Unknown => ObservationStatus::Unknown,
    }
}

fn session_state(state: ConnectorSessionMcpServerState) -> SessionServerState {
    match state {
        ConnectorSessionMcpServerState::DisabledByConfiguration => SessionServerState::DisabledByConfiguration,
        ConnectorSessionMcpServerState::MissingFromNativeStatus => SessionServerState::MissingFromNativeStatus,
        ConnectorSessionMcpServerState::NativeStatusUnavailable => SessionServerState::NativeStatusUnavailable,
        ConnectorSessionMcpServerState::NativeDisabled => SessionServerState::NativeDisabled,
        ConnectorSessionMcpServerState::NativeNotConnected => SessionServerState::NativeNotConnected,
        ConnectorSessionMcpServerState::NativeListingTools => SessionServerState::NativeListingTools,
        ConnectorSessionMcpServerState::NativeStaleConfig => SessionServerState::NativeStaleConfig,
        ConnectorSessionMcpServerState::NativeConnected => SessionServerState::NativeConnected,
        ConnectorSessionMcpServerState::NativeDisconnected => SessionServerState::NativeDisconnected,
        ConnectorSessionMcpServerState::NativeError => SessionServerState::NativeError,
        ConnectorSessionMcpServerState::NativeEnabledFalse => SessionServerState::NativeEnabledFalse,
        ConnectorSessionMcpServerState::NativeAvailable => SessionServerState::NativeAvailable,
        ConnectorSessionMcpServerState::NativePending => SessionServerState::NativePending,
    }
}
