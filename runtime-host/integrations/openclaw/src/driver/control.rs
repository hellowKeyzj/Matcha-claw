use std::sync::Arc;

use foundation::process::supervision::SupervisorPhase;
use serde_json::{Value, json};
use tokio::sync::{Mutex, watch};

use crate::{
    driver::OpenClawDriver,
    gateway::control::{
        project_control_readiness, project_gateway_snapshot, unavailable_control_readiness,
        unavailable_gateway_snapshot,
    },
    port::{OpenClawControlReadiness, OpenClawGateway},
};

pub struct OpenClawLogEntry {
    pub source: &'static str,
    pub line: String,
}

pub struct OpenClawLogSnapshot {
    pub entries: Vec<OpenClawLogEntry>,
    pub cursor: u64,
    pub reset: bool,
    pub truncated: bool,
    pub lifecycle_tail_evicted: bool,
}

pub const INVALID_LOG_CURSOR_MESSAGE: &str = "Invalid log cursor.";

pub struct InvalidLogCursor;

pub fn decode_log_cursor(input: Value) -> Result<Option<u64>, InvalidLogCursor> {
    match input.get("cursor") {
        None => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or(InvalidLogCursor),
    }
}

pub fn project_logs(logs: OpenClawLogSnapshot) -> Value {
    let entries = logs
        .entries
        .into_iter()
        .map(|entry| json!({ "source": entry.source, "line": entry.line }))
        .collect::<Vec<_>>();
    json!({
        "result": {
            "entries": entries,
            "cursor": logs.cursor,
            "reset": logs.reset,
            "truncated": logs.truncated,
            "lifecycleTailEvicted": logs.lifecycle_tail_evicted,
        }
    })
}

impl OpenClawDriver {
    pub async fn logs(&self, cursor: Option<u64>) -> Result<OpenClawLogSnapshot, ()> {
        let logs = runtime_directory::RuntimeControlOps::logs(self, cursor)
            .await
            .map_err(|_| ())?;
        Ok(OpenClawLogSnapshot {
            entries: logs
                .entries
                .into_iter()
                .map(|entry| OpenClawLogEntry {
                    source: entry.source,
                    line: entry.line,
                })
                .collect(),
            cursor: logs.cursor,
            reset: logs.reset,
            truncated: logs.truncated,
            lifecycle_tail_evicted: logs.lifecycle_tail_evicted,
        })
    }

    pub async fn browser_request(
        &self,
        request: crate::gateway::request::OpenClawBrowserGatewayRequest,
    ) -> crate::port::OpenClawGatewayRequestOutcome {
        self.gateway.lock().await.browser_request(request).await
    }

    pub async fn mcp_app_request(
        &self,
        request: crate::gateway::request::OpenClawMcpAppGatewayRequest,
    ) -> crate::port::OpenClawGatewayRequestOutcome {
        self.gateway.lock().await.mcp_app_request(request).await
    }

    pub async fn question_list(
        &self,
        request: crate::gateway::request::OpenClawQuestionListGatewayRequest,
    ) -> crate::port::OpenClawGatewayRequestOutcome {
        self.gateway.lock().await.question_list(request).await
    }

    pub async fn question_resolve(
        &self,
        request: crate::gateway::request::OpenClawQuestionResolveGatewayRequest,
    ) -> crate::port::OpenClawGatewayRequestOutcome {
        self.gateway.lock().await.question_resolve(request).await
    }

    pub fn control_lease(&self) -> ControlLease {
        match self.owner().lease() {
            Some(lease) => ControlLease::probe(Arc::clone(&self.gateway), lease),
            None => ControlLease::unavailable(),
        }
    }

    pub fn gateway_health_observation(&self, probe: bool) -> OpenClawGatewayHealthObservation {
        OpenClawGatewayHealthObservation {
            gateway: Arc::clone(&self.gateway),
            probe,
        }
    }

    pub fn gateway_status_observation(
        &self,
        include_channel_summary: bool,
    ) -> OpenClawGatewayStatusObservation {
        OpenClawGatewayStatusObservation {
            gateway: Arc::clone(&self.gateway),
            include_channel_summary,
        }
    }

