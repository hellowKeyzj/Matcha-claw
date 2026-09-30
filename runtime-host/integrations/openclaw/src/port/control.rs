use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use tokio::sync::watch;

use super::{OpenClawGateway, outcome::gateway_request_outcome};
use crate::port::OpenClawGatewayRequestOutcome;
use crate::{
    gateway::{
        client::{GatewayClient, GatewayClientError, GatewayControlReadiness},
        request::{OpenClawBrowserGatewayRequest, OpenClawMcpAppGatewayRequest},
        wire,
    },
    lifecycle::{readiness::OpenClawReadiness, stop::OpenClawGracefulStop},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenClawControlReadiness {
    Ready,
    Starting,
    Unavailable,
}

fn project_control_readiness(readiness: GatewayControlReadiness) -> OpenClawControlReadiness {
    match readiness {
        GatewayControlReadiness::Ready => OpenClawControlReadiness::Ready,
        GatewayControlReadiness::Starting => OpenClawControlReadiness::Starting,
        GatewayControlReadiness::Unavailable => OpenClawControlReadiness::Unavailable,
    }
}

fn next_request_id(operation: &str) -> String {
    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    format!("matcha-{operation}-{sequence}")
}

#[derive(Clone)]
pub struct OpenClawGatewayControl {
    client: Arc<GatewayClient>,
}

impl OpenClawGatewayControl {
    pub fn start_supervision(&self) {
        self.client.start_control_supervision();
    }

    pub fn take_supervisor(&self) -> Option<crate::gateway::client::GatewayControlSupervisor> {
        self.client.take_control_supervisor()
    }
}

impl OpenClawGateway {
    pub fn readiness_policy(&self) -> OpenClawReadiness {
        OpenClawReadiness::new(Arc::clone(&self.client))
    }

    pub fn graceful_stop_policy(&self) -> OpenClawGracefulStop {
        OpenClawGracefulStop::new(Arc::clone(&self.client))
    }

    pub async fn observe_control(&self) -> OpenClawControlReadiness {
        project_control_readiness(self.client.observe_control().await)
    }

    pub async fn control_readiness_snapshot(&self) -> OpenClawControlReadiness {
        project_control_readiness(self.client.control_readiness_snapshot().await)
    }

    pub async fn observe_health(
        &self,
        probe: bool,
    ) -> Result<
        crate::gateway::wire::GatewayHealthSnapshot,
        crate::gateway::client::GatewayClientError,
    > {
        self.client.observe_health(probe).await
    }

    pub async fn observe_status(
        &self,
        include_channel_summary: bool,
    ) -> Result<
        crate::gateway::wire::GatewayStatusSnapshot,
        crate::gateway::client::GatewayClientError,
    > {
        self.client.observe_status(include_channel_summary).await
    }

    pub async fn observe_mcp_server_status(
        &self,
        session_key: String,
    ) -> Result<crate::gateway::wire::McpServerStatusList, crate::gateway::client::GatewayClientError>
    {
        self.client.observe_mcp_server_status(session_key).await
    }

    pub async fn set_mcp_session_server_enabled(
        &self,
        session_key: String,
        server_name: String,
        enabled: bool,
    ) -> Result<(), crate::gateway::client::GatewayClientError> {
        self.client
            .set_mcp_session_server_enabled(session_key, server_name, enabled)
            .await
    }

    pub async fn tail_logs(
        &self,
        cursor: Option<u64>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<crate::gateway::wire::GatewayLogsTail, crate::gateway::client::GatewayClientError>
    {
        self.client.tail_logs(cursor, limit, max_bytes).await
    }

    pub async fn browser_request(
        &self,
        request: OpenClawBrowserGatewayRequest,
    ) -> OpenClawGatewayRequestOutcome {
        let request = match wire::browser_request(
            next_request_id("browser-request"),
            request.method,
            request.path,
            request.query,
            request.body,
            request.timeout_ms,
            request.target,
            request.node,
        ) {
            Ok(request) => request,
            Err(_) => return OpenClawGatewayRequestOutcome::Rejected,
        };
        gateway_request_outcome(self.client.rpc_mutation(request).await)
    }

    pub async fn mcp_app_request(
        &self,
        request: OpenClawMcpAppGatewayRequest,
    ) -> OpenClawGatewayRequestOutcome {
        let request = match wire::mcp_app_request(
            next_request_id("mcp-app-request"),
            request.operation_id,
            request.session_key,
            request.view_id,
            request.standalone,
        ) {
            Ok(request) => request,
            Err(_) => return OpenClawGatewayRequestOutcome::Rejected,
        };
        gateway_request_outcome(self.client.rpc_mutation(request).await)
    }

    pub async fn question_resolve(
        &self,
        request: crate::gateway::request::OpenClawQuestionResolveGatewayRequest,
    ) -> OpenClawGatewayRequestOutcome {
        let request = match wire::question_resolve_request(
            next_request_id("question-resolve"),
            request.id,
            request.answers,
            request.resolved_by,
            request.resolution_id,
        ) {
            Ok(request) => request,
            Err(_) => return OpenClawGatewayRequestOutcome::Rejected,
        };
        gateway_request_outcome(self.client.rpc_mutation(request).await)
    }

    pub fn control_ui_url(&self) -> String {
        self.client.control_ui_url()
    }

    pub fn control_readiness(&self) -> watch::Receiver<u64> {
        self.client.control_readiness()
    }

    pub fn control(&self) -> OpenClawGatewayControl {
        OpenClawGatewayControl {
            client: Arc::clone(&self.client),
        }
    }

    pub fn usage_projection(&self) -> crate::surfaces::usage::UsageProjection {
        crate::surfaces::usage::UsageProjection::new(Arc::clone(&self.client))
    }

    pub async fn invalidate_control(&self) {
        self.client.close_control_connection().await;
    }
}
