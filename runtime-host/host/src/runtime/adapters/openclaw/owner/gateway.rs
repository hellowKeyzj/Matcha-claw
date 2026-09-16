use super::super::*;

pub(crate) struct OpenClawLogEntry {
    pub(crate) source: &'static str,
    pub(crate) line: String,
}

pub(crate) struct OpenClawLogSnapshot {
    pub(crate) entries: Vec<OpenClawLogEntry>,
    pub(crate) cursor: u64,
    pub(crate) reset: bool,
    pub(crate) truncated: bool,
    pub(crate) lifecycle_tail_evicted: bool,
}

pub(crate) struct OpenClawGatewayPayload(Value);

impl OpenClawGatewayPayload {
    pub(crate) fn into_value(self) -> Value {
        self.0
    }
}

impl From<Value> for OpenClawGatewayPayload {
    fn from(value: Value) -> Self {
        Self(value)
    }
}

pub(crate) struct OpenClawBrowserGatewayRequest {
    method: String,
    path: String,
    query: Option<OpenClawGatewayPayload>,
    body: Option<OpenClawGatewayPayload>,
    timeout_ms: Option<u64>,
    target: Option<String>,
    node: Option<String>,
}

impl OpenClawBrowserGatewayRequest {
    pub(crate) fn new<Q, B>(
        method: String,
        path: String,
        query: Option<Q>,
        body: Option<B>,
        timeout_ms: Option<u64>,
        target: Option<String>,
        node: Option<String>,
    ) -> Self
    where
        Q: Into<OpenClawGatewayPayload>,
        B: Into<OpenClawGatewayPayload>,
    {
        Self {
            method,
            path,
            query: query.map(Into::into),
            body: body.map(Into::into),
            timeout_ms,
            target,
            node,
        }
    }
}

pub(crate) struct OpenClawMcpAppGatewayRequest {
    operation_id: String,
    session_key: String,
    view_id: String,
    standalone: Option<bool>,
}

impl OpenClawMcpAppGatewayRequest {
    pub(crate) fn new(
        operation_id: String,
        session_key: String,
        view_id: String,
        standalone: Option<bool>,
    ) -> Self {
        Self {
            operation_id,
            session_key,
            view_id,
            standalone,
        }
    }
}

impl OpenClawInstance {
    pub(crate) async fn logs(&self, cursor: Option<u64>) -> Result<OpenClawLogSnapshot, ()> {
        let lifecycle = self.lifecycle_logs.snapshot_with_coverage();
        let gateway = self
            .gateway
            .lock()
            .await
            .tail_logs(cursor, 500, 250_000)
            .await
            .map_err(|_| ())?;
        let mut seen = HashSet::with_capacity(lifecycle.entries.len() + gateway.lines.len());
        let mut entries = Vec::with_capacity(lifecycle.entries.len() + gateway.lines.len());
        for entry in lifecycle.entries {
            let source = match entry.stream() {
                openclaw::lifecycle::logs::LogStream::Stdout => "stdout",
                openclaw::lifecycle::logs::LogStream::Stderr => "stderr",
            };
            let line = sanitize_log_line(entry.line().as_bytes());
            if seen.insert((source, line.clone())) {
                entries.push(OpenClawLogEntry { source, line });
            }
        }
        for line in gateway.lines {
            let line = sanitize_log_line(line.as_bytes());
            if !line.is_empty() && seen.insert(("gateway", line.clone())) {
                entries.push(OpenClawLogEntry {
                    source: "gateway",
                    line,
                });
            }
        }
        Ok(OpenClawLogSnapshot {
            entries,
            cursor: gateway.cursor,
            reset: gateway.reset,
            truncated: gateway.truncated,
            lifecycle_tail_evicted: lifecycle.tail_evicted,
        })
    }

