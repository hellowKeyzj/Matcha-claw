use std::{collections::HashSet, sync::Arc};

use foundation::process::supervision::SupervisorPhase;
use runtime_directory::{
    OwnedRuntimeFuture, RuntimeControlFailure, RuntimeControlOps, RuntimeControlReadiness,
    RuntimeGatewayHealth, RuntimeGatewayStatus, RuntimeLogEntry, RuntimeLogSnapshot,
};

use crate::{
    driver::{OpenClawDriver, control::ControlLease},
    lifecycle::logs::sanitize_log_line,
};

impl RuntimeControlOps for OpenClawDriver {
    fn logs(
        &self,
        cursor: Option<u64>,
    ) -> OwnedRuntimeFuture<Result<RuntimeLogSnapshot, RuntimeControlFailure>> {
        let lifecycle_logs = self.lifecycle_logs.clone();
        let gateway = Arc::clone(&self.gateway);
        let running = self.supervisor_handle().snapshot().phase() == SupervisorPhase::Running;
        Box::pin(async move {
            let lifecycle = lifecycle_logs.snapshot_with_coverage();
            let gateway = if running {
                Some(
                    gateway
                        .lock()
                        .await
                        .tail_logs(cursor, 500, 250_000)
                        .await
                        .map_err(|_| RuntimeControlFailure::Unavailable)?,
                )
            } else {
                None
            };
            let capacity =
                lifecycle.entries.len() + gateway.as_ref().map_or(0, |tail| tail.lines.len());
            let mut seen = HashSet::with_capacity(capacity);
            let mut entries = Vec::with_capacity(capacity);
            for entry in lifecycle.entries {
                let source = match entry.stream() {
                    crate::lifecycle::logs::LogStream::Stdout => "stdout",
                    crate::lifecycle::logs::LogStream::Stderr => "stderr",
                };
                let line = sanitize_log_line(entry.line().as_bytes());
                if seen.insert((source, line.clone())) {
                    entries.push(RuntimeLogEntry { source, line });
                }
            }
            let (cursor, reset, truncated) = match gateway {
                Some(gateway) => {
                    for line in gateway.lines {
                        let line = sanitize_log_line(line.as_bytes());
                        if !line.is_empty() && seen.insert(("gateway", line.clone())) {
                            entries.push(RuntimeLogEntry {
                                source: "gateway",
                                line,
                            });
                        }
                    }
                    (gateway.cursor, gateway.reset, gateway.truncated)
                }
                None => (cursor.unwrap_or(0), false, false),
            };
            Ok(RuntimeLogSnapshot {
                entries,
                cursor,
                reset,
                truncated,
                lifecycle_tail_evicted: lifecycle.tail_evicted,
            })
        })
    }

    fn control_readiness(
        &self,
    ) -> OwnedRuntimeFuture<Result<RuntimeControlReadiness, RuntimeControlFailure>> {
        let lease = match self.supervisor_handle().snapshot().phase() {
            SupervisorPhase::Starting | SupervisorPhase::Running => self.control_lease(),
            _ => ControlLease::unavailable(),
        };
        Box::pin(async move { Ok(runtime_control_readiness(lease.snapshot_control().await)) })
    }

    fn gateway_health(
        &self,
        probe: bool,
    ) -> OwnedRuntimeFuture<Result<RuntimeGatewayHealth, RuntimeControlFailure>> {
        let observation = self.gateway_health_observation(probe);
        Box::pin(async move {
            observation
                .observe()
                .await
                .map(runtime_gateway_health)
                .map_err(|_| RuntimeControlFailure::Unavailable)
        })
    }

    fn gateway_status(
        &self,
        include_channel_summary: bool,
    ) -> OwnedRuntimeFuture<Result<RuntimeGatewayStatus, RuntimeControlFailure>> {
        let observation = self.gateway_status_observation(include_channel_summary);
        Box::pin(async move {
            observation
                .observe()
                .await
                .map(runtime_gateway_status)
                .map_err(|_| RuntimeControlFailure::Unavailable)
        })
    }

    fn control_ui_url(&self) -> OwnedRuntimeFuture<Result<String, RuntimeControlFailure>> {
        let url = self.control_ui_url();
        Box::pin(async move { Ok(url) })
    }
}

const fn runtime_control_readiness(
    readiness: crate::port::OpenClawControlReadiness,
) -> RuntimeControlReadiness {
    match readiness {
        crate::port::OpenClawControlReadiness::Ready => RuntimeControlReadiness::Ready,
        crate::port::OpenClawControlReadiness::Starting => RuntimeControlReadiness::Starting,
        crate::port::OpenClawControlReadiness::Unavailable => RuntimeControlReadiness::Unavailable,
    }
}

fn runtime_gateway_health(
    health: crate::gateway::wire::GatewayHealthSnapshot,
) -> RuntimeGatewayHealth {
    RuntimeGatewayHealth {
        ok: health.ok,
        timestamp_ms: health.timestamp_ms,
        duration_ms: health.duration_ms,
        channel_count: health.channel_count,
        agent_count: health.agent_count,
        session_count: health.session_count,
    }
}

fn runtime_gateway_status(
    status: crate::gateway::wire::GatewayStatusSnapshot,
) -> RuntimeGatewayStatus {
    RuntimeGatewayStatus {
        session_count: status.session_count,
        channel_count: status.channel_count,
        heartbeat_enabled: status.heartbeat_enabled,
    }
}
