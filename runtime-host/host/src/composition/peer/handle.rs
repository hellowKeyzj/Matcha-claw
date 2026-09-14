use foundation::execution::OwnerRuntimeHandle;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::{HostState, RuntimeState, composition::OpenClawLogSnapshot, peer_directory};

use super::{
    PeerCommand, PeerQuery, RestartMatchaError, RestartOpenClawError, StartMatchaError,
    StartOpenClawError, StopMatchaError, StopOpenClawError,
};

#[derive(Clone)]
pub(crate) struct PeerHandle {
    owner: OwnerRuntimeHandle<PeerCommand, PeerQuery>,
}

impl PeerHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<PeerCommand, PeerQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn state(&self) -> Result<HostState, ()> {
        self.request_query(|reply| PeerQuery::State { reply }).await
    }

    pub(crate) async fn runtime_endpoint_directory(&self) -> Result<peer_directory::Directory, ()> {
        let state = self.state().await?;
        Ok(peer_directory::Directory::from_host_state(&state))
    }

    pub(crate) async fn request_peer_autostart(
        &self,
        open_claw_auto_start: bool,
    ) -> Result<(), ()> {
        self.owner
            .send_command(PeerCommand::AutostartMatcha)
            .await
            .map_err(|_| ())?;

        if open_claw_auto_start {
            self.owner
                .send_command(PeerCommand::AutostartOpenClaw)
                .await
                .map_err(|_| ())?;
        }
        Ok(())
    }

    pub(crate) async fn matcha_status(&self) -> Result<RuntimeState, ()> {
        self.request_query(|reply| PeerQuery::MatchaStatus { reply })
            .await
    }

    pub(crate) async fn start_matcha(&self) -> Result<Result<RuntimeState, StartMatchaError>, ()> {
        self.request_command(|reply| PeerCommand::StartMatcha { reply })
            .await
    }

    pub(crate) async fn stop_matcha(&self) -> Result<Result<RuntimeState, StopMatchaError>, ()> {
        self.request_command(|reply| PeerCommand::StopMatcha { reply })
            .await
    }

    pub(crate) async fn restart_matcha(
        &self,
    ) -> Result<Result<RuntimeState, RestartMatchaError>, ()> {
        self.request_command(|reply| PeerCommand::RestartMatcha { reply })
            .await
    }

    pub(crate) async fn open_claw_status(&self) -> Result<RuntimeState, ()> {
        self.request_query(|reply| PeerQuery::OpenClawStatus { reply })
            .await
    }

    pub(crate) async fn start_open_claw(
        &self,
    ) -> Result<Result<RuntimeState, StartOpenClawError>, ()> {
        self.request_command(|reply| PeerCommand::StartOpenClaw { reply })
            .await
    }

    pub(crate) async fn stop_open_claw(
        &self,
    ) -> Result<Result<RuntimeState, StopOpenClawError>, ()> {
        self.request_command(|reply| PeerCommand::StopOpenClaw { reply })
            .await
    }

    pub(crate) async fn restart_open_claw(
        &self,
    ) -> Result<Result<RuntimeState, RestartOpenClawError>, ()> {
        self.request_command(|reply| PeerCommand::RestartOpenClaw { reply })
            .await
    }

    pub(crate) async fn open_claw_logs(
        &self,
        cursor: Option<u64>,
    ) -> Result<Result<OpenClawLogSnapshot, ()>, ()> {
        self.request_query(|reply| PeerQuery::OpenClawLogs { cursor, reply })
            .await
    }

    pub(crate) async fn open_claw_gateway_health(
        &self,
        probe: bool,
    ) -> Result<Result<openclaw::gateway::wire::GatewayHealthSnapshot, ()>, ()> {
        match self.open_claw_gateway_health_observation(probe).await {
            Ok(Ok(observation)) => Ok(observation.observe().await.map_err(|_| ())),
            Ok(Err(_)) | Err(_) => Ok(Err(())),
        }
    }

    pub(crate) async fn open_claw_gateway_health_observation(
        &self,
        probe: bool,
    ) -> Result<
        Result<crate::composition::OpenClawGatewayHealthObservation, crate::RequestAdmissionClosed>,
        (),
    > {
        self.request_query(|reply| PeerQuery::OpenClawGatewayHealth { probe, reply })
            .await
    }

    pub(crate) async fn open_claw_gateway_status(
        &self,
        include_channel_summary: bool,
    ) -> Result<Result<openclaw::gateway::wire::GatewayStatusSnapshot, ()>, ()> {
        match self
            .open_claw_gateway_status_observation(include_channel_summary)
            .await
        {
            Ok(Ok(observation)) => Ok(observation.observe().await.map_err(|_| ())),
            Ok(Err(_)) | Err(_) => Ok(Err(())),
        }
    }

    pub(crate) async fn open_claw_gateway_status_observation(
        &self,
        include_channel_summary: bool,
    ) -> Result<
        Result<crate::composition::OpenClawGatewayStatusObservation, crate::RequestAdmissionClosed>,
        (),
    > {
        self.request_query(|reply| PeerQuery::OpenClawGatewayStatus {
            include_channel_summary,
            reply,
        })
        .await
    }

    pub(crate) async fn open_claw_control_ui_url(&self) -> Result<String, ()> {
        self.request_query(|reply| PeerQuery::OpenClawControlUiUrl { reply })
            .await
    }

    pub(crate) async fn control_lease(
        &self,
    ) -> Result<crate::composition::ControlLease, crate::RequestAdmissionClosed> {
        self.request_query(|reply| PeerQuery::OpenClawControlLease { reply })
            .await
            .map_err(|_| crate::RequestAdmissionClosed::new(crate::HostPhase::ShutDown))?
    }

    pub(crate) async fn open_claw_browser_request(
        &self,
        method: String,
        path: String,
        query: Option<Value>,
        body: Option<Value>,
        timeout_ms: Option<u64>,
        target: Option<String>,
        node: Option<String>,
    ) -> Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed> {
        self.request_query(|reply| PeerQuery::OpenClawBrowserRequest {
            method,
            path,
            query,
            body,
            timeout_ms,
            target,
            node,
            reply,
        })
        .await
        .map_err(|_| crate::RequestAdmissionClosed::new(crate::HostPhase::ShutDown))?
    }

    pub(crate) async fn open_claw_mcp_app_request(
        &self,
        operation_id: String,
        session_key: String,
        view_id: String,
        standalone: Option<bool>,
    ) -> Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed> {
        self.request_query(|reply| PeerQuery::OpenClawMcpAppRequest {
            operation_id,
            session_key,
            view_id,
            standalone,
            reply,
        })
        .await
        .map_err(|_| crate::RequestAdmissionClosed::new(crate::HostPhase::ShutDown))?
    }

    async fn request_command<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> PeerCommand,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner
            .send_command(command(reply))
            .await
            .map_err(|_| ())?;
        response.await.map_err(|_| ())
    }

    async fn request_query<T>(
        &self,
        query: impl FnOnce(oneshot::Sender<T>) -> PeerQuery,
    ) -> Result<T, ()> {
        let (reply, response) = oneshot::channel();
        self.owner.send_query(query(reply)).await.map_err(|_| ())?;
        response.await.map_err(|_| ())
    }
}
