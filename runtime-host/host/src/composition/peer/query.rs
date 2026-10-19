use tokio::sync::oneshot;

use foundation::execution::QueryRoute;

use openclaw::gateway::request::{
    OpenClawBrowserGatewayRequest, OpenClawCanvasGatewayRequest, OpenClawMcpAppGatewayRequest,
    OpenClawProgressCardGatewayRequest, OpenClawQuestionListGatewayRequest,
    OpenClawQuestionResolveGatewayRequest,
};

use crate::{
    HostState, RuntimeState,
    composition::OpenClawLogSnapshot,
    composition::runtime_ports::{
        RuntimeControlFailure, RuntimeControlReadiness, RuntimeDriverIdentity,
        RuntimeGatewayHealth, RuntimeGatewayStatus, RuntimeLogSnapshot,
    },
};

use super::{PeerKey, PeerLaneKey};

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
    OpenClawCanvasRequest {
        request: OpenClawCanvasGatewayRequest,
        call: Option<openclaw::gateway::loopback::GatewayCallContext>,
        reply: oneshot::Sender<
            Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed>,
        >,
    },
    OpenClawProgressCardRequest {
        request: OpenClawProgressCardGatewayRequest,
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
    pub(crate) fn route_query(&self) -> QueryRoute<PeerLaneKey> {
        match self {
            Self::State { .. }
            | Self::OpenClawStatus { .. }
            | Self::OpenClawRepairStatus { .. }
            | Self::RuntimeLogs { .. }
            | Self::RuntimeControlReadiness { .. }
            | Self::RuntimeGatewayHealth { .. }
            | Self::RuntimeGatewayStatus { .. }
            | Self::RuntimeControlUiUrl { .. }
            | Self::OpenClawLogs { .. }
            | Self::OpenClawGatewayHealth { .. }
            | Self::OpenClawGatewayStatus { .. }
            | Self::OpenClawControlUiUrl { .. }
            | Self::OpenClawGatewaySnapshot { .. }
            | Self::OpenClawControlSnapshot { .. }
            | Self::OpenClawCanvasRequest { .. }
            | Self::OpenClawQuestionList { .. } => QueryRoute::Direct,
            // Generic browser paths can include profile/config transactions; keep their lane.
            Self::OpenClawBrowserRequest { .. } => {
                QueryRoute::Keyed(PeerLaneKey::Lifecycle(RuntimeDriverIdentity::open_claw().endpoint()))
            }
            // Model-context writes are shared by every view in the native session.
            Self::OpenClawMcpAppRequest { request, .. } => QueryRoute::Keyed(PeerLaneKey::McpApp {
                identity: sessions_module::command::session_identity_lane_key(
                    &request.session_identity,
                ),
            }),
            Self::OpenClawProgressCardRequest { request, .. } => {
                QueryRoute::Keyed(PeerLaneKey::McpApp {
                    identity: sessions_module::command::session_identity_lane_key(
                        &request.session_identity,
                    ),
                })
            }
            Self::OpenClawQuestionResolve { request, .. } => {
                QueryRoute::Keyed(PeerLaneKey::Question {
                    identity: sessions_module::command::session_identity_lane_key(&request.session_identity),
                    id: request.id.clone(),
                })
            }
        }
    }
}