    pub(crate) async fn browser_request(
        &self,
        request: OpenClawBrowserGatewayRequest,
    ) -> openclaw::port::OpenClawGatewayRequestOutcome {
        self.gateway
            .lock()
            .await
            .browser_request(
                request.method,
                request.path,
                request.query.map(OpenClawGatewayPayload::into_value),
                request.body.map(OpenClawGatewayPayload::into_value),
                request.timeout_ms,
                request.target,
                request.node,
            )
            .await
    }

    pub(crate) async fn mcp_app_request(
        &self,
        request: OpenClawMcpAppGatewayRequest,
    ) -> openclaw::port::OpenClawGatewayRequestOutcome {
        self.gateway
            .lock()
            .await
            .mcp_app_request(
                request.operation_id,
                request.session_key,
                request.view_id,
                request.standalone,
            )
            .await
    }

    pub(crate) async fn platform_tools(&self) -> crate::toolchain::platform_tools::Outcome {
        crate::toolchain::platform_tools::catalog(
            self.gateway.lock().await.platform_tools_catalog().await,
        )
    }

    pub(crate) fn control_lease(&self) -> ControlLease {
        match self.owner().lease() {
            Some(lease) => ControlLease::probe(Arc::clone(&self.gateway), lease),
            None => ControlLease::unavailable(),
        }
    }

    pub(crate) fn gateway_health_observation(
        &self,
        probe: bool,
    ) -> OpenClawGatewayHealthObservation {
        OpenClawGatewayHealthObservation {
            gateway: Arc::clone(&self.gateway),
            probe,
        }
    }

    pub(crate) fn gateway_status_observation(
        &self,
        include_channel_summary: bool,
    ) -> OpenClawGatewayStatusObservation {
        OpenClawGatewayStatusObservation {
            gateway: Arc::clone(&self.gateway),
            include_channel_summary,
        }
    }

    pub(crate) fn control_readiness(&self) -> watch::Receiver<u64> {
        self.control_readiness.clone()
    }

    pub(crate) fn control_ui_url(&self) -> String {
        safe_control_ui_url(self.control_ui_url.as_str())
    }
}

fn safe_control_ui_url(url: &str) -> String {
    url.split_once('#').map_or(url, |(base, _)| base).to_owned()
}

pub(crate) struct OpenClawGatewayHealthObservation {
    gateway: Arc<Mutex<OpenClawGateway>>,
    probe: bool,
}

impl OpenClawGatewayHealthObservation {
    pub(crate) async fn observe(
        self,
    ) -> Result<
        openclaw::gateway::wire::GatewayHealthSnapshot,
        openclaw::gateway::client::GatewayClientError,
    > {
        self.gateway.lock().await.observe_health(self.probe).await
    }
}

pub(crate) struct OpenClawGatewayStatusObservation {
    gateway: Arc<Mutex<OpenClawGateway>>,
    include_channel_summary: bool,
}

impl OpenClawGatewayStatusObservation {
    pub(crate) async fn observe(
        self,
    ) -> Result<
        openclaw::gateway::wire::GatewayStatusSnapshot,
        openclaw::gateway::client::GatewayClientError,
    > {
        self.gateway
            .lock()
            .await
            .observe_status(self.include_channel_summary)
            .await
    }
}

pub(crate) struct ControlLease(ControlLeaseInner);

enum ControlLeaseInner {
    Unavailable,
    Probe {
        gateway: Arc<Mutex<OpenClawGateway>>,
        lease: foundation::process::supervision::SupervisorLease,
    },
}

impl ControlLease {
    pub(crate) const fn unavailable() -> Self {
        Self(ControlLeaseInner::Unavailable)
    }

    pub(crate) fn probe(
        gateway: Arc<Mutex<OpenClawGateway>>,
        lease: foundation::process::supervision::SupervisorLease,
    ) -> Self {
        Self(ControlLeaseInner::Probe { gateway, lease })
    }

    #[cfg(test)]
    pub(crate) async fn observe_control(self) -> OpenClawControlReadiness {
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

    pub(crate) async fn snapshot_control(&self) -> OpenClawControlReadiness {
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
