use foundation::execution::OwnerRuntimeHandle;
use openclaw::gateway::request::{OpenClawBrowserGatewayRequest, OpenClawMcpAppGatewayRequest};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::{
    HostState, RuntimeState,
    composition::OpenClawLogSnapshot,
    composition::runtime_ports::{
        RuntimeControlFailure, RuntimeControlReadiness, RuntimeGatewayHealth, RuntimeGatewayStatus,
        RuntimeLogSnapshot,
    },
};

use super::{
    PeerCommand, PeerQuery, RuntimeRestartCommandError, RuntimeStartCommandError,
    RuntimeStopCommandError,
};

#[derive(Clone)]
pub(crate) struct PeerHandle {
    owner: OwnerRuntimeHandle<PeerCommand, PeerQuery>,
}

impl runtime_directory::RuntimeEndpointDirectorySource for PeerHandle {
    fn runtime_endpoint_directory<'a>(
        &'a self,
    ) -> runtime_directory::RuntimeEndpointDirectoryFuture<'a> {
        Box::pin(async move { PeerHandle::runtime_endpoint_directory(self).await })
    }
}

impl openclaw::plugins::OpenClawPluginsRestartPort for PeerHandle {
    fn restart_openclaw_runtime<'a>(&'a self) -> plugins_module::ports::PluginsFuture<'a, bool> {
        Box::pin(async move {
            matches!(
                self.restart_runtime(
                    runtime_directory::RuntimeDriverIdentity::open_claw().endpoint()
                )
                .await,
                Ok(Ok(_))
            )
        })
    }
}

impl PeerHandle {
    pub(crate) fn new(owner: OwnerRuntimeHandle<PeerCommand, PeerQuery>) -> Self {
        Self { owner }
    }

    pub(crate) async fn state(&self) -> Result<HostState, ()> {
        self.request_query(|reply| PeerQuery::State { reply }).await
    }

    pub(crate) async fn runtime_endpoint_directory(
        &self,
    ) -> Result<runtime_directory::Directory, ()> {
        let state = self.state().await?;
        Ok(runtime_directory::Directory::from_lifecycles(
            runtime_lifecycle(state.matcha().lifecycle()),
            runtime_lifecycle(state.open_claw().lifecycle()),
        ))
    }

    pub(crate) async fn request_peer_autostart(
        &self,
        open_claw_auto_start: bool,
    ) -> Result<(), super::AutostartOpenClawError> {
        self.owner
            .send_command(PeerCommand::AutostartMatcha)
            .await
            .map_err(|_| super::AutostartOpenClawError::PeerUnavailable)?;

        if !open_claw_auto_start {
            return Ok(());
        }

        self.request_command(|reply| PeerCommand::AutostartOpenClaw { reply })
            .await
            .map_err(|_| super::AutostartOpenClawError::PeerUnavailable)?
            .map(|_| ())
    }

    pub(crate) async fn open_claw_status(&self) -> Result<RuntimeState, ()> {
        self.request_query(|reply| PeerQuery::OpenClawStatus { reply })
            .await
    }

