use std::sync::Arc;

use maintenance::{Maintenance, MaintenanceAction, MaintenancePort};
use platform::{
    call::{CallId, CallLogError},
    mcp::{ToolCallError, ToolCallFuture, ToolCallOutcome},
};
use runtime_directory::{
    RuntimeControlLifecycleError, RuntimeControlReadiness, RuntimeDriverIdentity,
    call::RuntimeControlCallDetail, control_loopback::RuntimeControlLifecyclePort,
};
use serde_json::{Value, json};

use crate::composition::{HostAdmission, HostHandles, PeerHandle};

pub(crate) fn from_handles(handles: &HostHandles) -> Maintenance {
    Maintenance::new(Arc::new(HostMaintenance {
        admission: Arc::clone(&handles.admission),
        peer: handles.peer.clone(),
        driver: Arc::clone(&handles.open_claw),
        calls: handles.calls.clone(),
    }))
}

struct HostMaintenance {
    admission: Arc<HostAdmission>,
    peer: PeerHandle,
    driver: Arc<openclaw::driver::OpenClawDriver>,
    calls: call_log::CallLogModule,
}

impl MaintenancePort for HostMaintenance {
    fn execute(&self, action: MaintenanceAction) -> ToolCallFuture<'_> {
        Box::pin(async move {
            self.admission.admit_request().map_err(|_| unavailable())?;
            match action {
                MaintenanceAction::Status { call_id } => self.status(call_id).await,
                MaintenanceAction::Logs { cursor } => self.logs(cursor).await,
                MaintenanceAction::Inspect => {
                    Ok(openclaw::maintenance::inspect(&self.driver).await)
                }
                MaintenanceAction::Start
                | MaintenanceAction::Restart
                | MaintenanceAction::Repair => self.mutate(action).await,
            }
        })
    }
}

impl HostMaintenance {
    async fn status(&self, call_id: Option<CallId>) -> ToolCallOutcome {
        let endpoint = RuntimeDriverIdentity::open_claw().endpoint();
        let (lifecycle, control, repair, operation) = tokio::join!(
            self.peer.lifecycle_status(endpoint.clone()),
            self.peer.runtime_control_readiness(endpoint.clone()),
            self.peer.repair_status(endpoint),
            self.operation(call_id),
        );
        Ok(json!({
            "runtimeAdapterId": "openclaw",
            "lifecycle": match lifecycle {
                Ok(status) => json!({"availability":"available", "state":status}),
                Err(error) => json!({"availability":"unavailable", "reason":error}),
            },
            "control": match control {
                Ok(Ok(ready)) => json!({"availability":"available", "phase":match ready {
                    RuntimeControlReadiness::Ready => "ready",
                    RuntimeControlReadiness::Starting => "starting",
                    RuntimeControlReadiness::Unavailable => "unavailable",
                }}),
                _ => json!({"availability":"unavailable"}),
            },
            "repair": match repair {
                Ok(snapshot) => json!({"availability":"available", "state":snapshot}),
                Err(error) => json!({"availability":"unavailable", "reason":error}),
            },
            "operation": operation,
        }))
    }

    async fn operation(&self, call_id: Option<CallId>) -> Value {
        let Some(call_id) = call_id else {
            return Value::Null;
        };
        match self.calls.get(call_id).await {
            Ok(record) => {
                let detail = match serde_json::to_value(&record.detail) {
                    Ok(detail) => detail,
                    Err(_) => return json!({"availability":"unavailable"}),
                };
                if record.module != "runtime-control"
                    || !matches!(
                        record.command.as_str(),
                        "lifecycle.start" | "lifecycle.restart" | "lifecycle.repair"
                    )
                    || detail.get("endpoint")
                        != Some(&json!(RuntimeDriverIdentity::open_claw().endpoint()))
                {
                    return json!({"availability":"notFound"});
                }
                json!({"availability":"available", "call":record})
            }
            Err(CallLogError::NotFound) => json!({"availability":"notFound"}),
            Err(_) => json!({"availability":"unavailable"}),
        }
    }

    async fn logs(&self, cursor: Option<u64>) -> ToolCallOutcome {
        let snapshot = self
            .peer
            .runtime_logs(RuntimeDriverIdentity::open_claw().endpoint(), cursor)
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        Ok(json!({
            "entries": snapshot.entries.into_iter().map(|entry| json!({
                "source":entry.source, "line":entry.line,
            })).collect::<Vec<_>>(),
            "cursor": snapshot.cursor,
            "reset": snapshot.reset,
            "truncated": snapshot.truncated,
            "lifecycleTailEvicted": snapshot.lifecycle_tail_evicted,
        }))
    }

    async fn mutate(&self, action: MaintenanceAction) -> ToolCallOutcome {
        let endpoint = RuntimeDriverIdentity::open_claw().endpoint();
        let command = match action {
            MaintenanceAction::Start => "lifecycle.start",
            MaintenanceAction::Restart => "lifecycle.restart",
            MaintenanceAction::Repair => "lifecycle.repair",
            _ => return Err(ToolCallError::InvalidParams),
        };
        let call = self
            .calls
            .recorder()
            .begin(command, &RuntimeControlCallDetail::new(&endpoint))
            .await
            .map_err(|_| unavailable())?;
        let call_id = call.id().clone();
        let result = match action {
            MaintenanceAction::Start => self.peer.admit_lifecycle_start(endpoint, call).await,
            MaintenanceAction::Restart => self.peer.admit_lifecycle_restart(endpoint, call).await,
            MaintenanceAction::Repair => self.peer.admit_lifecycle_repair(endpoint, call).await,
            _ => unreachable!("only lifecycle actions are admitted"),
        };
        match result {
            Ok(receipt) => Ok(json!({"outcome":"accepted", "receipt":receipt})),
            Err(error) => Err(ToolCallError::Execution(json!({
                "outcome": match error {
                    RuntimeControlLifecycleError::Busy => "busy",
                    RuntimeControlLifecycleError::Unsupported => "unsupported",
                    RuntimeControlLifecycleError::Unavailable => "unavailable",
                    RuntimeControlLifecycleError::CommandFailed => "unknown",
                },
                "callId":call_id,
            }))),
        }
    }
}

fn unavailable() -> ToolCallError {
    ToolCallError::Execution(json!({"outcome":"unavailable"}))
}