    pub fn control_snapshot_observation(&self) -> OpenClawControlSnapshotObservation {
        let lease = match self.owner_if_present() {
            Some(owner) => match owner.snapshot().phase() {
                SupervisorPhase::Starting | SupervisorPhase::Running => self.control_lease(),
                _ => ControlLease::unavailable(),
            },
            None => ControlLease::unavailable(),
        };
        OpenClawControlSnapshotObservation { lease }
    }

    pub fn gateway_snapshot_observation(&self) -> OpenClawGatewaySnapshotObservation {
        OpenClawGatewaySnapshotObservation {
            health: self.gateway_health_observation(false),
            status: self.gateway_status_observation(true),
        }
    }

    pub fn control_readiness(&self) -> watch::Receiver<u64> {
        self.control_readiness.clone()
    }

    pub fn control_ui_url(&self) -> String {
        self.control_ui_url.as_str().to_owned()
    }
}

pub struct OpenClawControlSnapshotObservation {
    lease: ControlLease,
}

impl OpenClawControlSnapshotObservation {
    pub async fn observe(self) -> Value {
        project_control_readiness(self.lease.snapshot_control().await)
    }

    pub fn unavailable() -> Value {
        unavailable_control_readiness()
    }
}

pub struct OpenClawGatewaySnapshotObservation {
    health: OpenClawGatewayHealthObservation,
    status: OpenClawGatewayStatusObservation,
}

impl OpenClawGatewaySnapshotObservation {
    pub async fn observe(self) -> Value {
        let health = match self.health.observe().await {
            Ok(health) => health,
            Err(_) => return unavailable_gateway_snapshot(),
        };
        let status = self.status.observe().await.ok();
        project_gateway_snapshot(health, status)
    }

    pub fn unavailable() -> Value {
        unavailable_gateway_snapshot()
    }
}

pub struct OpenClawGatewayHealthObservation {
    gateway: Arc<Mutex<OpenClawGateway>>,
    probe: bool,
}

impl OpenClawGatewayHealthObservation {
    pub async fn observe(
        self,
    ) -> Result<
        crate::gateway::wire::GatewayHealthSnapshot,
        crate::gateway::client::GatewayClientError,
    > {
        self.gateway.lock().await.observe_health(self.probe).await
    }
}

pub struct OpenClawGatewayStatusObservation {
    gateway: Arc<Mutex<OpenClawGateway>>,
    include_channel_summary: bool,
}

impl OpenClawGatewayStatusObservation {
    pub async fn observe(
        self,
    ) -> Result<
        crate::gateway::wire::GatewayStatusSnapshot,
        crate::gateway::client::GatewayClientError,
    > {
        self.gateway
            .lock()
            .await
            .observe_status(self.include_channel_summary)
            .await
    }
}

pub struct ControlLease(ControlLeaseInner);

enum ControlLeaseInner {
    Unavailable,
    Probe {
        gateway: Arc<Mutex<OpenClawGateway>>,
        lease: foundation::process::supervision::SupervisorLease,
    },
}

impl ControlLease {
    pub const fn unavailable() -> Self {
        Self(ControlLeaseInner::Unavailable)
    }

    pub fn probe(
        gateway: Arc<Mutex<OpenClawGateway>>,
        lease: foundation::process::supervision::SupervisorLease,
    ) -> Self {
        Self(ControlLeaseInner::Probe { gateway, lease })
    }

    #[cfg(test)]
    pub async fn observe_control(self) -> OpenClawControlReadiness {
        match self.0 {
            ControlLeaseInner::Unavailable => OpenClawControlReadiness::Unavailable,
            ControlLeaseInner::Probe { lease, .. } if lease.is_cancelled() => {
                OpenClawControlReadiness::Unavailable
            }
            ControlLeaseInner::Probe { gateway, lease } => {
                let readiness = gateway.lock().await.control_readiness_snapshot().await;
                if lease.is_cancelled() {
                    gateway.lock().await.invalidate_control().await;
                    OpenClawControlReadiness::Unavailable
                } else {
                    readiness
                }
            }
        }
    }

    pub async fn snapshot_control(&self) -> OpenClawControlReadiness {
        match &self.0 {
            ControlLeaseInner::Unavailable => OpenClawControlReadiness::Unavailable,
            ControlLeaseInner::Probe { lease, .. } if lease.is_cancelled() => {
                OpenClawControlReadiness::Unavailable
            }
            ControlLeaseInner::Probe { gateway, .. } => {
                gateway.lock().await.control_readiness_snapshot().await
            }
        }
    }
}
