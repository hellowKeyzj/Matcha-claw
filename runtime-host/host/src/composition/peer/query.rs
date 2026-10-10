use tokio::sync::oneshot;

use foundation::execution::QueryRoute;

use openclaw::gateway::request::{
    OpenClawBrowserGatewayRequest, OpenClawMcpAppGatewayRequest,
    OpenClawQuestionListGatewayRequest, OpenClawQuestionResolveGatewayRequest,
};

use crate::{
    HostState, RuntimeState,
    composition::OpenClawLogSnapshot,
    composition::runtime_ports::{
        RuntimeControlFailure, RuntimeControlReadiness, RuntimeDriverIdentity,
        RuntimeGatewayHealth, RuntimeGatewayStatus, RuntimeLogSnapshot,
    },
};

use super::PeerKey;

pub(crate) enum PeerQuery {
    State {
        reply: oneshot::Sender<HostState>,
    },
    OpenClawRepairStatus {
        reply: oneshot::Sender<runtime_directory::RuntimeRepairSnapshot>,
    },
    OpenClawStatus {
        reply: oneshot::Sender<RuntimeState>,
    },
    OpenClawLogs {
        cursor: Option<u64>,
        reply: oneshot::Sender<Result<OpenClawLogSnapshot, ()>>,
    },
    OpenClawGatewayHealth {
        probe: bool,
        reply: oneshot::Sender<
            Result<
                crate::composition::OpenClawGatewayHealthObservation,
                crate::RequestAdmissionClosed,
            >,
        >,
    },
    OpenClawGatewayStatus {
        include_channel_summary: bool,
        reply: oneshot::Sender<
            Result<
                crate::composition::OpenClawGatewayStatusObservation,
                crate::RequestAdmissionClosed,
            >,
        >,
    },
    OpenClawControlUiUrl {
        reply: oneshot::Sender<String>,
    },
    OpenClawGatewaySnapshot {
        reply: oneshot::Sender<
            Result<
                crate::composition::OpenClawGatewaySnapshotObservation,
                crate::RequestAdmissionClosed,
            >,
        >,
    },
    OpenClawControlSnapshot {
        reply: oneshot::Sender<
            Result<
                crate::composition::OpenClawControlSnapshotObservation,
                crate::RequestAdmissionClosed,
            >,
        >,
    },
    RuntimeLogs {
        endpoint: PeerKey,
        cursor: Option<u64>,
        reply: oneshot::Sender<Result<RuntimeLogSnapshot, RuntimeControlFailure>>,
    },
    RuntimeControlReadiness {
        endpoint: PeerKey,
        reply: oneshot::Sender<Result<RuntimeControlReadiness, RuntimeControlFailure>>,
    },
    RuntimeGatewayHealth {
        endpoint: PeerKey,
        probe: bool,
        reply: oneshot::Sender<Result<RuntimeGatewayHealth, RuntimeControlFailure>>,
    },
    RuntimeGatewayStatus {
        endpoint: PeerKey,
        include_channel_summary: bool,
        reply: oneshot::Sender<Result<RuntimeGatewayStatus, RuntimeControlFailure>>,
    },
    RuntimeControlUiUrl {
        endpoint: PeerKey,
        reply: oneshot::Sender<Result<String, RuntimeControlFailure>>,
    },
    OpenClawBrowserRequest {
        request: OpenClawBrowserGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
        reply: oneshot::Sender<
            Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed>,
        >,
    },
    OpenClawMcpAppRequest {
        request: OpenClawMcpAppGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
        reply: oneshot::Sender<
            Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed>,
        >,
    },
    OpenClawQuestionList {
        request: OpenClawQuestionListGatewayRequest,
        reply: oneshot::Sender<
            Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed>,
        >,
    },
    OpenClawQuestionResolve {
        request: OpenClawQuestionResolveGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
        reply: oneshot::Sender<
            Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed>,
        >,
    },
}

impl PeerQuery {
    pub(crate) fn route_query(&self) -> QueryRoute<PeerKey> {
        match self {
            Self::State { .. } | Self::OpenClawStatus { .. } | Self::OpenClawRepairStatus { .. } => QueryRoute::Direct,
            Self::RuntimeLogs { endpoint, .. }
            | Self::RuntimeControlReadiness { endpoint, .. }
            | Self::RuntimeGatewayHealth { endpoint, .. }
            | Self::RuntimeGatewayStatus { endpoint, .. }
            | Self::RuntimeControlUiUrl { endpoint, .. } => QueryRoute::Keyed(endpoint.clone()),
            Self::OpenClawLogs { .. }
            | Self::OpenClawGatewayHealth { .. }
            | Self::OpenClawGatewayStatus { .. }
            | Self::OpenClawControlUiUrl { .. }
            | Self::OpenClawGatewaySnapshot { .. }
            | Self::OpenClawControlSnapshot { .. }
            | Self::OpenClawBrowserRequest { .. }
            | Self::OpenClawMcpAppRequest { .. }
            | Self::OpenClawQuestionList { .. }
            | Self::OpenClawQuestionResolve { .. } => {
                QueryRoute::Keyed(RuntimeDriverIdentity::open_claw().endpoint())
            }
        }
    }
}