    pub(crate) async fn start_runtime(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Result<Result<RuntimeState, RuntimeStartCommandError>, ()> {
        self.request_command(|reply| PeerCommand::StartRuntime { endpoint, reply })
            .await
    }

    pub(crate) async fn stop_runtime(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Result<Result<RuntimeState, RuntimeStopCommandError>, ()> {
        self.request_command(|reply| PeerCommand::StopRuntime { endpoint, reply })
            .await
    }

    pub(crate) async fn restart_runtime(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Result<Result<RuntimeState, RuntimeRestartCommandError>, ()> {
        self.request_command(|reply| PeerCommand::RestartRuntime { endpoint, reply })
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

    pub(crate) async fn open_claw_gateway_snapshot(&self) -> Value {
        match self
            .request_query(|reply| PeerQuery::OpenClawGatewaySnapshot { reply })
            .await
        {
            Ok(Ok(observation)) => observation.observe().await,
            Ok(Err(_)) | Err(_) => {
                crate::composition::OpenClawGatewaySnapshotObservation::unavailable()
            }
        }
    }

    pub(crate) async fn open_claw_control_snapshot(&self) -> Value {
        match self
            .request_query(|reply| PeerQuery::OpenClawControlSnapshot { reply })
            .await
        {
            Ok(Ok(observation)) => observation.observe().await,
            Ok(Err(_)) | Err(_) => {
                crate::composition::OpenClawControlSnapshotObservation::unavailable()
            }
        }
    }

    pub(crate) async fn runtime_logs(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        cursor: Option<u64>,
    ) -> Result<Result<RuntimeLogSnapshot, RuntimeControlFailure>, ()> {
        self.request_query(|reply| PeerQuery::RuntimeLogs {
            endpoint,
            cursor,
            reply,
        })
        .await
    }

    pub(crate) async fn runtime_control_readiness(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Result<Result<RuntimeControlReadiness, RuntimeControlFailure>, ()> {
        self.request_query(|reply| PeerQuery::RuntimeControlReadiness { endpoint, reply })
            .await
    }

    pub(crate) async fn runtime_gateway_health(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        probe: bool,
    ) -> Result<Result<RuntimeGatewayHealth, RuntimeControlFailure>, ()> {
        self.request_query(|reply| PeerQuery::RuntimeGatewayHealth {
            endpoint,
            probe,
            reply,
        })
        .await
    }

    pub(crate) async fn runtime_gateway_status(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
        include_channel_summary: bool,
    ) -> Result<Result<RuntimeGatewayStatus, RuntimeControlFailure>, ()> {
        self.request_query(|reply| PeerQuery::RuntimeGatewayStatus {
            endpoint,
            include_channel_summary,
            reply,
        })
        .await
    }

    pub(crate) async fn runtime_control_ui_url(
        &self,
        endpoint: platform::endpoint::runtime_address::RuntimeEndpoint,
    ) -> Result<Result<String, RuntimeControlFailure>, ()> {
        self.request_query(|reply| PeerQuery::RuntimeControlUiUrl { endpoint, reply })
            .await
    }

    pub(crate) async fn open_claw_browser_request(
        &self,
        request: OpenClawBrowserGatewayRequest,
    ) -> Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed> {
        self.request_query(|reply| PeerQuery::OpenClawBrowserRequest { request, reply })
            .await
            .map_err(|_| crate::RequestAdmissionClosed::new(crate::HostPhase::ShutDown))?
    }

    pub(crate) async fn open_claw_mcp_app_request(
        &self,
        request: OpenClawMcpAppGatewayRequest,
    ) -> Result<openclaw::port::OpenClawGatewayRequestOutcome, crate::RequestAdmissionClosed> {
        self.request_query(|reply| PeerQuery::OpenClawMcpAppRequest { request, reply })
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

const fn runtime_lifecycle(
    lifecycle: crate::RuntimeLifecycle,
) -> runtime_directory::RuntimeLifecycle {
    match lifecycle {
        crate::RuntimeLifecycle::Unavailable => runtime_directory::RuntimeLifecycle::Unavailable,
        crate::RuntimeLifecycle::Idle => runtime_directory::RuntimeLifecycle::Idle,
        crate::RuntimeLifecycle::Starting => runtime_directory::RuntimeLifecycle::Starting,
        crate::RuntimeLifecycle::Running => runtime_directory::RuntimeLifecycle::Running,
        crate::RuntimeLifecycle::Stopping => runtime_directory::RuntimeLifecycle::Stopping,
        crate::RuntimeLifecycle::WaitingToRestart => {
            runtime_directory::RuntimeLifecycle::WaitingToRestart
        }
        crate::RuntimeLifecycle::Failed => runtime_directory::RuntimeLifecycle::Failed,
        crate::RuntimeLifecycle::ShutDown => runtime_directory::RuntimeLifecycle::ShutDown,
    }
}
