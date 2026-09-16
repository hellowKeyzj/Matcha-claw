use tokio::sync::oneshot;

use foundation::execution::QueryRoute;

use crate::{
    HostState, RuntimeState,
    composition::{
        OpenClawBrowserGatewayRequest, OpenClawLogSnapshot, OpenClawMcpAppGatewayRequest,
    },
    runtime::driver::RuntimeDriverIdentity,
};

use super::PeerKey;

pub(crate) enum PeerQuery {
    State {
        reply: oneshot::Sender<HostState>,
    },
    MatchaStatus {
        reply: oneshot::Sender<RuntimeState>,
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
    OpenClawControlLease {
        reply: oneshot::Sender<
            Result<crate::composition::ControlLease, crate::RequestAdmissionClosed>,
        >,
    },
    OpenClawBrowserRequest {
        request: OpenClawBrowserGatewayRequest,
        reply: oneshot::Sender<
            Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed>,
        >,
    },
    OpenClawMcpAppRequest {
        request: OpenClawMcpAppGatewayRequest,
        reply: oneshot::Sender<
            Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed>,
        >,
    },
}

impl PeerQuery {
    pub(crate) fn route_query(&self) -> QueryRoute<PeerKey> {
        match self {
            Self::State { .. } | Self::MatchaStatus { .. } | Self::OpenClawStatus { .. } => {
                QueryRoute::Direct
            }
            Self::OpenClawLogs { .. }
            | Self::OpenClawGatewayHealth { .. }
            | Self::OpenClawGatewayStatus { .. }
            | Self::OpenClawControlUiUrl { .. }
            | Self::OpenClawControlLease { .. }
            | Self::OpenClawBrowserRequest { .. }
            | Self::OpenClawMcpAppRequest { .. } => {
                QueryRoute::Keyed(RuntimeDriverIdentity::open_claw().endpoint())
            }
        }
    }
}
